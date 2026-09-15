import type pg from 'pg';
import {assertAudience,type Reader} from './access.js';
import {canonical,digest} from './archive.js';
import {guardState,replaceValues,textValues} from './guarded.js';
import {literalSpans,mask,patternSpans,DETECTOR_VERSION} from './guard.js';
import {HttpError} from './http.js';

export const contextSchema=`CREATE TABLE IF NOT EXISTS guard_context_values (
 id text PRIMARY KEY,audience text NOT NULL,epoch bigint NOT NULL,content bytea NOT NULL);
CREATE INDEX IF NOT EXISTS guard_context_audience ON guard_context_values(audience,epoch);
CREATE TABLE IF NOT EXISTS guard_context_inputs (
 id text PRIMARY KEY,audience text NOT NULL,epoch bigint NOT NULL,source_id text NOT NULL REFERENCES guard_sources(id));`;
export const contextAudience=(p:Reader)=>p.scope===null?'owner':`${p.space??p.scope}:policy:${p.revision??0}`;
function leaves(value:unknown):string[] {
  if(typeof value==='string')return value?[value]:[];
  if(Array.isArray(value))return value.flatMap(leaves);
  return value&&typeof value==='object'?Object.values(value).flatMap(leaves):[];
}
export async function allowPrepared(pool:pg.Pool,principal:Reader,value:unknown) {
  if(principal.admin)return;
  await assertAudience(pool,principal);const state=await guardState(pool);if(state.mode==='off')return;
  const scope=contextAudience(principal);
  const values=[...new Set(leaves(value).flatMap(text=>[text,JSON.stringify(text).slice(1,-1)]))];
  for(let offset=0;offset<values.length;offset+=500) {
    const batch=values.slice(offset,offset+500);
    await pool.query(`INSERT INTO guard_context_values(id,audience,epoch,content)
      SELECT id,$2,$3,content FROM unnest($1::text[],$4::bytea[]) AS prepared(id,content) ON CONFLICT DO NOTHING`,
      [batch.map(text=>digest(canonical({scope,epoch:state.epoch,text}))),scope,state.epoch,batch.map(text=>Buffer.from(text))]);
  }
}

// Preserve complete prepared passages inside native formatting. Word boundaries
// prevent a short prepared value from splitting a different identifier/secret.
export function segments(text:string,known:readonly string[]):{text:string;prepared:boolean}[] {
  const spans:{start:number;end:number}[]=[];
  for(const value of known) {
    if(!value||value.length>text.length)continue;
    for(let start=text.indexOf(value);start>=0;start=text.indexOf(value,start+value.length)) {
      const end=start+value.length,word=(v:string|undefined)=>v!==undefined&&/[\p{L}\p{N}_]/u.test(v);
      if((word(value[0])&&word(text[start-1]))||(word(value.at(-1))&&word(text[end])))continue;
      spans.push({start,end});
    }
  }
  spans.sort((a,b)=>a.start-b.start||b.end-a.end);
  const result:{text:string;prepared:boolean}[]=[];let at=0;
  for(const span of spans){if(span.start<at)continue;if(span.start>at)result.push({text:text.slice(at,span.start),prepared:false});result.push({text:text.slice(span.start,span.end),prepared:true});at=span.end;}
  if(at<text.length)result.push({text:text.slice(at),prepared:false});
  return result;
}

export async function prepareContext(pool:pg.Pool,principal:Reader,value:unknown,detect:(text:string)=>Promise<unknown>):Promise<unknown> {
  await assertAudience(pool,principal);const state=await guardState(pool);if(state.mode==='off')return value;
  if(!principal.turnEvent)throw new HttpError(403,'bound_guard_context_required');
  const scope=contextAudience(principal),client=await pool.connect();
  try {
    // A per-audience lock deduplicates concurrent preparation, including native
    // auxiliary calls. No unrelated audience's prepared content is reusable.
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,803309))',[scope]);
    const known=(await client.query('SELECT content FROM guard_context_values WHERE audience=$1 AND epoch=$2',[scope,state.epoch])).rows.map(r=>r.content.toString() as string);
    const knownSet=new Set(known);
    const replacements=new Map<string,string>(),plans=new Map<string,{text:string;prepared:boolean}[]>();
    const fresh=new Map<string,string>(),outputs=new Map<string,string>();
    for(const original of new Set(textValues(value))) {
      if(!original||knownSet.has(original)){replacements.set(original,original);continue;}
      const parts=segments(original,known).flatMap(part=>{
        if(part.prepared||part.text.length<=24000)return [part];
        const chunks=[];let offset=0;
        while(offset<part.text.length){let end=Math.min(offset+24000,part.text.length);if(end<part.text.length&&/[\uD800-\uDBFF]/.test(part.text[end-1]!))end--;chunks.push({text:part.text.slice(offset,end),prepared:false});offset=end;}return chunks;
      });
      plans.set(original,parts);
      for(const part of parts) {
        if(part.prepared||!part.text.trim()||outputs.has(part.text)||fresh.has(part.text))continue;
        const key=digest(canonical({scope,epoch:state.epoch,input:part.text}));
        fresh.set(part.text,key);
      }
    }
    const candidates=[...fresh.entries()];
    for(let offset=0;offset<candidates.length;offset+=500) {
      const cached=await client.query(`SELECT c.id,r.content FROM guard_context_inputs c JOIN guard_sources s ON s.id=c.source_id
        JOIN guard_revisions r ON r.source_id=s.id AND r.revision=s.active_revision WHERE c.id=ANY($1::text[])`,
        [candidates.slice(offset,offset+500).map(([,key])=>key)]);
      const byId=new Map(cached.rows.map(row=>[row.id,JSON.parse(row.content.toString()).text as string]));
      for(const [text,key] of candidates.slice(offset,offset+500))if(byId.has(key)){outputs.set(text,byId.get(key)!);fresh.delete(text);}
    }
    const pending=[...fresh.entries()];
    while(pending.length) {
      const batch:[string,string][]=[];let length=0;
      while(pending.length&&length+pending[0]![0].length+32<=50000){const item=pending.shift()!;batch.push(item);length+=item[0].length+32;}
      const joined=batch.map(([text])=>text).join('\n<NOCHEH_FRAGMENT>\n'),literals=await detect(joined);
      literalSpans(joined,literals);
      if(!(literals as string[]).every(value=>batch.some(([text])=>text.includes(value))))throw new HttpError(422,'guard_candidate_rejected');
      const provenance={event_id:principal.turnEvent,audience:scope,guard_epoch:state.epoch};
      const records=batch.map(([text,key])=>{
        const guarded=mask(text,[...literalSpans(text,(literals as string[]).filter(v=>text.includes(v))),...patternSpans(text)]).text;
        const derivedId=digest('guard-context:'+key),sourceId='derived_artifacts:'+derivedId;
        const input={text,kind:'runtime_context',provenance};
        return {text,key,guarded,derivedId,sourceId,input,hash:digest(canonical(input)),result:{...input,text:guarded}};
      });
      // One atomic persistence batch per bounded detector call. Every fragment
      // retains its own source identity, original, revision and cache entry.
      await client.query('BEGIN');
      await client.query(`INSERT INTO derived_artifacts(id,event_id,kind,content,search_text,provenance)
        SELECT id,$1,'runtime_context',content,search_text,$2::jsonb
        FROM unnest($3::text[],$4::bytea[],$5::text[]) AS batch(id,content,search_text) ON CONFLICT DO NOTHING`,
        [principal.turnEvent,JSON.stringify(provenance),records.map(r=>r.derivedId),records.map(r=>Buffer.from(r.text)),records.map(r=>r.text.replaceAll('\0',''))]);
      await client.query(`INSERT INTO guard_revisions(id,source_id,revision,content,search_text,input_hash,author,preparation_version)
        SELECT id,source_id,1,content,search_text,input_hash,'automatic',$1
        FROM unnest($2::text[],$3::text[],$4::bytea[],$5::text[],$6::text[]) AS batch(id,source_id,content,search_text,input_hash) ON CONFLICT DO NOTHING`,
        [DETECTOR_VERSION,records.map(r=>digest(r.sourceId+':1')),records.map(r=>r.sourceId),records.map(r=>Buffer.from(canonical(r.result))),records.map(r=>r.guarded.replaceAll('\0','')),records.map(r=>r.hash)]);
      await client.query(`UPDATE guard_sources s SET input=batch.input,input_hash=batch.hash,active_revision=1,state='ready',error_code=NULL
        FROM unnest($1::text[],$2::bytea[],$3::text[]) AS batch(id,input,hash) WHERE s.id=batch.id AND s.active_revision IS NULL`,
        [records.map(r=>r.sourceId),records.map(r=>Buffer.from(canonical(r.input))),records.map(r=>r.hash)]);
      await client.query(`INSERT INTO guard_context_inputs(id,audience,epoch,source_id)
        SELECT id,$1,$2,source_id FROM unnest($3::text[],$4::text[]) AS batch(id,source_id) ON CONFLICT DO NOTHING`,
        [scope,state.epoch,records.map(r=>r.key),records.map(r=>r.sourceId)]);
      await client.query('COMMIT');
      for(const r of records)outputs.set(r.text,r.guarded);
    }
    for(const [original,parts] of plans)replacements.set(original,parts.map(part=>part.prepared||!part.text.trim()?part.text:outputs.get(part.text)!).join(''));
    const prepared=replaceValues(value,replacements);
    await assertAudience(pool,principal);await allowPrepared(pool,principal,prepared);
    return prepared;
  }finally{await client.query('ROLLBACK');await client.query('SELECT pg_advisory_unlock(hashtextextended($1,803309))',[scope]);client.release();}
}

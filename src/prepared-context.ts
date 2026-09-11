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
  for(const text of new Set(leaves(value).flatMap(text=>[text,JSON.stringify(text).slice(1,-1)])))await pool.query('INSERT INTO guard_context_values(id,audience,epoch,content) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [digest(canonical({scope,epoch:state.epoch,text})),scope,state.epoch,Buffer.from(text)]);
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
    const replacements=new Map<string,string>(),plans=new Map<string,{text:string;prepared:boolean}[]>();
    const fresh=new Map<string,string>(),outputs=new Map<string,string>();
    for(const original of new Set(textValues(value))) {
      if(!original||known.includes(original)){replacements.set(original,original);continue;}
      const parts=segments(original,known).flatMap(part=>{
        if(part.prepared||part.text.length<=24000)return [part];
        const chunks=[];let offset=0;
        while(offset<part.text.length){let end=Math.min(offset+24000,part.text.length);if(end<part.text.length&&/[\uD800-\uDBFF]/.test(part.text[end-1]!))end--;chunks.push({text:part.text.slice(offset,end),prepared:false});offset=end;}return chunks;
      });
      plans.set(original,parts);
      for(const part of parts) {
        if(part.prepared||!part.text.trim()||outputs.has(part.text)||fresh.has(part.text))continue;
        const key=digest(canonical({scope,epoch:state.epoch,input:part.text}));
        const cached=(await client.query(`SELECT r.content FROM guard_context_inputs c JOIN guard_sources s ON s.id=c.source_id
          JOIN guard_revisions r ON r.source_id=s.id AND r.revision=s.active_revision WHERE c.id=$1`,[key])).rows[0];
        if(cached)outputs.set(part.text,JSON.parse(cached.content.toString()).text);else fresh.set(part.text,key);
      }
    }
    const pending=[...fresh.entries()];
    while(pending.length) {
      const batch:[string,string][]=[];let length=0;
      while(pending.length&&length+pending[0]![0].length+32<=50000){const item=pending.shift()!;batch.push(item);length+=item[0].length+32;}
      const joined=batch.map(([text])=>text).join('\n<NOCHEH_FRAGMENT>\n'),literals=await detect(joined);
      literalSpans(joined,literals);
      if(!(literals as string[]).every(value=>batch.some(([text])=>text.includes(value))))throw new HttpError(422,'guard_candidate_rejected');
      for(const [text,key] of batch) {
        const guarded=mask(text,[...literalSpans(text,(literals as string[]).filter(v=>text.includes(v))),...patternSpans(text)]).text;
        const derivedId=digest('guard-context:'+key),sourceId='derived_artifacts:'+derivedId;
        const input={text,kind:'runtime_context',provenance:{event_id:principal.turnEvent,audience:scope,guard_epoch:state.epoch}};
        const result={...input,text:guarded},hash=digest(canonical(input));
        await client.query('BEGIN');
        await client.query(`INSERT INTO derived_artifacts(id,event_id,kind,content,search_text,provenance) VALUES($1,$2,'runtime_context',$3,$4,$5) ON CONFLICT DO NOTHING`,
          [derivedId,principal.turnEvent,Buffer.from(text),text.replaceAll('\0',''),JSON.stringify(input.provenance)]);
        await client.query(`INSERT INTO guard_revisions(id,source_id,revision,content,search_text,input_hash,author,preparation_version)
          VALUES($1,$2,1,$3,$4,$5,'automatic',$6) ON CONFLICT DO NOTHING`,[digest(sourceId+':1'),sourceId,Buffer.from(canonical(result)),guarded.replaceAll('\0',''),hash,DETECTOR_VERSION]);
        await client.query("UPDATE guard_sources SET input=$2,input_hash=$3,active_revision=1,state='ready',error_code=NULL WHERE id=$1 AND active_revision IS NULL",[sourceId,Buffer.from(canonical(input)),hash]);
        await client.query('INSERT INTO guard_context_inputs(id,audience,epoch,source_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[key,scope,state.epoch,sourceId]);
        await client.query('COMMIT');outputs.set(text,guarded);
      }
    }
    for(const [original,parts] of plans)replacements.set(original,parts.map(part=>part.prepared||!part.text.trim()?part.text:outputs.get(part.text)!).join(''));
    const prepared=replaceValues(value,replacements);
    await assertAudience(pool,principal);await allowPrepared(pool,principal,prepared);
    return prepared;
  }finally{await client.query('ROLLBACK');await client.query('SELECT pg_advisory_unlock(hashtextextended($1,803309))',[scope]);client.release();}
}

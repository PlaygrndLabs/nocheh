import type pg from 'pg';
import {canonical,digest} from './archive.js';
import {DETECTOR_VERSION,literalSpans,mask,patternSpans} from './guard.js';
import {HttpError,object,string} from './http.js';
import {admin,type Reader} from './access.js';

// The archive is evidence. These independently versioned projections are disposable
// except for owner revisions, which must be retained and never overwritten by jobs.
export const guardedSchema=`
CREATE TABLE IF NOT EXISTS guard_sources (
 id text PRIMARY KEY,event_id text NOT NULL REFERENCES events(id),kind text NOT NULL,
 source_id text NOT NULL,input_hash text,input bytea,active_revision integer,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','failed')),
 attempts integer NOT NULL DEFAULT 0,next_attempt timestamptz NOT NULL DEFAULT now(),error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(kind,source_id));
CREATE TABLE IF NOT EXISTS guard_revisions (
 id text PRIMARY KEY,source_id text NOT NULL REFERENCES guard_sources(id),revision integer NOT NULL,
 content bytea NOT NULL,search_text text NOT NULL,input_hash text NOT NULL,
 author text NOT NULL CHECK(author IN ('automatic','owner')),preparation_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(source_id,revision));
CREATE INDEX IF NOT EXISTS guard_lexical ON guard_revisions USING gin(to_tsvector('simple',search_text));
CREATE TABLE IF NOT EXISTS guard_fragments (
 id text PRIMARY KEY,source_id text NOT NULL REFERENCES guard_sources(id),
 input_hash text NOT NULL,preparation_version text NOT NULL,content bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS guard_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),epoch bigint NOT NULL DEFAULT 1);
ALTER TABLE guard_state ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'off' CHECK(mode IN ('on','off'));
INSERT INTO guard_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS guard_invalidations (
 id bigserial PRIMARY KEY,source_id text NOT NULL REFERENCES guard_sources(id),epoch bigint NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done')),
 created_at timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE FUNCTION nocheh_queue_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id text;
BEGIN
 IF TG_TABLE_NAME='events' THEN parent_id:=NEW.id; ELSE parent_id:=NEW.event_id; END IF;
 INSERT INTO guard_sources(id,event_id,kind,source_id)
 VALUES(TG_TABLE_NAME||':'||NEW.id,parent_id,TG_TABLE_NAME,NEW.id) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS queue_guard ON events;
CREATE TRIGGER queue_guard AFTER INSERT ON events FOR EACH ROW EXECUTE FUNCTION nocheh_queue_guard();
DROP TRIGGER IF EXISTS queue_guard ON derived_artifacts;
CREATE TRIGGER queue_guard AFTER INSERT ON derived_artifacts FOR EACH ROW EXECUTE FUNCTION nocheh_queue_guard();
DROP TRIGGER IF EXISTS queue_guard ON artifacts;
CREATE TRIGGER queue_guard AFTER INSERT ON artifacts FOR EACH ROW EXECUTE FUNCTION nocheh_queue_guard();
INSERT INTO guard_sources(id,event_id,kind,source_id) SELECT 'events:'||id,id,'events',id FROM events ON CONFLICT DO NOTHING;
INSERT INTO guard_sources(id,event_id,kind,source_id) SELECT 'derived_artifacts:'||id,event_id,'derived_artifacts',id FROM derived_artifacts ON CONFLICT DO NOTHING;
INSERT INTO guard_sources(id,event_id,kind,source_id) SELECT 'artifacts:'||id,event_id,'artifacts',id FROM artifacts ON CONFLICT DO NOTHING;
`;

export function textValues(value:unknown):string[] {
  if(typeof value==='string')return [value];
  if(Array.isArray(value))return value.flatMap(textValues);
  if(value!==null && typeof value==='object')return Object.entries(value).flatMap(([k,v])=>[k,...textValues(v)]);
  return [];
}
export function replaceValues(value:unknown,replacements:Map<string,string>):unknown {
  if(typeof value==='string')return replacements.get(value)??value;
  if(Array.isArray(value))return value.map(v=>replaceValues(v,replacements));
  if(value!==null && typeof value==='object') {
    const out:Record<string,unknown>=Object.create(null);
    for(const [key,item] of Object.entries(value)) {
      const changed=replacements.get(key)??key;
      if(Object.hasOwn(out,changed))throw new HttpError(422,'guarded_key_collision');
      out[changed]=replaceValues(item,replacements);
    }
    return out;
  }
  return value;
}

async function sourceInput(client:pg.PoolClient,source:{kind:string;source_id:string}) {
  if(source.kind==='events') {
    const {rows}=await client.query('SELECT original_text,payload FROM events WHERE id=$1',[source.source_id]);
    return {text:rows[0].original_text?.toString()??null,payload:JSON.parse(rows[0].payload.toString())};
  }
  if(source.kind==='artifacts') {
    const {rows}=await client.query('SELECT kind,metadata FROM artifacts WHERE id=$1',[source.source_id]);
    return rows[0];
  }
  const {rows}=await client.query('SELECT content,kind,provenance FROM derived_artifacts WHERE id=$1',[source.source_id]);
  const row=rows[0];
  let text:string;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(row.content);}catch{throw new HttpError(422,'guard_unsupported_binary');}
  return {text,kind:row.kind,provenance:row.provenance};
}

// Persist each successful bounded fragment before continuing. A failed later
// fragment or a worker restart does not repeat the completed detector work.
async function prepareValue(client:pg.PoolClient,id:string,input:unknown,version:string,detect:(text:string)=>Promise<unknown>) {
  const pieces=new Map<string,string[]>(),prepared=new Map<string,string>();
  const pending=new Set<string>();
  for(const value of new Set(textValues(input))) {
    const parts:string[]=[];
    for(let offset=0;offset<value.length;) {
      let end=Math.min(value.length,offset+24000);
      if(end<value.length && /[\uD800-\uDBFF]/.test(value[end-1]!))end--;
      const fragment=value.slice(offset,end);parts.push(fragment);pending.add(fragment);offset=end;
    }
    pieces.set(value,parts);
  }
  const key=(fragment:string)=>digest(canonical({id,version,hash:digest(fragment)}));
  for(const fragment of pending) {
    const saved=await client.query('SELECT content FROM guard_fragments WHERE id=$1',[key(fragment)]);
    if(saved.rows[0]){prepared.set(fragment,saved.rows[0].content.toString());pending.delete(fragment);}
  }
  const missing=[...pending];
  while(missing.length) {
    const batch:string[]=[];let length=0;
    while(missing.length && length+missing[0]!.length<50000){const part=missing.shift()!;batch.push(part);length+=part.length+32;}
    const literals=await detect(batch.join('\n⟪NOCHEH_FIELD_BOUNDARY⟫\n'));
    if(!Array.isArray(literals)||literals.length>1000||literals.some(v=>typeof v!=='string'||!v||!batch.some(text=>text.includes(v))))throw new HttpError(503,'detector_contract_rejected');
    await client.query('BEGIN');
    try {
      for(const fragment of batch) {
        const guarded=mask(fragment,[...literalSpans(fragment,literals.filter(v=>fragment.includes(v))),...patternSpans(fragment)]).text;
        await client.query('INSERT INTO guard_fragments(id,source_id,input_hash,preparation_version,content) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[key(fragment),id,digest(fragment),version,Buffer.from(guarded)]);
        prepared.set(fragment,guarded);
      }
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}
  }
  const replacements=new Map([...pieces].map(([value,parts])=>[value,parts.map(part=>prepared.get(part)!).join('')]));
  return replaceValues(input,replacements);
}

export async function prepareGuarded(pool:pg.Pool,detect:(text:string)=>Promise<unknown>,version=DETECTOR_VERSION,count=10,eventId:string|null=null) {
  const client=await pool.connect();let locked=false;
  try {
    if(!eventId)locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended(current_schema(),803308)) AS locked')).rows[0].locked;
    if(!eventId&&!locked)return;
    const {rows}=await client.query("SELECT * FROM guard_sources WHERE state<>'ready' AND next_attempt<=now() AND ($2::text IS NULL OR event_id=$2) ORDER BY next_attempt,id LIMIT $1",[count,eventId]);
    for(const source of rows) {
      let sourceHeld=false;
      try {
        sourceHeld=(await client.query("SELECT pg_try_advisory_lock(hashtextextended(current_schema()||$1,803312)) AS locked",[source.id])).rows[0].locked;
        if(!sourceHeld)continue;
        const fresh=(await client.query("SELECT * FROM guard_sources WHERE id=$1 AND state<>'ready' AND next_attempt<=now()",[source.id])).rows[0];
        if(!fresh)continue;Object.assign(source,fresh);
        const input=source.input?JSON.parse(source.input.toString()):await sourceInput(client,source);
        const inputHash=digest(canonical(input));
        await client.query('UPDATE guard_sources SET input=$2,input_hash=$3,attempts=attempts+1 WHERE id=$1',[source.id,Buffer.from(canonical(input)),inputHash]);
        const output=await prepareValue(client,source.id,input,version,detect);
        await client.query('BEGIN');
        // An owner may have published while detection was in flight.
        const current=(await client.query('SELECT active_revision FROM guard_sources WHERE id=$1 FOR UPDATE',[source.id])).rows[0];
        if(current.active_revision===null) {
          await client.query(`INSERT INTO guard_revisions(id,source_id,revision,content,search_text,input_hash,author,preparation_version)
            VALUES($1,$2,1,$3,$4,$5,'automatic',$6)`,[digest(source.id+':1'),source.id,Buffer.from(canonical(output)),textValues(output).join('\n').replaceAll('\0',''),inputHash,version]);
          await client.query("UPDATE guard_sources SET state='ready',active_revision=1,error_code=NULL WHERE id=$1",[source.id]);
        }
        await client.query('COMMIT');
      } catch(error) {
        console.warn(JSON.stringify({event:'guard_preparation_failed',kind:error instanceof Error?error.name:'unknown',
          location:error instanceof Error?error.stack?.split('\n')[1]?.trim().replace(/\([^)]*\)/,'(source)'):undefined}));
        await client.query('ROLLBACK');
        await client.query(`UPDATE guard_sources SET state='failed',error_code=$2,next_attempt=now()+least(3600,30*power(2,least(attempts,7)))*interval '1 second' WHERE id=$1 AND active_revision IS NULL`,[source.id,error instanceof HttpError?error.code:'guard_preparation_unavailable']);
      }finally{if(sourceHeld)await client.query('SELECT pg_advisory_unlock(hashtextextended(current_schema()||$1,803312))',[source.id]);}
    }
  } finally {if(locked)await client.query('SELECT pg_advisory_unlock(hashtextextended(current_schema(),803308))').catch(()=>{});client.release();}
}

export async function guardedValue(pool:pg.Pool,id:string) {
  const {rows}=await pool.query(`SELECT r.content,r.revision FROM guard_sources s JOIN guard_revisions r ON r.source_id=s.id AND r.revision=s.active_revision WHERE s.id=$1 AND s.state='ready'`,[id]);
  if(!rows[0])throw new HttpError(409,'guard_preparation_pending');
  return {value:JSON.parse(rows[0].content.toString()),revision:rows[0].revision as number};
}

export type GuardMode='on'|'off';
export async function guardState(pool:Pick<pg.Pool,'query'>):Promise<{mode:GuardMode;epoch:number}> {
  const row=(await pool.query('SELECT mode,epoch FROM guard_state WHERE singleton')).rows[0];
  return {mode:row.mode,epoch:Number(row.epoch)};
}
export async function setGuardMode(pool:pg.Pool,mode:GuardMode) {
  if(!['on','off'].includes(mode))throw new HttpError(400,'invalid_guard_mode');
  await pool.query('UPDATE guard_state SET mode=$1,epoch=epoch+1 WHERE singleton AND mode<>$1',[mode]);
  return guardState(pool);
}

export async function inspectGuarded(pool:pg.Pool,principal:Reader,eventId:string) {
  admin(principal);
  const {rows}=await pool.query(`SELECT s.id,s.kind,s.source_id,s.state,s.active_revision,s.error_code,r.author,r.content,r.created_at
    FROM guard_sources s LEFT JOIN guard_revisions r ON r.source_id=s.id AND r.revision=s.active_revision WHERE s.event_id=$1 ORDER BY s.id`,[string(eventId,64)]);
  if(!rows.length)throw new HttpError(404,'source_not_found');
  return {event_id:eventId,projections:rows.map(({content,...row})=>({...row,content:content?JSON.parse(content.toString()):null}))};
}

export async function guardedHistory(pool:pg.Pool,principal:Reader,eventId:string,sourceId:string,before=2147483647) {
  admin(principal);
  if(!Number.isSafeInteger(before)||before<1)throw new HttpError(400,'invalid_revision');
  const {rows}=await pool.query(`SELECT r.revision,r.author,r.preparation_version,r.created_at FROM guard_revisions r JOIN guard_sources s ON s.id=r.source_id
    WHERE s.event_id=$1 AND s.id=$2 AND r.revision<$3 ORDER BY r.revision DESC LIMIT 51`,[string(eventId,64),string(sourceId,256),before]);
  return {revisions:rows.slice(0,50),next:rows.length>50?rows[49].revision:null};
}

export async function inspectRevision(pool:pg.Pool,principal:Reader,eventId:string,sourceId:string,revision:number) {
  admin(principal);
  if(!Number.isSafeInteger(revision)||revision<1)throw new HttpError(400,'invalid_revision');
  const {rows}=await pool.query(`SELECT r.revision,r.author,r.content FROM guard_revisions r JOIN guard_sources s ON s.id=r.source_id
    WHERE s.event_id=$1 AND s.id=$2 AND r.revision=$3`,[string(eventId,64),string(sourceId,256),revision]);
  if(!rows[0])throw new HttpError(404,'guard_revision_missing');
  return {...rows[0],content:JSON.parse(rows[0].content.toString())};
}

export async function editGuarded(pool:pg.Pool,principal:Reader,eventId:string,input:unknown) {
  admin(principal);const body=object(input),id=string(body.source_id,256),expected=body.expected_revision;
  if(expected!==null&&(!Number.isSafeInteger(expected)||Number(expected)<1))throw new HttpError(400,'invalid_revision');
  if(('restore_revision' in body)===('content' in body))throw new HttpError(400,'guard_edit_required');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const source=(await client.query('SELECT * FROM guard_sources WHERE event_id=$1 AND id=$2 FOR UPDATE',[string(eventId,64),id])).rows[0];
    if(!source)throw new HttpError(404,'source_not_found');
    if(source.active_revision!==expected)throw new HttpError(409,'guard_revision_conflict');
    let content=body.content;
    if('restore_revision' in body) {
      if(!Number.isSafeInteger(body.restore_revision)||Number(body.restore_revision)<1)throw new HttpError(400,'invalid_revision');
      const old=(await client.query('SELECT content FROM guard_revisions WHERE source_id=$1 AND revision=$2',[id,body.restore_revision])).rows[0];
      if(!old)throw new HttpError(404,'guard_revision_missing');
      content=JSON.parse(old.content.toString());
    }
    const value=object(content);
    if(source.kind==='events') {if(value.text!==null)string(value.text,2000000);object(value.payload);}
    else if(source.kind==='artifacts'){string(value.kind,100);object(value.metadata);}
    else {string(value.text,4000000);string(value.kind,100);object(value.provenance);}
    const serialized=canonical(value);
    if(Buffer.byteLength(serialized)>8*1024*1024)throw new HttpError(413,'guard_edit_too_large');
    const original=source.input?JSON.parse(source.input.toString()):await sourceInput(client,source);
    const inputHash=digest(canonical(original)),revision=(expected as number|null??0)+1;
    await client.query(`INSERT INTO guard_revisions(id,source_id,revision,content,search_text,input_hash,author,preparation_version)
      VALUES($1,$2,$3,$4,$5,$6,'owner','owner-edit-v1')`,[digest(id+':'+revision),id,revision,Buffer.from(serialized),textValues(value).join('\n').replaceAll('\0',''),inputHash]);
    await client.query("UPDATE guard_sources SET state='ready',input=$2,input_hash=$3,active_revision=$4,error_code=NULL WHERE id=$1",[id,Buffer.from(canonical(original)),inputHash,revision]);
    const epoch=(await client.query('UPDATE guard_state SET epoch=epoch+1 RETURNING epoch')).rows[0].epoch;
    await client.query('INSERT INTO guard_invalidations(source_id,epoch) VALUES($1,$2)',[id,epoch]);
    await client.query('COMMIT');return {source_id:id,revision,epoch:Number(epoch)};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function browseData(pool:pg.Pool,principal:Reader,after='') {
  admin(principal);
  const {rows}=await pool.query(`SELECT e.id,e.scope,e.kind,e.original_text,e.received_at,
    (SELECT count(*)::integer FROM guard_sources s WHERE s.event_id=e.id AND s.state='ready') AS ready,
    (SELECT count(*)::integer FROM guard_sources s WHERE s.event_id=e.id) AS total
    FROM events e WHERE e.id>$1 ORDER BY e.id LIMIT 51`,[string(after,64)]);
  return {records:rows.slice(0,50).map(({original_text,...row})=>({...row,text:original_text?.toString().slice(0,500)??null})),next:rows.length>50?rows[49].id:null};
}

export async function exportGuarded(pool:pg.Pool,eventId:string) {
 const {rows}=await pool.query('SELECT id,active_revision FROM guard_sources WHERE event_id=$1 AND active_revision IS NOT NULL ORDER BY id',[eventId]);
 const sources=[];
 for(const row of rows){const revisions=(await pool.query('SELECT revision,content,input_hash,author,preparation_version,created_at FROM guard_revisions WHERE source_id=$1 ORDER BY revision',[row.id])).rows;
  sources.push({...row,revisions:revisions.map(r=>({...r,content:JSON.parse(r.content.toString()),created_at:r.created_at.toISOString()}))});}
 return {format:'nocheh-guarded-v1',sources};
}
export async function restoreGuarded(pool:pg.Pool,eventId:string,input:unknown) {
 const bundle=object(input);if(bundle.format!=='nocheh-guarded-v1'||!Array.isArray(bundle.sources)||bundle.sources.length>1001)throw new HttpError(400,'invalid_guarded_export');
 const client=await pool.connect();let changed=false;
 try{await client.query('BEGIN');
  for(const raw of bundle.sources){const entry=object(raw),id=string(entry.id,256),source=(await client.query('SELECT * FROM guard_sources WHERE id=$1 AND event_id=$2 FOR UPDATE',[id,eventId])).rows[0];
   if(!source||!Array.isArray(entry.revisions)||!entry.revisions.length||entry.revisions.length>10000||entry.active_revision!==entry.revisions.length)throw new HttpError(400,'invalid_guarded_export');
   const original=await sourceInput(client,source),inputHash=digest(canonical(original));
   const existing=(await client.query('SELECT revision,content,author,preparation_version,input_hash FROM guard_revisions WHERE source_id=$1 ORDER BY revision',[id])).rows;
   // A restored export cannot silently replace another current owner history.
   if(existing.length&&existing.length!==entry.revisions.length)throw new HttpError(409,'guard_restore_conflict');
   for(const [index,rawRevision] of entry.revisions.entries()) {
    const r=object(rawRevision),value=object(r.content),serialized=canonical(value);
    if(r.revision!==index+1||r.input_hash!==inputHash||!['owner','automatic'].includes(String(r.author))||!Number.isFinite(Date.parse(String(r.created_at))))throw new HttpError(409,'guard_restore_integrity');
    if(source.kind==='events'){if(value.text!==null)string(value.text,2000000);object(value.payload);}
    else if(source.kind==='artifacts'){string(value.kind,100);object(value.metadata);}else{string(value.text,4000000);string(value.kind,100);object(value.provenance);}
    if(existing.length){const old=existing[index];if(old.content.toString()!==serialized||old.author!==r.author||old.input_hash!==inputHash||old.preparation_version!==r.preparation_version)throw new HttpError(409,'guard_restore_conflict');}
    else{await client.query(`INSERT INTO guard_revisions(id,source_id,revision,content,search_text,input_hash,author,preparation_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
     [digest(id+':'+r.revision),id,r.revision,Buffer.from(serialized),textValues(value).join('\n').replaceAll('\0',''),inputHash,r.author,string(r.preparation_version,256),r.created_at]);changed=true;}
   }
   await client.query("UPDATE guard_sources SET input=$2,input_hash=$3,active_revision=$4,state='ready',error_code=NULL WHERE id=$1",[id,Buffer.from(canonical(original)),inputHash,entry.active_revision]);
  }
  if(changed)await client.query('UPDATE guard_state SET epoch=epoch+1');await client.query('COMMIT');return {restored:bundle.sources.length};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

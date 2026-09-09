import type pg from 'pg';
import {canonical,digest} from './archive.js';
import {DETECTOR_VERSION,literalSpans,mask,patternSpans} from './guard.js';
import {HttpError} from './http.js';

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

export async function prepareGuarded(pool:pg.Pool,detect:(text:string)=>Promise<unknown>,version=DETECTOR_VERSION,count=10) {
  const client=await pool.connect();let locked=false;
  try {
    locked=(await client.query('SELECT pg_try_advisory_lock(803308) AS locked')).rows[0].locked;if(!locked)return;
    const {rows}=await client.query("SELECT * FROM guard_sources WHERE state<>'ready' AND next_attempt<=now() ORDER BY next_attempt,id LIMIT $1",[count]);
    for(const source of rows) {
      try {
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
        await client.query('ROLLBACK');
        await client.query(`UPDATE guard_sources SET state='failed',error_code=$2,next_attempt=now()+least(3600,30*power(2,least(attempts,7)))*interval '1 second' WHERE id=$1 AND active_revision IS NULL`,[source.id,error instanceof HttpError?error.code:'guard_preparation_unavailable']);
      }
    }
  } finally {if(locked)await client.query('SELECT pg_advisory_unlock(803308)').catch(()=>{});client.release();}
}

export async function guardedValue(pool:pg.Pool,id:string) {
  const {rows}=await pool.query(`SELECT r.content,r.revision FROM guard_sources s JOIN guard_revisions r ON r.source_id=s.id AND r.revision=s.active_revision WHERE s.id=$1 AND s.state='ready'`,[id]);
  if(!rows[0])throw new HttpError(409,'guard_preparation_pending');
  return {value:JSON.parse(rows[0].content.toString()),revision:rows[0].revision as number};
}

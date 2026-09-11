import type pg from 'pg';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Reader } from './access.js';
import {assertAudience} from './access.js';
import { type Envelope, digest, envelope, ingest, canonical } from './archive.js';
import { HttpError, object, string } from './http.js';
import { storeBytes } from './storage.js';
import {guardState,guardedValue,exportGuarded,restoreGuarded} from './guarded.js';
import {contextAudience,allowPrepared} from './prepared-context.js';

export function limit(value:unknown,fallback=20,max=50):number {
  const n=value===null || value===undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n<1 || n>max) throw new HttpError(400,'invalid_limit');
  return n;
}
type EventRow={id:string;source_key:string;scope:string;channel:'telegram'|'browser'|'scheduler';bot_id:string;source_id:string;revision:string;origin:Envelope['origin'];kind:string;occurred_at:string|null;
  received_at:Date;payload:Buffer;original_text:Buffer|null;wire:Buffer|null};
const toEnvelope=(row:EventRow):Envelope=>({version:1,key:row.source_key,bot_id:row.bot_id,scope:row.scope,source_id:row.source_id,revision:row.revision,
  ...(row.channel === 'telegram' ? {} : {channel:row.channel}),
  origin:row.origin,kind:row.kind,occurred_at:row.occurred_at,payload:JSON.parse(row.payload.toString()),text:row.original_text?.toString() ?? null,
  ...(row.wire ? {wire_base64:row.wire.toString('base64')} : {})});
export async function search(pool:pg.Pool,principal:Reader,query:string,count=20) {
  await assertAudience(pool,principal);
  string(query,2000); limit(count);
  if (!query.trim()) throw new HttpError(400,'empty_query');
  if(!principal.admin && (await guardState(pool)).mode==='on') {
    const {rows}=await pool.query(`SELECT e.id,e.scope,e.occurred_at,e.origin,s.kind,s.source_id,r.content,r.revision
      FROM guard_sources s JOIN guard_revisions r ON r.source_id=s.id AND r.revision=s.active_revision JOIN events e ON e.id=s.event_id
      WHERE s.state='ready' AND e.origin<>'generated' AND (s.kind<>'derived_artifacts' OR EXISTS(SELECT 1 FROM derived_artifacts d WHERE d.id=s.source_id AND (d.kind IN ('transcript','extracted_text','extraction_status') OR d.provenance->>'guard_epoch'=(SELECT epoch::text FROM guard_state WHERE singleton)))) AND s.kind IN ('events','derived_artifacts') AND ($2::text IS NULL OR (e.scope=$2 AND e.origin<>'generated'))
      AND ($3::text IS NULL OR e.id IN(SELECT event_id FROM event_spaces WHERE space_id=$3))
      AND ($5::text IS NULL OR s.kind<>'derived_artifacts' OR EXISTS(SELECT 1 FROM derived_artifacts d WHERE d.id=s.source_id AND (d.kind<>'runtime_context' OR d.provenance->>'audience'=$5)))
      AND to_tsvector('simple',r.search_text) @@ plainto_tsquery('simple',$1)
      ORDER BY ts_rank(to_tsvector('simple',r.search_text),plainto_tsquery('simple',$1)) DESC,e.received_at DESC LIMIT $4`,[query,principal.scope,principal.scope===null?null:principal.space??null,count,principal.scope===null?null:contextAudience(principal)]);
    await assertAudience(pool,principal);
    return rows.map(row=>{const value=JSON.parse(row.content.toString()),text=String(value.text??'');return {
      id:row.id,source:'nocheh:event:'+row.id,scope:row.scope,source_id:row.id,revision:row.revision,representation:'guarded',
      kind:row.kind==='events'?'message':value.kind??'derived',origin:row.kind==='events'?row.origin:'derived',derived_id:row.kind==='events'?null:row.source_id,
      occurred_at:row.occurred_at,text:text.slice(0,2000),truncated:text.length>2000};});
  }
  const {rows}=await pool.query<EventRow & {derived_id:string|null}>(`WITH hits AS (
    SELECT id,scope,source_id,revision,origin,kind,occurred_at,received_at,original_text,NULL::text AS derived_id,
      ts_rank(to_tsvector('simple',search_text),plainto_tsquery('simple',$1)) AS rank
    FROM events WHERE ($2::text IS NULL OR (scope=$2 AND origin<>'generated')) AND ($4::text IS NULL OR id IN(SELECT event_id FROM event_spaces WHERE space_id=$4)) AND to_tsvector('simple',search_text) @@ plainto_tsquery('simple',$1)
    UNION ALL
    SELECT e.id,e.scope,e.source_id,e.revision,'derived',d.kind,e.occurred_at,e.received_at,d.content,d.id,
      ts_rank(to_tsvector('simple',d.search_text),plainto_tsquery('simple',$1)) AS rank
    FROM derived_artifacts d JOIN events e ON e.id=d.event_id
    WHERE ($2::text IS NULL OR (e.scope=$2 AND e.origin<>'generated')) AND ($4::text IS NULL OR e.id IN(SELECT event_id FROM event_spaces WHERE space_id=$4)) AND ($5::text IS NULL OR d.kind<>'runtime_context' OR d.provenance->>'audience'=$5) AND to_tsvector('simple',d.search_text) @@ plainto_tsquery('simple',$1)
  ) SELECT * FROM hits ORDER BY rank DESC,received_at DESC,id LIMIT $3`,[query,principal.scope,count,principal.scope===null?null:principal.space??null,principal.scope===null?null:contextAudience(principal)]);
  await assertAudience(pool,principal);
  return rows.map(row=>({id:row.id,source:`nocheh:event:${row.id}`,scope:row.scope,source_id:row.source_id,revision:row.revision,
    kind:row.kind,origin:row.origin,derived_id:row.derived_id,occurred_at:row.occurred_at,text:row.original_text?.toString().slice(0,2000) ?? null,
    truncated:(row.original_text?.toString().length ?? 0)>2000}));
}
export async function readEvent(pool:pg.Pool,principal:Reader,id:string) {
  await assertAudience(pool,principal);
  string(id,64);
  const {rows}=await pool.query<EventRow>(`SELECT * FROM events WHERE id=$1 AND ($2::text IS NULL OR (scope=$2 AND origin<>'generated')) AND ($3::text IS NULL OR id IN(SELECT event_id FROM event_spaces WHERE space_id=$3))`,[id,principal.scope,principal.scope===null?null:principal.space??null]);
  const row=rows[0]; if (!row) throw new HttpError(404,'source_not_found');
  const artifacts=await pool.query('SELECT * FROM artifacts WHERE event_id=$1 ORDER BY id',[id]);
  const derived=await pool.query<{id:string;event_id:string;artifact_id:string|null;kind:string;content:Buffer;provenance:unknown;created_at:Date}>(
    "SELECT id,event_id,artifact_id,kind,content,provenance,created_at FROM derived_artifacts WHERE event_id=$1 AND ($2::text IS NULL OR kind<>'runtime_context' OR provenance->>'audience'=$2) ORDER BY id",[id,principal.scope===null?null:contextAudience(principal)]);
  if(!principal.admin && (await guardState(pool)).mode==='on') {
    if(row.origin==='generated')throw new HttpError(409,'generated_context_unavailable');
    const selected=await guardedValue(pool,'events:'+id),{wire_base64:_wire,...event}=toEnvelope(row);
    await allowPrepared(pool,principal,selected.value);
    const guardedArtifacts:Record<string,unknown>[]=[],guardedDerived=[];
    for(const artifact of artifacts.rows) {
      try {const copy=await guardedValue(pool,'artifacts:'+artifact.id);guardedArtifacts.push({id:artifact.id,kind:copy.value.kind,state:artifact.state,metadata:copy.value.metadata});}
      catch(error){if(!(error instanceof HttpError)||error.code!=='guard_preparation_pending')throw error;}
    }
    for(const item of derived.rows) {
      if(!['transcript','extracted_text','extraction_status'].includes(item.kind)&&String((item.provenance as any)?.guard_epoch)!==String((await guardState(pool)).epoch))continue;
      try {const copy=await guardedValue(pool,'derived_artifacts:'+item.id);await allowPrepared(pool,principal,copy.value);guardedDerived.push({id:item.id,event_id:id,artifact_id:item.artifact_id,kind:copy.value.kind,
        content_base64:Buffer.from(copy.value.text??'').toString('base64'),provenance:copy.value.provenance,created_at:item.created_at.toISOString()});}
      catch(error){if(!(error instanceof HttpError)||error.code!=='guard_preparation_pending')throw error;}
    }
    await assertAudience(pool,principal);
    return {id,source:'nocheh:event:'+id,received_at:row.received_at.toISOString(),representation:'guarded',guarded_revision:selected.revision,
      event:{...event,key:'nocheh:event:'+id,source_id:id,revision:String(selected.revision),bot_id:'',kind:'message',text:selected.value.text,payload:selected.value.payload},
      artifacts:guardedArtifacts,derived:guardedDerived};
  }
  await assertAudience(pool,principal);
  return {id:row.id,source:`nocheh:event:${id}`,received_at:row.received_at.toISOString(),event:toEnvelope(row),artifacts:artifacts.rows,
    derived:derived.rows.map(d=>({...d,created_at:d.created_at.toISOString(),content_base64:d.content.toString('base64'),content:undefined}))};
}
export async function readArtifact(pool:pg.Pool,principal:Reader,root:string,id:string):Promise<Buffer> {
  await assertAudience(pool,principal);
  if(!principal.admin && (await guardState(pool)).mode==='on')throw new HttpError(403,'original_file_requires_owner');
  const {rows}=await pool.query<{file_hash:string;state:string}>(`SELECT a.file_hash,a.state FROM artifacts a JOIN events e ON e.id=a.event_id
    WHERE a.id=$1 AND ($2::text IS NULL OR (e.scope=$2 AND e.origin<>'generated')) AND ($3::text IS NULL OR e.id IN(SELECT event_id FROM event_spaces WHERE space_id=$3))`,[string(id,64),principal.scope,principal.scope===null?null:principal.space??null]);
  const row=rows[0]; if (!row) throw new HttpError(404,'source_not_found');
  if (row.state!=='ready' || !/^[a-f0-9]{64}$/.test(row.file_hash)) throw new HttpError(409,'artifact_unavailable');
  const bytes=await readFile(join(root,'files',row.file_hash));
  if (digest(bytes)!==row.file_hash) throw new HttpError(503,'artifact_integrity_failed');
  await assertAudience(pool,principal);return bytes;
}
export async function exportPage(pool:pg.Pool,after:string,count=20) {
  const ids=await pool.query<{id:string}>('SELECT id FROM events WHERE id>$1 ORDER BY id LIMIT $2',[string(after,64),limit(count,20,50)]);
  const records=[];
  for (const {id} of ids.rows) records.push({...await readEvent(pool,{scope:null,admin:true},id),guarded:await exportGuarded(pool,id)});
  return {format:'nocheh-archive-v1',records,next:ids.rows.length===count ? ids.rows.at(-1)?.id : null};
}
export async function importRecord(pool:pg.Pool,value:unknown,restoreCopies=false) {
  const record=object(value), event=envelope(record.event);
  const artifacts=record.artifacts ?? [], derived=record.derived ?? [];
  if (!Array.isArray(artifacts) || artifacts.length>1000 || !Array.isArray(derived) || derived.length>1000) throw new HttpError(400,'invalid_artifacts');
  if (record.received_at !== undefined && !Number.isFinite(Date.parse(string(record.received_at,100)))) throw new HttpError(400,'invalid_timestamp');
  // Original origin/provenance is retained; import transport cannot dispatch old replies.
  const result=await ingest(pool,event,false);
  if (!result.duplicate && record.received_at) await pool.query('UPDATE events SET received_at=$2 WHERE id=$1',[result.id,record.received_at]);
  for (const raw of artifacts) {
    const a=object(raw),ref=string(a.source_ref,4096),id=digest(`${result.id}:${ref}`);
    if (a.id!==undefined && a.id!==id) throw new HttpError(409,'artifact_identity_conflict');
    const previous=await pool.query<{kind:string;metadata:unknown}>('SELECT kind,metadata FROM artifacts WHERE id=$1',[id]);
    if (previous.rows[0] && (previous.rows[0].kind!==a.kind || canonical(previous.rows[0].metadata)!==canonical(a.metadata ?? {}))) throw new HttpError(409,'artifact_metadata_conflict');
    await pool.query(`INSERT INTO artifacts(id,event_id,kind,source_ref,metadata,state,error_code) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(id) DO NOTHING`,[id,result.id,string(a.kind,100),ref,JSON.stringify(object(a.metadata ?? {})),
        a.state==='failed'?'failed':'pending',a.state==='failed'?'import_file_missing':'import_bytes_pending']);
  }
  for (const raw of derived) {
    const d=object(raw),id=string(d.id,128),artifactId=d.artifact_id===null ? null : string(d.artifact_id,64);
    const content=decodeBytes(d.content_base64,16*1024*1024),provenance=object(d.provenance);
    if (artifactId && !(await pool.query('SELECT 1 FROM artifacts WHERE id=$1 AND event_id=$2',[artifactId,result.id])).rowCount) throw new HttpError(400,'invalid_artifact_reference');
    const previous=await pool.query<{content:Buffer;provenance:unknown;event_id:string;kind:string;artifact_id:string|null;created_at:Date}>('SELECT * FROM derived_artifacts WHERE id=$1',[id]);
    if (previous.rows[0] && (!previous.rows[0].content.equals(content) || canonical(previous.rows[0].provenance)!==canonical(provenance)
      || previous.rows[0].event_id!==result.id || previous.rows[0].kind!==d.kind || previous.rows[0].artifact_id!==artifactId
      || (d.created_at!==undefined && previous.rows[0].created_at.toISOString()!==new Date(string(d.created_at,100)).toISOString()))) throw new HttpError(409,'derived_identity_conflict');
    await pool.query(`INSERT INTO derived_artifacts(id,event_id,artifact_id,kind,content,provenance,created_at,search_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
      [id,result.id,artifactId,string(d.kind,100),content,JSON.stringify(provenance),d.created_at ?? new Date().toISOString(),content.toString().replaceAll('\0','')]);
  }
  if(restoreCopies&&record.guarded)await restoreGuarded(pool,result.id,record.guarded);
  return result;
}
export function decodeBytes(value:unknown,max=50*1024*1024):Buffer {
  const encoded=string(value,Math.ceil(max/3)*4);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new HttpError(400,'invalid_base64');
  const bytes=Buffer.from(encoded,'base64'); if (bytes.length>max) throw new HttpError(413,'body_too_large'); return bytes;
}
export async function uploadArtifact(pool:pg.Pool,root:string,id:string,value:unknown) {
  const body=object(value),bytes=decodeBytes(body.bytes_base64),hash=digest(bytes);
  if (body.sha256!==hash) throw new HttpError(409,'artifact_integrity_failed');
  const {rows}=await pool.query<{file_hash:string|null;state:string}>('SELECT file_hash,state FROM artifacts WHERE id=$1',[id]);
  const current=rows[0]; if (!current) throw new HttpError(404,'source_not_found');
  if (current.file_hash && current.file_hash!==hash) throw new HttpError(409,'immutable_file_conflict');
  await storeBytes(root,bytes);
  // Lock/condition protects a racing upload or download from replacing accepted bytes.
  const updated=await pool.query(`UPDATE artifacts SET state='ready',file_hash=$2,byte_size=$3,error_code=NULL WHERE id=$1 AND (file_hash IS NULL OR file_hash=$2)`,[id,hash,bytes.length]);
  if (!updated.rowCount) throw new HttpError(409,'immutable_file_conflict');
  return {id,sha256:hash,bytes:bytes.length};
}
export async function replay(pool:pg.Pool,ids:unknown) {
  if (!Array.isArray(ids) || ids.length>100) throw new HttpError(400,'invalid_replay_batch');
  for (const id of ids) {
    const record=await readEvent(pool,{scope:null,admin:true},string(id,64));
    await ingest(pool,record.event,false);
    await pool.query("UPDATE artifacts SET next_attempt=now() WHERE event_id=$1 AND state<>'ready'",[id]);
  }
  return {replayed:ids.length,telegram_replies:0,mode:'archive_only'};
}

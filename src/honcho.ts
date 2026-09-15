import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {digest} from './archive.js';
import {HttpError,object,string} from './http.js';
import {assertAudience,type Reader} from './access.js';
import {guardState,guardedValue} from './guarded.js';
import {policyRevision,parentSpace,spacePolicy} from './spaces.js';
import {allowPrepared,prepareContext} from './prepared-context.js';
import {enterFamily,leaveFamily,releaseOperation,type ExecutionAuthority} from './workflows/store.js';

export const honchoSchema=`
CREATE TABLE IF NOT EXISTS honcho_connection(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 instance text NOT NULL,attached boolean NOT NULL DEFAULT false,verified boolean NOT NULL DEFAULT false,
 attached_at timestamptz,include_history boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE honcho_connection ADD COLUMN IF NOT EXISTS acceptance jsonb;
CREATE TABLE IF NOT EXISTS honcho_generations(id text PRIMARY KEY,audience text NOT NULL,mode text NOT NULL,
 guard_epoch bigint NOT NULL,policy_revision integer NOT NULL,event_id text NOT NULL REFERENCES events(id),
 state text NOT NULL DEFAULT 'building',error_code text,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(audience,guard_epoch,policy_revision));
ALTER TABLE honcho_generations ADD COLUMN IF NOT EXISTS last_ready_at timestamptz;
UPDATE honcho_generations SET last_ready_at=now() WHERE state='ready' AND last_ready_at IS NULL;
CREATE TABLE IF NOT EXISTS honcho_receipts(id text PRIMARY KEY,generation text NOT NULL REFERENCES honcho_generations(id),
 source_id text NOT NULL REFERENCES guard_sources(id),source_revision text NOT NULL,guarded_revision integer,
 audience text NOT NULL,content_hash text NOT NULL,content bytea NOT NULL,state text NOT NULL DEFAULT 'pending',
 remote_id text,attempts integer NOT NULL DEFAULT 0,next_attempt timestamptz NOT NULL DEFAULT now(),error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS honcho_receipts_pending ON honcho_receipts(generation,state,next_attempt);
CREATE TABLE IF NOT EXISTS honcho_prepared_sources(source_id text NOT NULL REFERENCES guard_sources(id),guard_epoch bigint NOT NULL,
 policy_revision integer NOT NULL,PRIMARY KEY(source_id,guard_epoch,policy_revision));
CREATE TABLE IF NOT EXISTS honcho_context_cache(generation text PRIMARY KEY REFERENCES honcho_generations(id),
 content bytea NOT NULL CHECK(octet_length(content)<=80000),refreshed_at timestamptz NOT NULL DEFAULT now());
`;
export type HonchoCall=(path:string,body?:unknown)=>Promise<any>;
export function honchoClient(base:string):HonchoCall {
 const url=new URL(base);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('invalid_honcho_url');
 return async(path,body)=>{
  // Recall includes guarded query preparation, embeddings and subscription reasoning.
  let response:Response;try{response=await fetch(url.origin+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(path.endsWith('/chat')?480000:120000),
   headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}catch{throw new HttpError(503,'honcho_unavailable');}
  if(!response.ok)throw new HttpError(503,'honcho_upstream_rejected');
  const text=await response.text();if(text.length>2*1024*1024)throw new HttpError(503,'honcho_response_limit');
  return JSON.parse(text);
 };
}
export async function memoryStatus(pool:pg.Pool) {
 await pool.query('INSERT INTO honcho_connection(singleton,instance) VALUES(true,$1) ON CONFLICT DO NOTHING',[randomUUID()]);
 const connection=(await pool.query('SELECT attached,verified,attached_at,include_history FROM honcho_connection')).rows[0];
 const guard=await guardState(pool),policy=await policyRevision(pool);
 const generations=(await pool.query(`SELECT id,audience,mode,state,error_code,guard_epoch,last_ready_at FROM honcho_generations
   WHERE guard_epoch=$1 AND policy_revision=$2 ORDER BY audience`,[guard.epoch,policy])).rows;
 const receipts=(await pool.query('SELECT state,count(*)::int AS count FROM honcho_receipts GROUP BY state')).rows;
 return {connection,generations,receipts,guard,policy,primary:'honcho',native_notes:['MEMORY.md','USER.md'],
  syncing:generations.some(g=>g.state==='building'),
  limited_memory:!connection.attached||!connection.verified||!generations.length||generations.some(g=>g.state!=='ready'&&!(g.state==='building'&&g.last_ready_at))};
}
export async function setMemoryConnection(pool:pg.Pool,input:unknown) {
 const b=object(input);if(typeof b.attached!=='boolean'||(b.include_history!==undefined&&typeof b.include_history!=='boolean')||(b.catch_up!==undefined&&typeof b.catch_up!=='boolean'))throw new HttpError(400,'invalid_memory_connection');
 await memoryStatus(pool);
 const client=await pool.connect();try{await client.query('BEGIN');
  const state=(await client.query('SELECT * FROM honcho_connection FOR UPDATE')).rows[0];
  if(b.attached&&!state.verified)throw new HttpError(409,'honcho_live_acceptance_pending');
  await client.query('UPDATE honcho_connection SET attached=$1,attached_at=CASE WHEN $1 AND NOT attached AND NOT $3 THEN now() ELSE coalesce(attached_at,now()) END,include_history=$2,updated_at=now()', [b.attached,b.include_history??state.include_history,b.catch_up??false]);
  // Revokes in-flight work and keeps old provider memory inaccessible. Reattach
  // reconciles old receipts before a new generation can be used (G6).
  if(state.attached!==b.attached)await client.query('UPDATE guard_state SET epoch=epoch+1');
  await client.query('COMMIT');return memoryStatus(pool);
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function acceptMemoryVerification(pool:pg.Pool,input:unknown) {
 const report=object(input),checks=object(report.checks),ledger=object(report.ledger);
 const required=['subscription_reasoning','ingestion','retrieval','embedding_guarded','restart','provider_failure'];
 if(report.format!=='nocheh-honcho-live-v1'||report.status!=='passed'||report.synthetic_only!==true||required.some(name=>checks[name]!=='passed')||
   typeof ledger.reserved_usd!=='number'||!Number.isFinite(ledger.reserved_usd)||ledger.reserved_usd<=0||ledger.reserved_usd>5||ledger.limit_usd!==5)throw new HttpError(409,'honcho_live_acceptance_pending');
 await memoryStatus(pool);
 await pool.query('UPDATE honcho_connection SET verified=true,acceptance=$1,updated_at=now()',[JSON.stringify({checks,recorded_at:report.recorded_at,format:report.format})]);
 return memoryStatus(pool);
}
async function currentGeneration(pool:pg.Pool,id:string) {
 const row=(await pool.query(`SELECT g.* FROM honcho_generations g,guard_state s,memory_policy_state p,honcho_connection c
 WHERE g.id=$1 AND s.singleton AND p.singleton AND c.singleton AND c.attached AND c.verified
 AND g.guard_epoch=s.epoch AND g.policy_revision=p.revision AND g.state<>'retired'
 AND NOT EXISTS(SELECT 1 FROM honcho_receipts r JOIN guard_sources source ON source.id=r.source_id
 WHERE r.generation=g.id AND NOT EXISTS(SELECT 1 FROM memory_learning_sources learning WHERE learning.event_id=source.event_id))`,[id])).rows[0];
 if(!row)throw new HttpError(409,'memory_context_retired');return row;
}
function generationReader(row:any):Reader {return {admin:false,scope:row.audience==='owner'?null:parentSpace(row.audience)??row.audience,
 space:row.audience==='owner'?undefined:row.audience,revision:Number(row.policy_revision),guard_epoch:Number(row.guard_epoch),turnEvent:row.event_id};}
export async function prepareMemoryRequest(pool:pg.Pool,input:unknown,detect:(text:string)=>Promise<unknown>) {
 const body=object(input),row=await currentGeneration(pool,string(body.workspace,64)),principal=generationReader(row),payload=object(body.payload);
 if(!['/v1/chat/completions','/v1/embeddings'].includes(String(body.route)))throw new HttpError(400,'memory_route_denied');
 // Token IDs are opaque source data; only text embeddings can be prepared.
 if(body.route==='/v1/embeddings'&&row.mode==='on'&&!(typeof payload.input==='string'||Array.isArray(payload.input)&&payload.input.every(v=>typeof v==='string')))throw new HttpError(409,'opaque_embedding_input');
 const prepared=await prepareContext(pool,principal,payload,detect);await currentGeneration(pool,row.id);return {payload:prepared};
}
export async function queueMemory(pool:pg.Pool) {
 await memoryStatus(pool);
 const connection=(await pool.query('SELECT * FROM honcho_connection')).rows[0];if(!connection.attached||!connection.verified)return 0;
 const guard=await guardState(pool),policy=await policyRevision(pool);
 await pool.query("UPDATE honcho_generations SET state='retired' WHERE guard_epoch<>$1 OR policy_revision<>$2",[guard.epoch,policy]);
 // Explicit learning approvals include imported history. A successful live turn
 // grants its own source; historical imports are never inferred from guarding.
 const sources=(await pool.query(`SELECT s.*,e.revision,e.origin,e.received_at,es.space_id FROM guard_sources s JOIN events e ON e.id=s.event_id
 JOIN event_spaces es ON es.event_id=e.id JOIN memory_learning_sources l ON l.event_id=e.id
 WHERE (s.kind='events' OR (s.kind='derived_artifacts' AND EXISTS(SELECT 1 FROM derived_artifacts d WHERE d.id=s.source_id AND d.kind IN ('transcript','extracted_text'))))
 AND ($1::boolean OR e.received_at >= $2 OR EXISTS(SELECT 1 FROM honcho_receipts prior WHERE prior.source_id=s.id AND prior.state='done')) AND ($3='off' OR s.state='ready')
 AND NOT EXISTS(SELECT 1 FROM honcho_prepared_sources p WHERE p.source_id=s.id AND p.guard_epoch=$4 AND p.policy_revision=$5)
 ORDER BY e.received_at,s.id LIMIT 50`,[connection.include_history,connection.attached_at,guard.mode,guard.epoch,policy])).rows;
 for(const source of sources) {
  let value:any,revision:number|null=null;
  if(guard.mode==='on') {try{const copy=await guardedValue(pool,source.id);value=copy.value;revision=copy.revision;}catch(error){if(error instanceof HttpError&&error.code==='guard_preparation_pending')continue;throw error;}}
  else value=JSON.parse(source.input?.toString()??'null');
  // Sources not yet snapshotted by preparation still select original bytes off.
  if(guard.mode==='off'&&!value){const original=source.kind==='events'?(await pool.query('SELECT original_text AS content FROM events WHERE id=$1',[source.source_id])).rows[0]:
   (await pool.query('SELECT content FROM derived_artifacts WHERE id=$1',[source.source_id])).rows[0];value={text:original?.content?.toString()??''};}
  const text=String(value?.text??'');
  if(!text.trim()){await pool.query('INSERT INTO honcho_prepared_sources VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[source.id,guard.epoch,policy]);continue;}
  const audiences=['owner',...(source.space_id.startsWith('-')?[source.space_id]:[])];
  for(const audience of [...new Set(audiences)]) {
   const id=digest(`${connection.instance}:${guard.mode}:${guard.epoch}:${policy}:${audience}`);
   await pool.query('INSERT INTO honcho_generations(id,audience,mode,guard_epoch,policy_revision,event_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[id,audience,guard.mode,guard.epoch,policy,source.event_id]);
   const generation=await currentGeneration(pool,id);
   await allowPrepared(pool,generationReader(generation),{text});
   // Deterministic separate sessions make reconciliation independent of ordering.
   const chunks=Array.from(text);for(let offset=0;offset<chunks.length;offset+=12000){const content=`[nocheh:event:${source.event_id}]\n`+chunks.slice(offset,offset+12000).join(''),hash=digest(content),receipt=digest(`${id}:${source.id}:${source.revision}:${revision}:${offset}:${hash}`);
    await pool.query(`INSERT INTO honcho_receipts(id,generation,source_id,source_revision,guarded_revision,audience,content_hash,content)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[receipt,id,source.id,source.revision,revision,audience,hash,Buffer.from(content)]);
    await allowPrepared(pool,generationReader(generation),{text:content});
   }
  }
  await pool.query('INSERT INTO honcho_prepared_sources VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[source.id,guard.epoch,policy]);
 }
 return sources.length;
}
export async function observeGeneration(pool:pg.Pool,id:string,call:HonchoCall):Promise<boolean> {
 await currentGeneration(pool,id);
 const pending=Number((await pool.query("SELECT count(*) AS count FROM honcho_receipts WHERE generation=$1 AND state<>'done'",[id])).rows[0].count);
 const queue=await call('/v3/workspaces/'+id+'/queue/status');
 await currentGeneration(pool,id);
 const ready=!pending&&queue.pending_work_units===0&&queue.in_progress_work_units===0;
 await pool.query("UPDATE honcho_generations SET state=$2,error_code=NULL,last_ready_at=CASE WHEN $2='ready' THEN now() ELSE last_ready_at END WHERE id=$1 AND state<>'retired'",[id,ready?'ready':'building']);
 return ready;
}
/** Refresh protected, audience-bound context from Honcho's stored conclusions.
 * No query or reasoning request is involved. Only the generation ID travels in
 * workflow records; neither the representation nor guard output leaves the archive.
 */
export async function refreshMemoryContext(pool:pg.Pool,id:string,call:HonchoCall,detect:(text:string)=>Promise<unknown>) {
 const generation=await currentGeneration(pool,id);
 if(!generation.last_ready_at&&generation.state!=='ready')return false;
 const fetchedAt=new Date();
 const result=await call('/v3/workspaces/'+id+'/peers/source/representation',{include_most_frequent:true,max_conclusions:50});
 await currentGeneration(pool,id);
 const bounded=Array.from(string(result.representation,2*1024*1024)).slice(0,20000).join('');
 const text=String(await prepareContext(pool,generationReader(generation),bounded,detect));
 await currentGeneration(pool,id);
 await pool.query(`INSERT INTO honcho_context_cache(generation,content,refreshed_at) VALUES($1,$2,$3)
 ON CONFLICT(generation) DO UPDATE SET content=excluded.content,refreshed_at=excluded.refreshed_at
 WHERE honcho_context_cache.refreshed_at<=excluded.refreshed_at`,[id,Buffer.from(text),fetchedAt]);
 // A concurrent revocation can leave evidence at rest but can never make it readable.
 await currentGeneration(pool,id);return true;
}
/** Every turn gets primary Honcho context without a foreground provider call.
 * Empty or expired context requests one durable refresh; deeper query-specific
 * recall remains a separate operation and never populates this base-context cache.
 */
export async function memoryContext(pool:pg.Pool,principal:Reader) {
 await assertAudience(pool,principal);
 const status=await memoryStatus(pool),audience=principal.scope===null?'owner':principal.space??principal.scope;
 const generation=status.generations.find(g=>g.audience===audience);
 const limited={sources:[],limited_memory:true,syncing:generation?.state==='building',note:'Long-term memory is limited. Current context, native notes and archive search remain available.'};
 if(!status.connection.attached||!status.connection.verified||!generation)return limited;
 try {
  const current=await currentGeneration(pool,generation.id);
  const cached=(await pool.query(`SELECT content,refreshed_at,refreshed_at>now()-interval '5 minutes' AS usable,
    refreshed_at>now()-interval '1 minute' AS fresh FROM honcho_context_cache WHERE generation=$1`,[current.id])).rows[0];
  // Permanent identity makes concurrent cold reads converge. It also preserves
  // an owner's cancellation instead of creating a replacement refresh effect.
  if(!cached?.fresh)await pool.query("SELECT nocheh_workflow_request('honcho',$1)",['context:'+current.id]);
  if(!cached?.usable||!current.last_ready_at&&current.state!=='ready')return limited;
  const text=cached.content.toString();
  await allowPrepared(pool,principal,{text});await currentGeneration(pool,current.id);await assertAudience(pool,principal);
  return {sources:text?[{source:'nocheh:honcho:'+current.id,kind:'memory_inference',text}]:[],limited_memory:false,
   syncing:current.state==='building',context_refreshed_at:cached.refreshed_at.toISOString(),
   note:'Bounded stored Honcho context. Use nocheh_memory_recall when relevant details are missing; absence here does not mean the memory is absent.'};
 }catch{await assertAudience(pool,principal);return limited;}
}
export async function reconcileHonchoReceipt(pool:pg.Pool,id:string,call:HonchoCall):Promise<boolean> {
 const connection=(await memoryStatus(pool)).connection;if(!connection.attached||!connection.verified)return false;
 const row=(await pool.query('SELECT * FROM honcho_receipts WHERE id=$1',[id])).rows[0];
 if(!row)throw new HttpError(404,'honcho_receipt_missing');
 if(row.state==='done')return true;
 if(row.state!=='uncertain')return false;
 const found=(await call('/v3/workspaces/'+row.generation+'/sessions/'+row.id+'/messages/list',{filters:{metadata:{nocheh_receipt:row.id}}})).items;
 if(!Array.isArray(found)||found.length>1)throw new HttpError(409,'honcho_receipt_conflict');
 if(!found.length)return false;
 if(found[0].content!==row.content.toString()||found[0].metadata?.nocheh_receipt!==row.id)throw new HttpError(409,'honcho_receipt_conflict');
 await pool.query("UPDATE honcho_receipts SET state='done',remote_id=$2,error_code=NULL,updated_at=now() WHERE id=$1 AND state='uncertain'",[id,String(found[0].id)]);
 return true;
}
export async function syncMemory(pool:pg.Pool,call:HonchoCall,jobId:string|null=null,authority:ExecutionAuthority) {
 const client=await pool.connect();let locked=false,fenced=false;
 try{
  fenced=await enterFamily(client,'honcho',authority.owner,authority.epoch);if(!fenced)return;
  locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended(current_schema(),803311)) AS locked')).rows[0].locked;if(!locked)return;
  const connection=(await memoryStatus(pool)).connection;if(!connection.attached||!connection.verified)return;
  // Reattachment first reconciles uncertain writes from retired generations.
  // Reads do not resurrect those workspaces or permit their model processing.
  const old=(await pool.query(`SELECT r.* FROM honcho_receipts r JOIN honcho_generations g ON g.id=r.generation
    WHERE r.state='uncertain' AND (g.guard_epoch<>(SELECT epoch FROM guard_state) OR g.policy_revision<>(SELECT revision FROM memory_policy_state))
    AND ($1::text IS NULL OR r.id=$1 OR g.id=$1) LIMIT 20`,[jobId])).rows;
  for(const job of old){try{const found=(await call('/v3/workspaces/'+job.generation+'/sessions/'+job.id+'/messages/list',{filters:{metadata:{nocheh_receipt:job.id}}})).items;
    if(!Array.isArray(found)||found.length!==1||found[0].content!==job.content.toString()||found[0].metadata?.nocheh_receipt!==job.id)return;
    await pool.query("UPDATE honcho_receipts SET state='done',remote_id=$2,error_code=NULL WHERE id=$1",[job.id,String(found[0].id)]);
   }catch{return;}}
  if(old.length===20)return;
  if(!jobId)await queueMemory(pool);
  const guard=await guardState(pool),policy=await policyRevision(pool);
  const jobs=(await pool.query(`SELECT r.* FROM honcho_receipts r JOIN honcho_generations g ON g.id=r.generation
   WHERE g.guard_epoch=$1 AND g.policy_revision=$2 AND g.state<>'retired' AND r.state<>'done' AND r.next_attempt<=now()
   AND ($3::text IS NULL OR r.id=$3 OR g.id=$3) ORDER BY r.created_at,r.id LIMIT 10`,[guard.epoch,policy,jobId])).rows;
  for(const job of jobs) {
   let attempted=false;
   try{
    await currentGeneration(pool,job.generation);
    const workspace='/v3/workspaces/'+job.generation,session=workspace+'/sessions/'+job.id;
    await call('/v3/workspaces',{id:job.generation});await call(workspace+'/peers',{id:'source'});
    await call(workspace+'/sessions',{id:job.id,peers:{source:{observe_me:true,observe_others:false}}});
    const previous=await call(session+'/messages/list',{filters:{metadata:{nocheh_receipt:job.id}}});
    let found=previous.items;
    if(!Array.isArray(found)||found.length>1)throw new HttpError(409,'honcho_receipt_conflict');
    if(!found.length) {
     if(job.state==='uncertain')throw new HttpError(409,'honcho_write_unresolved');
     await currentGeneration(pool,job.generation);
     // Persist uncertain BEFORE the remote mutation. A process restart always
     // reconciles and never blindly repeats a possibly committed message write.
     await pool.query("UPDATE honcho_receipts SET state='uncertain',attempts=attempts+1,updated_at=now() WHERE id=$1",[job.id]);attempted=true;
     found=await call(session+'/messages',{messages:[{peer_id:'source',content:job.content.toString(),metadata:{nocheh_receipt:job.id,source_revision:job.source_revision,guarded_revision:job.guarded_revision,audience:job.audience}}]});
    }
    if(!Array.isArray(found)||found.length!==1||found[0].content!==job.content.toString()||found[0].metadata?.nocheh_receipt!==job.id)throw new HttpError(409,'honcho_receipt_conflict');
    await currentGeneration(pool,job.generation);
    await pool.query("UPDATE honcho_receipts SET state='done',remote_id=$2,error_code=NULL,updated_at=now() WHERE id=$1",[job.id,String(found[0].id)]);
   }catch(error){await pool.query(`UPDATE honcho_receipts SET state=CASE WHEN state='uncertain' OR $3 THEN 'uncertain' ELSE 'pending' END,error_code=$2,next_attempt=now()+interval '60 seconds',updated_at=now() WHERE id=$1`,[job.id,error instanceof HttpError?error.code:'honcho_unavailable',attempted]);}
  }
  const generations=(await pool.query("SELECT * FROM honcho_generations WHERE guard_epoch=$1 AND policy_revision=$2 AND state<>'retired' AND ($3::text IS NULL OR id=$3 OR id=(SELECT generation FROM honcho_receipts WHERE id=$3))",[guard.epoch,policy,jobId])).rows;
  for(const generation of generations) {
   try{await currentGeneration(pool,generation.id);
    const pending=Number((await pool.query("SELECT count(*) AS count FROM honcho_receipts WHERE generation=$1 AND state<>'done'",[generation.id])).rows[0].count);
    const queue=await call('/v3/workspaces/'+generation.id+'/queue/status');
    const ready=!pending&&queue.pending_work_units===0&&queue.in_progress_work_units===0;
    await pool.query("UPDATE honcho_generations SET state=$2,error_code=NULL,last_ready_at=CASE WHEN $2='ready' THEN now() ELSE last_ready_at END WHERE id=$1 AND state<>'retired'",[generation.id,ready?'ready':'building']);
   }catch{await pool.query("UPDATE honcho_generations SET error_code='honcho_unavailable' WHERE id=$1",[generation.id]);}
  }
 }finally{await releaseOperation(client,async()=>{if(locked)await client.query('SELECT pg_advisory_unlock(hashtextextended(current_schema(),803311))');if(fenced)await leaveFamily(client,'honcho');});}
}
export async function recallMemory(pool:pg.Pool,principal:Reader,query:string,call:HonchoCall,detect:(text:string)=>Promise<unknown>) {
 await assertAudience(pool,principal);string(query,2000);
 const status=await memoryStatus(pool),audience=principal.scope===null?'owner':principal.space??principal.scope;
 const generation=status.generations.find(g=>g.audience===audience),limited={sources:[],limited_memory:true,syncing:generation?.state==='building',note:'Long-term memory is limited. Current context, native notes and archive search remain available.'};
 if(!status.connection.attached||!generation)return limited;
 try{
  await currentGeneration(pool,generation.id);const question=await prepareContext(pool,principal,query,detect);
  const result=await call('/v3/workspaces/'+generation.id+'/peers/source/chat',{query:question,reasoning_level:'low',stream:false});
  await currentGeneration(pool,generation.id);await assertAudience(pool,principal);
  const text=await prepareContext(pool,principal,string(result.content,20000),detect);
  const current=await currentGeneration(pool,generation.id),initializing=!current.last_ready_at&&current.state!=='ready';
  // An incremental upload does not make previously derived memory unavailable.
  // A new guard/policy generation has no readiness history and remains limited
  // until its first completed synchronization; real recall failures still fall back.
  return {sources:[{source:'nocheh:honcho:'+generation.id,kind:'memory_inference',text}],limited_memory:initializing,syncing:current.state==='building',...(initializing?{note:limited.note}:{})};
 }catch(error){await assertAudience(pool,principal);return limited;}
}

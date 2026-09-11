import type pg from 'pg';
import {digest} from './archive.js';
import {HttpError,object} from './http.js';
import type {RuntimeCall} from './runtime.js';
import type {Settings} from './config.js';
import {guardState,guardedValue} from './guarded.js';
import {allowPrepared} from './prepared-context.js';
import {turnToken} from './access.js';
import {policyRevision} from './spaces.js';
import {enterFamily,leaveFamily,releaseOperation,legacyAuthority,type ExecutionAuthority} from './workflows/store.js';

export const learningSchema=`
CREATE TABLE IF NOT EXISTS memory_learning_sources (event_id text PRIMARY KEY REFERENCES events(id), reason text NOT NULL, batch text, prepared boolean NOT NULL DEFAULT false, approved_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS memory_review_jobs (
 id text PRIMARY KEY,event_id text NOT NULL REFERENCES events(id),chunk_index integer NOT NULL,content text NOT NULL,input_hash text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','failed','paused','ambiguous')),
 attempts integer NOT NULL DEFAULT 0,generation integer NOT NULL DEFAULT 0,next_attempt timestamptz NOT NULL DEFAULT now(),
 error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE memory_learning_sources ADD COLUMN IF NOT EXISTS prepared_epoch bigint;
ALTER TABLE memory_review_jobs ADD COLUMN IF NOT EXISTS guard_epoch bigint;
`;
export async function approveLearning(pool:pg.Pool,input:unknown) {
  const body=object(input);
  if(body.approved!==true)throw new HttpError(400,'review_approval_required');
  if(!Array.isArray(body.event_ids)||!body.event_ids.length||body.event_ids.length>500||body.event_ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))throw new HttpError(400,'invalid_review_sources');
  const ids=[...new Set(body.event_ids as string[])],batch=typeof body.batch==='string'?body.batch.slice(0,256):null;
  const client=await pool.connect();try{await client.query('BEGIN');
    if((await client.query('SELECT id FROM events WHERE id=ANY($1::text[])',[ids])).rowCount!==ids.length)throw new HttpError(404,'review_source_missing');
    await client.query("INSERT INTO memory_learning_sources(event_id,reason,batch) SELECT unnest($1::text[]),'owner_approved',$2 ON CONFLICT DO NOTHING",[ids,batch]);
    await client.query('COMMIT');return {approved:ids.length};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function listReviews(pool:pg.Pool,after='') {
  const {rows}=await pool.query(`SELECT j.id,j.event_id,j.chunk_index,j.state,j.attempts,j.error_code,j.updated_at,s.reason,s.batch
   FROM memory_review_jobs j JOIN memory_learning_sources s USING(event_id) WHERE j.id>$1 ORDER BY j.id LIMIT 101`,[after]);
  return {jobs:rows.slice(0,100),next:rows.length>100?rows[99].id:null};
}
export async function controlReview(pool:pg.Pool,id:string,action:unknown) {
  if(!['pause','resume'].includes(String(action)))throw new HttpError(400,'invalid_review_action');
  const result=await pool.query(`UPDATE memory_review_jobs SET state=$2,error_code=NULL,next_attempt=now(),updated_at=now(),
    generation=generation+CASE WHEN state='ambiguous' THEN 1 ELSE 0 END WHERE id=$1 AND state NOT IN ('done','running') RETURNING id,state`,[id,action==='pause'?'paused':'pending']);
  if(!result.rowCount)throw new HttpError(409,'review_not_controllable');return result.rows[0];
}
export async function prepareReviews(pool:pg.Pool,live:boolean) {
  const guard=await guardState(pool);
  if(live)await pool.query(`INSERT INTO memory_learning_sources(event_id,reason)
    SELECT e.id,'live' FROM events e WHERE e.origin='live' AND
    (EXISTS(SELECT 1 FROM dispatches d WHERE d.event_id=e.id AND d.state='done') OR
     EXISTS(SELECT 1 FROM managed_runs r WHERE r.event_id=e.id AND r.state='done')) ON CONFLICT DO NOTHING`);
  const {rows}=await pool.query(`SELECT e.id,e.scope,e.original_text,e.payload,
    coalesce((SELECT string_agg(convert_from(content,'UTF8'),E'\n' ORDER BY id) FROM derived_artifacts WHERE event_id=e.id AND kind='transcript'),'') AS transcript
    FROM memory_learning_sources s JOIN events e ON e.id=s.event_id
    WHERE NOT s.prepared OR s.prepared_epoch IS DISTINCT FROM $1 ORDER BY s.approved_at LIMIT 20`,[guard.epoch]);
  for(const row of rows){
    let data={text:row.original_text?.toString()??'',payload:JSON.parse(row.payload.toString())},transcript=row.transcript;
    if(guard.mode==='on') {
      try {
        data=(await guardedValue(pool,'events:'+row.id)).value;
        const texts=[];for(const d of (await pool.query("SELECT id FROM derived_artifacts WHERE event_id=$1 AND kind='transcript' ORDER BY id",[row.id])).rows)texts.push((await guardedValue(pool,'derived_artifacts:'+d.id)).value.text);
        transcript=texts.join('\n');
      }catch(error){if(error instanceof HttpError&&error.code==='guard_preparation_pending')continue;throw error;}
    }
    const message=data.payload.message??{};
    const author=message.from?.id??message.from_id??message.from??'unknown';
    const prefix=`Source nocheh:event:${row.id}; conversation ${row.scope}; author ${JSON.stringify(author).slice(0,300)}.\n`;
    const text=(data.text??'')+(transcript?'\n[Derived STT transcript]\n'+transcript:'');
    const hash=digest(text);
    const client=await pool.connect();try{await client.query('BEGIN');
    for(let offset=0;offset<Math.max(1,text.length);offset+=8000){
      const id=digest(`hermes-native-review-v2:${guard.epoch}:${row.id}:${hash}:${offset}`);
      await client.query(`INSERT INTO memory_review_jobs(id,event_id,chunk_index,content,input_hash,state,guard_epoch) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [id,row.id,offset/8000,prefix+text.slice(offset,offset+8000),hash,text.trim()?'pending':'done',guard.epoch]);
    }
    await client.query('UPDATE memory_learning_sources SET prepared=true,prepared_epoch=$2 WHERE event_id=$1',[row.id,guard.epoch]);await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
}
export async function runReviewJobs(pool:pg.Pool,config:Settings,call:RuntimeCall,jobId:string|null=null,authority:ExecutionAuthority=legacyAuthority) {
  if(!config.assistant.owner_id)return;
  const client=await pool.connect();let locked=false,fenced=false;
  try{fenced=await enterFamily(client,'memory_review',authority.owner,authority.epoch);if(!fenced)return;
    locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended(current_schema(),803304)) AS locked')).rows[0].locked;if(!locked)return;
    if(!jobId)await prepareReviews(pool,config.assistant.enabled);
    const guard=await guardState(pool);
    const {rows}=await client.query("SELECT * FROM memory_review_jobs WHERE state IN ('pending','failed','running') AND next_attempt<=now() AND guard_epoch=$1 AND ($2::text IS NULL OR id=$2) ORDER BY created_at,id LIMIT 1",[guard.epoch,jobId]);
    const job=rows[0];if(!job)return;
    await client.query("UPDATE memory_review_jobs SET state='running',attempts=attempts+1,next_attempt=now()+interval '5 minutes',updated_at=now() WHERE id=$1",[job.id]);
    try{
      const policy={space:config.assistant.owner_id,revision:await policyRevision(pool),guard_epoch:guard.epoch};
      await allowPrepared(pool,{admin:false,scope:null,turnEvent:job.event_id,...policy},{text:job.content});
      const result=await call('memory.review',{id:digest(job.id+':'+job.generation),scope:config.assistant.owner_id,content:job.content,event_id:job.event_id,
        guard_mode:guard.mode,archive_credential:turnToken(config.token,null,Date.now()+600000,job.event_id,{...policy,purpose:'memory-review'})},240000);
      if((await guardState(pool)).epoch!==guard.epoch)throw new HttpError(409,'guard_context_changed');
      if(!['done','ambiguous'].includes(String(result.state)))throw new HttpError(503,'review_failed');
      await client.query('UPDATE memory_review_jobs SET state=$2,error_code=$3,updated_at=now() WHERE id=$1',[job.id,result.state,result.state==='ambiguous'?'review_interrupted':null]);
    }catch(error){await client.query("UPDATE memory_review_jobs SET state='failed',error_code=$2,next_attempt=now()+least(3600,30*power(2,least(attempts,7)))*interval '1 second',updated_at=now() WHERE id=$1",[job.id,error instanceof HttpError?error.code:'review_unavailable']);}
  }finally{await releaseOperation(client,async()=>{if(locked)await client.query('SELECT pg_advisory_unlock(hashtextextended(current_schema(),803304))');if(fenced)await leaveFamily(client,'memory_review');});}
}

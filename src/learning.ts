import type pg from 'pg';
import {digest} from './archive.js';
import {HttpError,object} from './http.js';
import type {RuntimeCall} from './runtime.js';
import type {Settings} from './config.js';

export const learningSchema=`
CREATE TABLE IF NOT EXISTS memory_learning_sources (event_id text PRIMARY KEY REFERENCES events(id), reason text NOT NULL, batch text, prepared boolean NOT NULL DEFAULT false, approved_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS memory_review_jobs (
 id text PRIMARY KEY,event_id text NOT NULL REFERENCES events(id),chunk_index integer NOT NULL,content text NOT NULL,input_hash text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','failed','paused','ambiguous')),
 attempts integer NOT NULL DEFAULT 0,generation integer NOT NULL DEFAULT 0,next_attempt timestamptz NOT NULL DEFAULT now(),
 error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
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
  if(live)await pool.query(`INSERT INTO memory_learning_sources(event_id,reason)
    SELECT e.id,'live' FROM events e JOIN dispatches d ON d.event_id=e.id
    WHERE d.state='done' AND e.origin='live' AND e.kind='telegram_update' ON CONFLICT DO NOTHING`);
  const {rows}=await pool.query(`SELECT e.id,e.scope,e.original_text,e.payload,
    coalesce((SELECT string_agg(convert_from(content,'UTF8'),E'\n' ORDER BY id) FROM derived_artifacts WHERE event_id=e.id AND kind='transcript'),'') AS transcript
    FROM memory_learning_sources s JOIN events e ON e.id=s.event_id
    WHERE NOT s.prepared ORDER BY s.approved_at LIMIT 20`);
  for(const row of rows){
    const message=JSON.parse(row.payload.toString()).message??{};
    const author=message.from?.id??message.from_id??message.from??'unknown';
    const prefix=`Source nocheh:event:${row.id}; conversation ${row.scope}; author ${JSON.stringify(author).slice(0,300)}.\n`;
    const text=(row.original_text?.toString()??'')+(row.transcript?'\n[Derived STT transcript]\n'+row.transcript:'');
    const hash=digest(text);
    const client=await pool.connect();try{await client.query('BEGIN');
    for(let offset=0;offset<Math.max(1,text.length);offset+=8000){
      const id=digest(`hermes-native-review-v1:${row.id}:${hash}:${offset}`);
      await client.query(`INSERT INTO memory_review_jobs(id,event_id,chunk_index,content,input_hash,state) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [id,row.id,offset/8000,prefix+text.slice(offset,offset+8000),hash,text.trim()?'pending':'done']);
    }
    await client.query('UPDATE memory_learning_sources SET prepared=true WHERE event_id=$1',[row.id]);await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
}
export async function runReviewJobs(pool:pg.Pool,config:Settings,call:RuntimeCall) {
  if(!config.assistant.owner_id)return;
  const client=await pool.connect();let locked=false;
  try{locked=(await client.query('SELECT pg_try_advisory_lock(803304) AS locked')).rows[0].locked;if(!locked)return;
    await prepareReviews(pool,config.assistant.enabled);
    const {rows}=await client.query("SELECT * FROM memory_review_jobs WHERE state IN ('pending','failed','running') AND next_attempt<=now() ORDER BY created_at,id LIMIT 1");
    const job=rows[0];if(!job)return;
    await client.query("UPDATE memory_review_jobs SET state='running',attempts=attempts+1,next_attempt=now()+interval '5 minutes',updated_at=now() WHERE id=$1",[job.id]);
    try{
      const result=await call('memory.review',{id:digest(job.id+':'+job.generation),scope:config.assistant.owner_id,content:job.content,event_id:job.event_id},240000);
      if(!['done','ambiguous'].includes(String(result.state)))throw new HttpError(503,'review_failed');
      await client.query('UPDATE memory_review_jobs SET state=$2,error_code=$3,updated_at=now() WHERE id=$1',[job.id,result.state,result.state==='ambiguous'?'review_interrupted':null]);
    }catch(error){await client.query("UPDATE memory_review_jobs SET state='failed',error_code=$2,next_attempt=now()+least(3600,30*power(2,least(attempts,7)))*interval '1 second',updated_at=now() WHERE id=$1",[job.id,error instanceof HttpError?error.code:'review_unavailable']);}
  }finally{if(locked)await client.query('SELECT pg_advisory_unlock(803304)');client.release();}
}

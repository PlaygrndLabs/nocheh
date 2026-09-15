import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {initialize} from '../src/database.js';
import {ingest,type Envelope} from '../src/archive.js';
import {approveLearning,prepareReviews,runReviewJobs,controlReview} from '../src/learning.js';
import {settings} from '../src/config.js';
import {HttpError} from '../src/http.js';

test('real PostgreSQL: explicit import consent, complete chunking, retries and durable pause/resume',{skip:!process.env.PGHOST},async()=>{
 const admin=new pg.Pool(),namespace=`learning_${Date.now()}`;await admin.query(`CREATE SCHEMA ${namespace}`);
 const pool=new pg.Pool({options:`-c search_path=${namespace}`});
 const config={...settings(),assistant:{enabled:false,owner_id:'123',group_ids:[]}};
 try{await initialize(pool);
  const value:Envelope={version:1,key:'import:learning',scope:'-20',bot_id:'fixture',source_id:'1',revision:'1',origin:'import',kind:'telegram_update',occurred_at:null,text:'Archived fact. '.repeat(1400),payload:{message:{from:{id:456}}}};
  const {id}=await ingest(pool,value);await prepareReviews(pool,true);
  assert.equal((await pool.query('SELECT count(*) FROM memory_review_jobs')).rows[0].count,'0');
  await assert.rejects(approveLearning(pool,{approved:false,event_ids:[id]}),{code:'review_approval_required'});
  await approveLearning(pool,{approved:true,event_ids:[id],batch:'approved-import'});
  await prepareReviews(pool,false);const jobs=(await pool.query('SELECT * FROM memory_review_jobs ORDER BY chunk_index')).rows;
  assert.equal(jobs.length,3);assert.equal(jobs.map(j=>j.content.split('\n').slice(1).join('\n')).join(''),value.text);
  await approveLearning(pool,{approved:true,event_ids:[id]});await prepareReviews(pool,false);
  assert.equal((await pool.query('SELECT count(*) FROM memory_review_jobs')).rows[0].count,'3');
  await runReviewJobs(pool,config,async()=>({state:'waiting',error_code:'profile_busy'}),undefined,{owner:'inngest',epoch:1});
  const deferred=(await pool.query("SELECT state,attempts,error_code FROM memory_review_jobs WHERE error_code='waiting_for_profile'")).rows[0];
  assert.deepEqual(deferred,{state:'pending',attempts:0,error_code:'waiting_for_profile'});
  await pool.query('UPDATE memory_review_jobs SET next_attempt=now()');
  // Another runner for this archive must not overlap. A live worker in another
  // schema (including the older database-wide lock) must not suppress this one.
  let calls=0;const held=await pool.connect(),other=await admin.connect();let legacyHeld=false;
  try{
   await held.query('SELECT pg_advisory_lock(hashtextextended(current_schema(),803304))');
   await runReviewJobs(pool,config,async()=>{calls++;return {state:'done'};},undefined,{owner:'inngest',epoch:1});
   assert.equal(calls,0,'the same archive permits only one review runner');
   await held.query('SELECT pg_advisory_unlock(hashtextextended(current_schema(),803304))');
   legacyHeld=(await other.query('SELECT pg_try_advisory_lock(803304) AS locked')).rows[0].locked;
   await other.query('SELECT pg_advisory_lock(hashtextextended(current_schema(),803304))');
   await runReviewJobs(pool,config,async()=>{calls++;throw new HttpError(429,'quota_paused');},undefined,{owner:'inngest',epoch:1});
   assert.equal(calls,1,'another archive cannot suppress the review');
  }finally{
   await held.query('SELECT pg_advisory_unlock_all()');held.release();
   if(legacyHeld)await other.query('SELECT pg_advisory_unlock(803304)');
   await other.query('SELECT pg_advisory_unlock(hashtextextended(current_schema(),803304))');other.release();
  }
  assert.equal((await pool.query("SELECT error_code FROM memory_review_jobs WHERE state='failed'")).rows[0].error_code,'quota_paused');
  const pending=(await pool.query("SELECT id FROM memory_review_jobs WHERE state='pending' LIMIT 1")).rows[0].id;
  await controlReview(pool,pending,'pause');assert.equal((await pool.query('SELECT state FROM memory_review_jobs WHERE id=$1',[pending])).rows[0].state,'paused');
  await controlReview(pool,pending,'resume');
  await pool.query('UPDATE memory_review_jobs SET next_attempt=now()');
  for(let i=0;i<4;i++)await runReviewJobs(pool,config,async(op,b)=>{assert.equal(op,'memory.review');assert.equal(b.scope,'123');assert.match(String(b.content),new RegExp(id));calls++;return {state:'done'};},undefined,{owner:'inngest',epoch:1});
  assert.equal(calls,4);assert.equal((await pool.query("SELECT count(*) FROM memory_review_jobs WHERE state='done'")).rows[0].count,'3');
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();}
});

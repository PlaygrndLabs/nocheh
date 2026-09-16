import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {initialize} from '../src/database.js';
import {requestWorkflow} from '../src/workflows/store.js';
import {workflowMetrics} from '../src/workflows/metrics.js';
import {settings} from '../src/config.js';
test('workflow metrics use bounded, confirmed, content-free registry evidence',async()=>{
 const connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:settings().databasePassword};
 const admin=new pg.Pool(connection),schema='metrics_'+Date.now();await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({...connection,options:`-c search_path=${schema}`}),now=new Date('2026-09-16T12:30:00Z');
 try{
  await initialize(pool);
  const empty=await workflowMetrics(pool,{},now);assert.equal(empty.buckets.length,25);assert.ok(empty.buckets.every(b=>b.admitted===0&&b.completion_ms_p50===null));
  assert.equal(empty.from,'2026-09-15T12:30:00.000Z');assert.equal(empty.buckets[0]!.start,empty.from);assert.equal(empty.buckets.at(-1)!.end,empty.to);
  const c=await pool.connect();let completed:string;
  try{
   completed=await requestWorkflow(c,'browser','private-source-canary');
   assert.equal(await requestWorkflow(c,'browser','private-source-canary'),completed);
   for(const [job,family,state,created,updated] of [
    ['private-source-canary','browser','completed','2026-09-16T10:00:00Z','2026-09-16T10:01:00Z'],
    ['other','browser','completed','2026-09-16T10:00:00Z','2026-09-16T10:03:00Z'],
    ['retry','browser','retryable_failed','2026-09-16T10:00:00Z','2026-09-16T10:02:00Z'],
    ['failed','tools','failed','2026-09-16T10:00:00Z','2026-09-16T10:04:00Z'],
    ['ambiguous','tools','ambiguous','2026-09-16T10:00:00Z','2026-09-16T10:05:00Z'],
    ['skipped','tools','skipped','2026-09-16T10:00:00Z','2026-09-16T10:06:00Z'],
    ['start','telegram','queued','2026-09-15T12:30:00Z','2026-09-15T12:30:00Z'],
    ['outside','telegram','queued','2026-09-15T12:29:59Z','2026-09-15T12:29:59Z'],
    ['end','telegram','queued','2026-09-16T12:30:00Z','2026-09-16T12:30:00Z'],
    ['older','imports','completed','2026-09-10T06:00:00Z','2026-09-10T06:10:00Z']
   ] as const){const id=await requestWorkflow(c,family,job);await c.query('UPDATE workflow_registry SET state=$2,created_at=$3,updated_at=$4 WHERE id=$1',[id,state,created,updated]);}
  }finally{c.release();}
  const result=await workflowMetrics(pool,{},now),totals=result.buckets.reduce((a,b)=>({admitted:a.admitted+b.admitted,completed:a.completed+b.completed,failed:a.failed+b.terminal_failed}),{admitted:0,completed:0,failed:0});
  assert.deepEqual(totals,{admitted:7,completed:2,failed:1});
  const bucket=result.buckets.find(b=>b.completed===2)!;assert.equal(bucket.completion_samples,2);assert.equal(bucket.completion_ms_p50,120000);assert.equal(bucket.completion_ms_p95,174000);
  assert.equal((await workflowMetrics(pool,{family:'tools'},now)).buckets.reduce((n,b)=>n+b.completed,0),0);
  const week=await workflowMetrics(pool,{range:'7d'},now);assert.equal(week.bucket_seconds,21600);assert.equal(week.buckets.length,29);assert.equal(week.buckets.reduce((n,b)=>n+b.completed,0),3);
  const aligned=await workflowMetrics(pool,{},new Date('2026-09-16T12:00:00Z'));assert.equal(aligned.buckets.length,24);
  await assert.rejects(workflowMetrics(pool,{range:'30d'},now),/invalid_metrics_range/);await assert.rejects(workflowMetrics(pool,{family:'arbitrary'},now),/invalid_workflow_filter/);
  const encoded=JSON.stringify(result);for(const privateValue of ['private-source-canary','lease_token','receipt_id','source_event_id'])assert.ok(!encoded.includes(privateValue));
  // Receipts or domain success alone cannot invent a registry completion.
  await pool.query("UPDATE workflow_registry SET state='running' WHERE id=$1",[completed]);
  assert.equal((await workflowMetrics(pool,{},now)).buckets.reduce((n,b)=>n+b.completed,0),1);
  // Completion measures the entire admission-to-confirmation interval, including retry waits.
  await pool.query("UPDATE workflow_registry SET state='completed',attempts=4,created_at='2026-09-12T11:00:00Z',updated_at='2026-09-16T11:00:00Z' WHERE id=$1",[completed]);
  const long=await workflowMetrics(pool,{family:'browser'},now),durationBucket=long.buckets.find(b=>b.start==='2026-09-16T11:00:00.000Z')!;
  assert.equal(durationBucket.completion_ms_p50,4*86400000);assert.equal(durationBucket.completion_samples,1);assert.equal(durationBucket.admitted,0);
  // A corrupt negative elapsed time remains an outcome without inventing a duration sample.
  await pool.query("UPDATE workflow_registry SET created_at='2026-09-16T11:01:00Z' WHERE id=$1",[completed]);
  const negative=(await workflowMetrics(pool,{family:'browser'},now)).buckets.find(b=>b.start==='2026-09-16T11:00:00.000Z')!;
  assert.equal(negative.completed,1);assert.equal(negative.completion_samples,0);assert.equal(negative.completion_ms_p95,null);
  const weekAligned=await workflowMetrics(pool,{range:'7d'},new Date('2026-09-16T12:00:00Z'));assert.equal(weekAligned.buckets.length,28);assert.equal(weekAligned.buckets[0]!.start,'2026-09-09T12:00:00.000Z');
  // Browser refresh/restart sees the same persisted identity, not an in-memory sample.
  const repeat=await workflowMetrics(pool,{},now);assert.deepEqual(repeat,await workflowMetrics(pool,{},now));
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});

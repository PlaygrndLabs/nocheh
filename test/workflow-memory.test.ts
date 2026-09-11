import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {settings} from '../src/config.js';
import {initialize} from '../src/database.js';
import {ingest,type Envelope} from '../src/archive.js';
import {approveLearning} from '../src/learning.js';
import {prepareGuarded,setGuardMode,editGuarded} from '../src/guarded.js';
import {memoryStatus} from '../src/honcho.js';
import {pauseFamily,switchFamily,requestWorkflow} from '../src/workflows/store.js';
import {memoryOperations} from '../src/workflows/memory.js';
import {advanceWorkflow} from '../src/workflows/engine.js';

test('memory requests preserve consent, native receipt identity, owner revisions and read-only Honcho reconciliation',{skip:!process.env.PGHOST},async()=>{
  const config={...settings(),assistant:{enabled:true,owner_id:'123',group_ids:[] as string[]}};
  const options={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:config.databasePassword};
  const admin=new pg.Pool(options),namespace='workflow_memory_'+Date.now();await admin.query(`CREATE SCHEMA ${namespace}`);
  const pool=new pg.Pool({...options,options:`-c search_path=${namespace}`,max:8});
  const calls:string[]=[],saved=new Map<string,any[]>();let writes=0,reads=0;
  const ops=memoryOperations(pool,config,async(operation,body)=>{
    assert.equal(operation,'memory.review');calls.push(String(body.id));if(calls.length===1)throw Error('synthetic lost receipt response');return {state:'done'};
  },async(path,body:any)=>{
    if(path.endsWith('/messages/list')){reads++;return {items:saved.get(path.slice(0,-5))??[]};}
    if(path.endsWith('/messages')){writes++;saved.set(path,body.messages.map((m:any)=>({...m,id:'remote-fixture'})));throw Error('synthetic lost write acknowledgment');}
    if(path.endsWith('/queue/status'))return {pending_work_units:0,in_progress_work_units:0};
    return {};
  });
  const authority={owner:'inngest' as const,epoch:2};
  const source:Envelope={version:1,key:'import:workflow-memory',origin:'import',bot_id:'fixture',kind:'message',scope:'123',source_id:'1',revision:'1',occurred_at:null,text:'Consented synthetic history',payload:{message:{from:{id:123}}}};
  try {
    await initialize(pool);await setGuardMode(pool,'on');const event=await ingest(pool,source);
    await prepareGuarded(pool,async()=>[],'fixture',100,event.id);
    for(const family of ['memory_review','honcho'] as const){await pauseFamily(pool,family,1);await switchFamily(pool,family,1,'inngest');}
    assert.equal((await ops.memory_review!('source:'+event.id,authority)).state,'denied');assert.equal(calls.length,0);
    assert.equal((await ops.honcho!('refresh',authority)).state,'waiting');assert.equal(reads+writes,0,'detached Honcho cannot execute');
    const client=await pool.connect();try {
      const ts=await requestWorkflow(client,'memory_review','identity:quotes"é');
      assert.equal((await client.query("SELECT nocheh_workflow_request('memory_review',$1) AS id",['identity:quotes"é'])).rows[0].id,ts,'SQL and TypeScript use the same permanent identity');
      await client.query('BEGIN');await client.query("INSERT INTO memory_learning_sources(event_id,reason) VALUES($1,'owner_approved')",[event.id]);await client.query('ROLLBACK');
      assert.equal((await pool.query('SELECT count(*) FROM memory_learning_sources')).rows[0].count,'0');
    }finally{client.release();}
    await approveLearning(pool,{approved:true,event_ids:[event.id]});
    assert.equal((await ops.memory_review!('source:'+event.id,authority)).state,'completed');
    const review=(await pool.query('SELECT id FROM memory_review_jobs')).rows[0].id;
    assert.equal((await ops.memory_review!('review:'+review,authority)).state,'retryable_failed');
    await pool.query('UPDATE memory_review_jobs SET next_attempt=now()');
    assert.equal((await ops.memory_review!('review:'+review,authority)).state,'completed');
    assert.equal(calls[0],calls[1],'native memory receipt ID survives retry');
    assert.equal((await pool.query('SELECT state FROM dispatches WHERE event_id=$1',[event.id])).rows[0].state,'suppressed','history never replies');
    await editGuarded(pool,{admin:true,scope:null},event.id,{source_id:'events:'+event.id,expected_revision:1,content:{text:'Owner revised synthetic history',payload:source.payload}});
    assert.equal((await ops.memory_review!('review:'+review,authority)).state,'skipped','stale generation cannot run');
    assert.equal((await ops.memory_review!('source:'+event.id,authority)).state,'completed');
    assert.equal((await pool.query('SELECT count(*) FROM memory_review_jobs')).rows[0].count,'2');
    await memoryStatus(pool);
    await pool.query("UPDATE honcho_connection SET attached=true,verified=true,include_history=true,attached_at=now()-interval '1 day'");
    await ops.honcho!('refresh',authority);
    const receipt=(await pool.query('SELECT id FROM honcho_receipts LIMIT 1')).rows[0].id;
    const request=async(job:string)=> (await pool.query("SELECT id,dispatch FROM workflow_registry WHERE family='honcho' AND job_id=$1 ORDER BY generation DESC LIMIT 1",[job])).rows[0];
    const original=await request('receipt:'+receipt);
    assert.equal((await advanceWorkflow(pool,original.id,original.dispatch,'honcho','fixture-write',ops.honcho!)).state,'ambiguous');assert.equal(writes,1);
    const reconcile=await request('reconcile:'+receipt);assert.ok(reconcile);
    assert.equal((await advanceWorkflow(pool,reconcile.id,reconcile.dispatch,'honcho','fixture-reconcile',ops.honcho!)).state,'completed');
    assert.equal(writes,1,'reconciliation cannot repeat the write');
    assert.equal((await pool.query('SELECT state FROM workflow_registry WHERE id=$1',[original.id])).rows[0].state,'completed');
    await advanceWorkflow(pool,original.id,original.dispatch,'honcho','fixture-duplicate',ops.honcho!);assert.equal(writes,1);
    await pool.query('DELETE FROM memory_learning_sources WHERE event_id=$1',[event.id]);
    const latest=(await pool.query('SELECT id FROM memory_review_jobs ORDER BY created_at DESC LIMIT 1')).rows[0].id;
    assert.equal((await ops.memory_review!('review:'+latest,authority)).state,'denied');
    assert.equal((await ops.honcho!('receipt:'+receipt,authority)).state,'denied');
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();}
});

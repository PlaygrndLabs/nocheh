import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {settings} from '../src/config.js';
import {initialize,heartbeat} from '../src/database.js';
import {requestWorkflow,registerWorker,publishOutbox,enterFamily,leaveFamily,claimWorkflow} from '../src/workflows/store.js';
import {listWorkflows,workflowDetail,workflowHealth,controlWorkflow} from '../src/workflows/owner.js';
import {captureInput,claimRun,finishRun} from '../src/managed-runs.js';
import {admitBrowser} from '../src/workflows/browser.js';
import {controlReview} from '../src/learning.js';

test('owner workflow metadata preserves cursor precision, domain truth and stale worker observations',{skip:!process.env.PGHOST},async()=>{
  const config=settings(),connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:config.databasePassword};
  config.assistant={enabled:false,owner_id:'42',group_ids:[]};
  const admin=new pg.Pool(connection),schema='workflow_owner_'+Date.now();await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({...connection,options:`-c search_path=${schema}`});
  try {
    await initialize(pool);
    const client=await pool.connect(),ids:string[]=[];
    try{for(let i=1;i<=3;i++)ids.push(await requestWorkflow(client,'tools',String(i).repeat(64)));}finally{client.release();}
    for(const [index,id] of ids.entries())await pool.query("UPDATE workflow_registry SET created_at='2026-09-12T00:00:00.000001Z'::timestamptz+($2*interval '1 microsecond') WHERE id=$1",[id,index]);
    const first=await listWorkflows(pool,{family:'tools',limit:1});assert.equal(first.workflows[0]!.id,ids[2]);
    const second=await listWorkflows(pool,{family:'tools',limit:1,after:first.next});assert.equal(second.workflows[0]!.id,ids[1]);
    const third=await listWorkflows(pool,{family:'tools',limit:1,after:second.next});assert.equal(third.workflows[0]!.id,ids[0]);assert.equal(third.next,null);
    assert.notEqual(first.workflows[0]!.control_reason,'legacy_owner');
    await assert.rejects(listWorkflows(pool,{state:'raw SQL'}),/invalid_workflow_filter/);
    await assert.rejects(listWorkflows(pool,{after:'not-a-cursor'}),/invalid_workflow_cursor/);
    const source={scope:'42',profile:'owner',conversation:'native-session',id:'turn',text:'Owner metadata source canary'};
    const captured=await captureInput(pool,config,source);await admitBrowser(pool,config,{...source,event_id:captured.event_id});
    const claim={scope:'42',profile:'owner',event_id:captured.event_id,actor:'legacy'};
    await claimRun(pool,config,claim,undefined,{owner:'inngest',epoch:1});await finishRun(pool,{...claim,state:'done',session:'native-session',text:'Owner metadata result canary'});
    const browser=(await listWorkflows(pool,{family:'browser',state:'completed'})).workflows[0]!;
    assert.equal(browser.registry_state,'queued');assert.equal(browser.state,'completed');assert.equal(browser.can_retry,false);
    const detail=await workflowDetail(pool,browser.id);assert.equal(detail.source_event_id,captured.event_id);assert.equal(detail.outbox.length,1);
    assert.ok(!JSON.stringify(detail).includes('canary'));assert.ok(!JSON.stringify(detail).includes('lease_token'));
    await registerWorker(pool,'pipeline',['browser']);await heartbeat(pool,'workflow-pipeline');
    let health=await workflowHealth(pool);assert.equal(health.workers.find(row=>row.family==='browser').connected,true);
    assert.equal(health.services.find(row=>row.service==='workflow-pipeline').fresh,true);
    await pool.query("UPDATE workflow_worker_registrations SET seen_at=now()-interval '2 minutes'");
    await pool.query("UPDATE service_heartbeats SET seen_at=now()-interval '2 minutes' WHERE service='workflow-pipeline'");
    health=await workflowHealth(pool);assert.equal(health.workers.find(row=>row.family==='browser').connected,false);
    assert.equal(health.services.find(row=>row.service==='workflow-pipeline').fresh,false);
    assert.ok(health.counts.some(row=>row.family==='browser'&&row.state==='completed'&&row.count===1));
    assert.ok(health.outbox.admitted>0,'all fresh workflow families are admitted to Inngest');assert.ok(health.outbox.pending>0);
    assert.ok(!JSON.stringify(health).includes('canary'));
    assert.equal(health.last_success_at,null,'domain completion alone has no confirmed workflow completion time');
    await pool.query("UPDATE workflow_registry SET state='completed',updated_at='2026-09-15T12:00:00Z' WHERE id=$1",[ids[1]]);
    await pool.query("UPDATE workflow_registry SET state='skipped',updated_at='2026-09-16T12:00:00Z' WHERE id=$1",[ids[2]]);
    health=await workflowHealth(pool);
    assert.equal(health.last_success_at.toISOString(),'2026-09-15T12:00:00.000Z','newer skipped work does not replace the last success');
    assert.ok(health.counts.some(row=>row.family==='tools'&&row.state==='completed'&&row.count===1));

    // A retry changes publication, never the effect identity or attempt count.
    await pool.query("UPDATE workflow_owners SET owner='inngest' WHERE family='tools'");
    await pool.query("INSERT INTO controlled_actions(id,event_id,scope,profile,kind,arguments,fingerprint,state) VALUES($1,$2,'42','owner','shell',$3,$1,'approved')",['1'.repeat(64),captured.event_id,Buffer.from('{"command":"private argument canary"}')]);
    const id=ids[0]!;
    await pool.query("UPDATE workflow_registry SET state='retryable_failed',attempts=3,next_attempt=now()+interval '1 hour' WHERE id=$1",[id]);
    const fence=await pool.connect();
    try{
      assert.equal(await enterFamily(fence,'tools','inngest',1),true);
      await assert.rejects(controlWorkflow(pool,id,'retry',{revision:1}),/workflow_execution_in_progress/);
    }finally{await leaveFamily(fence,'tools');fence.release();}
    const retried=await controlWorkflow(pool,id,'retry',{revision:1});
    assert.equal(retried.id,id);assert.equal(retried.dispatch,2);assert.equal(retried.attempts,3);
    const repeated=await controlWorkflow(pool,id,'retry',{revision:1});assert.equal(repeated.dispatch,2);assert.equal(repeated.controls.length,1);
    assert.ok(!JSON.stringify(repeated).includes('canary'));
    await assert.rejects(controlWorkflow(pool,id,'cancel',{revision:1}),/workflow_revision_changed/);
    await registerWorker(pool,'host',['tools']);
    const delivered:number[]=[];await publishOutbox(pool,async e=>{if(e.data.workflow_id===id)delivered.push(e.data.dispatch);});assert.deepEqual(delivered,[2]);
    const claimant=await pool.connect();try{assert.ok(await claimWorkflow(claimant,id,2,'owner-control-test',1));}finally{claimant.release();}
    await assert.rejects(controlWorkflow(pool,id,'cancel',{revision:2}),/workflow_execution_in_progress/);
    await pool.query('UPDATE workflow_registry SET lease_token=NULL,lease_until=NULL WHERE id=$1',[id]);
    await pool.query("INSERT INTO workflow_receipts(workflow_id,step,attempt,state) VALUES($1,'tool',1,'started')",[id]);
    await assert.rejects(controlWorkflow(pool,id,'cancel',{revision:2}),/workflow_receipt_closed/);
    await pool.query("DELETE FROM workflow_receipts WHERE workflow_id=$1",[id]);
    const cancelled=await controlWorkflow(pool,id,'cancel',{revision:2});assert.equal(cancelled.state,'cancelled');
    assert.equal((await pool.query('SELECT state FROM controlled_actions WHERE id=$1',['1'.repeat(64)])).rows[0].state,'rejected');
    assert.equal((await controlWorkflow(pool,id,'cancel',{revision:2})).revision,3);
    await assert.rejects(controlWorkflow(pool,id,'retry',{revision:3}),/workflow_closed/);
    assert.equal(await publishOutbox(pool,async()=>{throw Error('closed work must not publish');}),0);
    await pool.query("UPDATE workflow_owners SET owner='inngest' WHERE family='memory_review'");
    await pool.query("INSERT INTO memory_review_jobs(id,event_id,chunk_index,content,input_hash) VALUES($1,$2,0,'private review canary',$1)",['b'.repeat(64),captured.event_id]);
    const review=(await listWorkflows(pool,{family:'memory_review'})).workflows.find(row=>row.job_id==='review:'+'b'.repeat(64))!;
    await controlWorkflow(pool,review.id,'cancel',{revision:review.revision});
    await controlReview(pool,'b'.repeat(64),'resume');
    const generations=(await pool.query("SELECT generation,state FROM workflow_registry WHERE family='memory_review' AND job_id=$1 ORDER BY generation",['review:'+'b'.repeat(64)])).rows;
    assert.deepEqual(generations,[{generation:1,state:'cancelled'},{generation:2,state:'queued'}]);
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});

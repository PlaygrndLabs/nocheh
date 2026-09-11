import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {settings} from '../src/config.js';
import {initialize} from '../src/database.js';
import {ingest,type Envelope} from '../src/archive.js';
import {requestWorkflow,publishOutbox,pauseFamily,switchFamily,enterFamily,leaveFamily,claimWorkflow,beginEffect,finishEffect,hash,type WorkflowEvent} from '../src/workflows/store.js';
import {safeMetadata,WorkflowBoundary} from '../src/workflows/boundary.js';
import {workflowClient} from '../src/workflows/client.js';

test('workflow boundary rejects content, credentials, step inputs and error causes',async()=>{
  const canary='private-source-secret';
  for(const value of [{text:canary},{prompt:canary},{state:canary},{id:canary},[canary],canary])assert.throws(()=>safeMetadata(value));
  safeMetadata({workflow_id:hash('fixture'),state:'waiting',waiting_reason:'prerequisite',count:1});
  const client=workflowClient('pipeline',{baseUrl:'http://localhost:8288',gatewayUrl:'ws://localhost:8289/v0/connect',eventKey:'a'.repeat(64),signingKey:'b'.repeat(64),version:'1'});
  const middleware=new WorkflowBoundary({client});
  await assert.rejects(middleware.wrapStepHandler({next:async()=>{throw Error(canary);}} as never),error=>!JSON.stringify(error).includes(canary)&&!String((error as Error).stack).includes(canary));
  await assert.rejects(middleware.wrapStepHandler({next:async()=>({text:canary})} as never),/workflow_execution_stopped/);
  assert.throws(()=>middleware.transformStepInput({input:[canary]} as never),/arguments_denied/);
  assert.throws(()=>middleware.transformSendEvent({events:[{name:'nocheh/workflow.requested',id:hash('event'),data:{workflow_id:hash('job')},user:{email:canary}}]} as never),/event_denied/);
});

test('transactional outbox, permanent identity, lost acknowledgments, publisher recovery and ownership fencing', {skip:!process.env.PGHOST},async()=>{
  const connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:settings().databasePassword};
  const admin=new pg.Pool(connection),namespace='workflow_'+Date.now();
  await admin.query(`CREATE SCHEMA ${namespace}`);
  const pool=new pg.Pool({...connection,options:`-c search_path=${namespace}`,max:8});
  const client=await pool.connect();
  try {
    await initialize(pool);
    await client.query('BEGIN');await requestWorkflow(client,'telegram',hash('rolled-back'));await client.query('ROLLBACK');
    assert.equal((await pool.query('SELECT count(*) FROM workflow_outbox')).rows[0].count,'0');
    const value:Envelope={version:1,key:'workflow:fixture',origin:'live',channel:'telegram',bot_id:'fixture',kind:'telegram_update',scope:'123',source_id:'1',revision:'1',occurred_at:null,text:'private-canary',payload:{message:{text:'private-canary'}}};
    await pool.query(`CREATE FUNCTION reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_rollback'; END; $$;
      CREATE TRIGGER reject_outbox BEFORE INSERT ON workflow_outbox FOR EACH ROW EXECUTE FUNCTION reject_outbox()`);
    await assert.rejects(ingest(pool,value),/synthetic_rollback/);
    assert.equal((await pool.query('SELECT count(*) FROM events')).rows[0].count,'0','capture cannot commit without durable handoff');
    await pool.query('DROP TRIGGER reject_outbox ON workflow_outbox; DROP FUNCTION reject_outbox()');
    await ingest(pool,value);await ingest(pool,value);
    assert.equal((await pool.query('SELECT count(*) FROM workflow_outbox')).rows[0].count,'2');
    const id=await requestWorkflow(client,'telegram',hash(value.key));
    const sent:WorkflowEvent[]=[];
    assert.equal(await publishOutbox(pool,async e=>{sent.push(e);}),0,'legacy family never publishes');
    assert.equal(await enterFamily(client,'telegram','legacy'),true);
    await pauseFamily(pool,'telegram',1);
    await assert.rejects(switchFamily(pool,'telegram',1,'inngest'),{code:'workflow_family_not_drained'});
    await leaveFamily(client,'telegram');
    assert.equal(await switchFamily(pool,'telegram',1,'inngest'),2);
    assert.equal(await enterFamily(client,'telegram','legacy'),false);
    assert.equal(await enterFamily(client,'telegram','inngest',1),false);
    assert.equal(await publishOutbox(pool,async e=>{sent.push(e);throw Error('lost acknowledgement private-canary');}),0);
    await pool.query('UPDATE workflow_outbox SET next_attempt=now()');
    await publishOutbox(pool,async e=>{sent.push(e);});
    assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);
    assert.ok(!JSON.stringify(sent).includes('private-canary'));
    assert.equal((await pool.query('SELECT error_code FROM workflow_outbox WHERE workflow_id=$1',[id])).rows[0].error_code,null);
    // A crashed publisher's expired lease is recovered by another publisher.
    await pool.query("UPDATE workflow_outbox SET published_at=NULL,lease_until=now()-interval '1 second' WHERE workflow_id=$1",[id]);
    await Promise.all([publishOutbox(pool,async e=>{sent.push(e);}),publishOutbox(pool,async e=>{sent.push(e);})]);
    assert.equal(sent.length,3);
    const claim=await claimWorkflow(client,id,1,'fixture-run-one',2);assert.ok(claim);
    assert.equal(await claimWorkflow(client,id,1,'fixture-run-two',2),null,'concurrent delivery cannot claim');
    const racers=await Promise.all([beginEffect(client,id,claim.lease_token,'action',1),beginEffect(client,id,claim.lease_token,'action',2)]);
    assert.equal(racers.filter(r=>r.execute).length,1);
    await finishEffect(client,id,'action',racers.findIndex(r=>r.execute)+1,'done',hash('action-receipt'));
    assert.deepEqual(await beginEffect(client,id,claim.lease_token,'delivery',1),{execute:true,state:'started'});
    // Crash after an external effect but before checkpoint/receipt publication.
    await pool.query("UPDATE workflow_registry SET lease_until=now()-interval '1 second' WHERE id=$1",[id]);
    const resumed=await claimWorkflow(client,id,1,'fixture-run-two',2);assert.ok(resumed);
    assert.equal((await beginEffect(client,id,resumed.lease_token,'delivery',1)).execute,false);
    assert.equal((await beginEffect(client,id,resumed.lease_token,'delivery',2)).execute,false,'a different attempt cannot bypass an uncertain effect');
    await pauseFamily(pool,'telegram',2);
    await assert.rejects(switchFamily(pool,'telegram',2,'legacy'),{code:'workflow_receipts_unreconciled'});
    await finishEffect(client,id,'delivery',1,'done',hash('native-receipt'));
    await finishEffect(client,id,'delivery',1,'done',hash('native-receipt'));
    await assert.rejects(finishEffect(client,id,'delivery',1,'done',hash('different-receipt')),{code:'workflow_receipt_conflict'});
    await pool.query("UPDATE workflow_registry SET state='completed',lease_token=NULL,lease_until=NULL,created_at=now()-interval '2 days' WHERE id=$1",[id]);
    assert.equal(await switchFamily(pool,'telegram',2,'legacy'),3);
    await pauseFamily(pool,'telegram',3);await switchFamily(pool,'telegram',3,'inngest');
    assert.equal(await requestWorkflow(client,'telegram',hash(value.key)),id);
    assert.equal(await claimWorkflow(client,id,1,'delayed-duplicate',4),null,'closed identity survives event dedup window and rollback');
    assert.equal((await pool.query('SELECT count(*) FROM workflow_runs')).rows[0].count,'2');
    for(const state of ['failed','cancelled','denied','ambiguous','skipped']) {
      await pool.query('UPDATE workflow_registry SET state=$2 WHERE id=$1',[id,state]);
      assert.equal(await claimWorkflow(client,id,1,'closed-'+state,4),null);
    }
  }finally{client.release();await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();}
});

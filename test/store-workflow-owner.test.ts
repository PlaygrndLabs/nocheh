import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {controlStorageWorkflow} from '../src/stores/workflow-owner.js';
import {listWorkflows,workflowDetail,workflowHealth} from '../src/workflows/owner.js';
import {workflowMetrics} from '../src/workflows/metrics.js';
import {enterFamily,leaveFamily,requestWorkflow} from '../src/workflows/store.js';

test('owner workflow inspection and receipt-aware controls use control storage only',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-workflow-owner-')),key='workflow-owner:'+Date.now();
  const owner={admin:true,scope:null},s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[]}),
    runtime:async(operation)=>{assert.equal(operation,'guard.detect');return {literals:[]};},honcho:async()=>{throw Error('no native calls');}});
  const event:Envelope={version:1,key,origin:'live',kind:'telegram_update',bot_id:key,scope:'123',source_id:'1',revision:'1',occurred_at:null,text:'private content canary',
    payload:{message:{message_id:1,date:1700000000,chat:{id:123,type:'private'},from:{id:123},text:'private content canary',voice:{file_id:key}}}};
  const find=async(family:string,job:string)=>(await stores.control.query('SELECT id FROM workflow_registry WHERE family=$1 AND job_id=$2 ORDER BY generation DESC LIMIT 1',[family,job])).rows[0].id as string;
  try {
    await s.guards.reconcile();await s.guards.setMode('on');const captured=(await s.capture.capture(event)).source;
    const telegram=await find('telegram',captured.reference.id),preparation=await find('preparation',captured.reference.id);
    let detail=await workflowDetail(stores.control,telegram);assert.equal(detail.source_event_id,captured.reference.id);assert.equal(detail.can_cancel,true);
    assert.ok(!JSON.stringify(detail).includes('private content canary'));
    const page=await listWorkflows(stores.control,{family:'telegram',limit:1});assert.equal(page.workflows.length,1);assert.ok(page.next);
    const second=await listWorkflows(stores.control,{family:'telegram',limit:1,after:page.next});assert.notEqual(second.workflows[0]!.id,page.workflows[0]!.id);
    await assert.rejects(controlStorageWorkflow(stores.control,{admin:false,scope:'123'},telegram,'cancel',{revision:detail.revision}),{status:403});
    await assert.rejects(controlStorageWorkflow(stores.control,owner,telegram,'cancel',{revision:detail.revision+1}),{code:'workflow_revision_changed'});
    const fence=await stores.control.connect(),epoch=Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='telegram'")).rows[0].epoch);
    try {
      assert.equal(await enterFamily(fence,'telegram','inngest',epoch),true);
      await assert.rejects(controlStorageWorkflow(stores.control,owner,telegram,'cancel',{revision:detail.revision}),{code:'workflow_execution_in_progress'});
    }finally{await leaveFamily(fence,'telegram');fence.release();}
    const revision=detail.revision;detail=await controlStorageWorkflow(stores.control,owner,telegram,'cancel',{revision});assert.equal(detail.state,'cancelled');
    assert.equal((await controlStorageWorkflow(stores.control,owner,telegram,'cancel',{revision})).revision,detail.revision);assert.equal(detail.controls.length,1);
    assert.equal((await stores.control.query('SELECT state FROM dispatches WHERE event_id=$1',[captured.reference.id])).rows[0].state,'cancelled');
    await s.capture.handoff(captured);assert.equal((await workflowDetail(stores.control,telegram)).state,'cancelled','capture reconciliation cannot undo owner cancellation');
    const retryEvent:Envelope={...event,key:key+':retry',source_id:'2',text:'retry state canary',payload:{message:{...(event.payload as any).message,message_id:2,text:'retry state canary',voice:undefined}}};
    const retrySource=(await s.capture.capture(retryEvent)).source,retryWorkflow=await find('telegram',retrySource.reference.id);
    await stores.control.query(`INSERT INTO dispatches(event_id,source_reference) SELECT event_id,jsonb_build_object('store','archive','kind','event','id',event_id,'revision',source_revision,'input_hash',payload_hash)
      FROM capture_handoffs WHERE event_id=$1`,[retrySource.reference.id]);
    await stores.control.query("UPDATE dispatches SET state='failed',attempts=1,next_attempt=now()+interval '1 day',error_code='assistant_runtime_unavailable' WHERE event_id=$1",[retrySource.reference.id]);
    await stores.control.query("UPDATE workflow_registry SET state='retryable_failed' WHERE id=$1",[retryWorkflow]);
    const retryDetail=await workflowDetail(stores.control,retryWorkflow);assert.equal(retryDetail.can_retry,true);
    await controlStorageWorkflow(stores.control,owner,retryWorkflow,'retry',{revision:retryDetail.revision});
    assert.ok((await stores.control.query('SELECT next_attempt<=now() AS due FROM dispatches WHERE event_id=$1',[retrySource.reference.id])).rows[0].due,'owner retry makes a failed Telegram attempt immediately due');
    await stores.control.query("UPDATE workflow_registry SET state='retryable_failed' WHERE id=$1",[preparation]);
    await stores.control.query("UPDATE attachment_retrievals SET state='failed',next_attempt=now()+interval '1 day',error_code='provider_unavailable' WHERE event_id=$1",[captured.reference.id]);
    detail=await workflowDetail(stores.control,preparation);assert.equal(detail.can_retry,true);const retryRevision=detail.revision;
    detail=await controlStorageWorkflow(stores.control,owner,preparation,'retry',{revision:retryRevision});assert.equal(detail.state,'queued');assert.equal(detail.dispatch,2);
    await controlStorageWorkflow(stores.control,owner,preparation,'retry',{revision:retryRevision});assert.equal((await workflowDetail(stores.control,preparation)).dispatch,2);
    assert.ok((await stores.control.query('SELECT next_attempt<=now() AS due FROM attachment_retrievals WHERE event_id=$1',[captured.reference.id])).rows[0].due);
    await stores.control.query("UPDATE workflow_registry SET state='retryable_failed' WHERE id=$1",[preparation]);
    await stores.control.query("INSERT INTO workflow_receipts(workflow_id,step,attempt,state) VALUES($1,'fixture',1,'ambiguous')",[preparation]);
    detail=await workflowDetail(stores.control,preparation);
    assert.equal(detail.can_retry,false);assert.equal(detail.control_reason,'receipt_closed');
    await assert.rejects(controlStorageWorkflow(stores.control,owner,preparation,'retry',{revision:detail.revision}),{code:'workflow_receipt_closed'});
    await s.guards.prepare(captured.reference,'fixture',s.detect);const binding=await s.guards.state();
    const proposal=await s.telegramActions.request({admin:false,scope:null,space:'123',turnEvent:captured.reference.id,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch},
      {destination:'123',text:'private action canary'});
    await s.telegramActions.decide(owner,{id:proposal.id,fingerprint:proposal.fingerprint,decision:'approve'});
    const action=await find('actions',proposal.id);detail=await workflowDetail(stores.control,action);assert.equal(detail.can_cancel,true);
    await controlStorageWorkflow(stores.control,owner,action,'cancel',{revision:detail.revision});assert.equal((await s.telegramActions.inspect(owner,proposal.id)).state,'cancelled');
    const snapshot=JSON.stringify({health:await workflowHealth(stores.control),metrics:await workflowMetrics(stores.control,{range:'24h'}),page:await listWorkflows(stores.control,{limit:100})});
    assert.ok(!snapshot.includes('private content canary'));assert.ok(!snapshot.includes('private action canary'));
    const definition=(await stores.control.query("SELECT pg_get_viewdef('workflow_observations',true) AS definition")).rows[0].definition;
    for(const relation of ['events e','derived_artifacts','guard_sources','artifacts a'])assert.ok(!definition.includes(relation));
    const db=await stores.control.connect();let unknown:string;
    try{await db.query('BEGIN');unknown=await requestWorkflow(db,'tools',digest(key+':not-admitted'));await db.query('COMMIT');}finally{db.release();}
    await stores.control.query("UPDATE workflow_registry SET state='retryable_failed' WHERE id=$1",[unknown]);
    detail=await workflowDetail(stores.control,unknown);assert.equal(detail.can_retry,false);assert.equal(detail.can_cancel,false,'unmigrated domain controls are never advertised');
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

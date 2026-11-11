import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {fixtureServices} from './fixture-brain.js';
import {claimHostWorkflow,finishHostWorkflow} from '../src/workflows/host-coordinator.js';
import {workflowDetail,workflowHealth} from '../src/workflows/owner.js';
import {honchoEngine} from '../src/memory/honcho.js';

test('an unclear page read closes itself, the owner closes other unclear operations, and nothing runs again (ADR-0218)',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-action-resolutions-')),key='resolutions:'+Date.now(),group='-'+Date.now();
  const owner={admin:true,scope:null},s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async(operation)=>{assert.equal(operation,'guard.detect');return {literals:[]};},memoryEngine:honchoEngine(async()=>{throw Error('no provider');})});
  const a=s.controlledActions,x=s.controlledExecution,event:Envelope={version:1,key,origin:'live',kind:'telegram_update',bot_id:key,scope:group,source_id:'1',revision:'1',occurred_at:null,text:'Made-up operations',
    payload:{message:{message_id:1,chat:{id:Number(group),type:'supergroup',is_forum:false},from:{id:9},text:'Made-up operations'}}};
  try {
    await s.guards.reconcile();await s.guards.setMode('on');const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);
    const binding=await s.guards.state(),actor={admin:false,scope:group,space:group,turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
    const approved=async(kind:'shell'|'browser',value:string)=>{
      const p=await a.propose(actor,kind==='shell'?{kind,arguments:{command:value}}:{kind,arguments:{url:value}});
      await a.decide(owner,{id:p.id,fingerprint:p.fingerprint,decision:'approve'});return p;
    };
    const started=async(id:string)=>{
      const row=(await stores.control.query("SELECT * FROM workflow_registry WHERE family='tools' AND job_id=$1",[id])).rows[0];
      const lease=await claimHostWorkflow(stores.control,{workflow_id:row.id,dispatch:row.dispatch,family:'tools',run_id:'fixture-'+row.id});assert.equal(lease.claimed,true);
      const b={id,actor:'wf-'+row.id,workflow_id:row.id,workflow_token:lease.token};
      assert.equal((await x.claim(b)).claimed,true);assert.deepEqual(await x.start(b),{started:true});return b;
    };
    const lost=async(b:any)=>{
      await stores.control.query("UPDATE controlled_actions SET lease_until=now()-interval '1 second' WHERE id=$1",[b.id]);
      assert.equal((await x.claim(b)).claimed,false);
    };
    const finishHost=(b:any)=>finishHostWorkflow(stores.control,{workflow_id:b.workflow_id,token:b.workflow_token,result:{observed:true}});
    const waiting=async(id:string)=>(await s.supervision.decisions(owner)).items.some(item=>item.id===id);
    const cards:string[]=[];x.settled=async id=>{cards.push(id);};
    const uncertainTools=async()=>(await workflowHealth(stores.control)).counts.filter((row:any)=>row.family==='tools'&&row.state==='ambiguous').reduce((n:number,row:any)=>n+row.count,0);

    // A page read whose answer never came back closes itself with its receipt: nothing waits, nothing counts as uncertain.
    const read=await approved('browser','https://example.com/made-up-weather'),rb=await started(read.id);
    await x.finish({id:read.id,actor:rb.actor,state:'ambiguous',result:{error:'execution_outcome_unconfirmed',cause:'remote_unreachable'}});
    const readView=await a.inspect(owner,read.id);
    assert.equal(readView.state,'ambiguous','the receipt stays as observed');assert.equal(readView.resolution,'read_closed');assert.ok(readView.resolved_at);
    assert.equal(await waiting(read.id),false,'a closed read never waits for the owner');
    // The host records what it observed; the task reads as skipped, not uncertain.
    assert.equal((await finishHost(rb)).state,'ambiguous');assert.equal((await workflowDetail(stores.control,rb.workflow_id)).state,'skipped');
    assert.deepEqual(await x.finish({id:read.id,actor:rb.actor,state:'ambiguous',result:{error:'execution_outcome_unconfirmed',cause:'remote_unreachable'}}),{id:read.id,state:'ambiguous'},
      'a repeated receipt is still accepted');
    await assert.rejects(a.resolve(owner,{id:read.id,fingerprint:read.fingerprint,outcome:'ran'}),{code:'action_already_started_or_closed'});
    // So does one whose executor stopped answering before any receipt.
    const silent=await approved('browser','https://example.com/made-up-silent'),sb=await started(silent.id);await lost(sb);
    assert.equal((await a.row(silent.id)).error_code,'executor_receipt_missing');assert.equal((await a.inspect(owner,silent.id)).resolution,'read_closed');
    assert.equal(await waiting(silent.id),false);

    // Any other unclear operation waits until the owner says what happened.
    const command=await approved('shell','printf made-up-unclear'),cb=await started(command.id);await lost(cb);
    assert.equal((await finishHost(cb)).state,'ambiguous');const before=await uncertainTools();
    const unclear=await a.inspect(owner,command.id);assert.equal(unclear.state,'ambiguous');assert.equal(unclear.resolution,null);assert.equal(await waiting(command.id),true);
    cards.length=0;
    await assert.rejects(a.resolve(actor,{id:command.id,fingerprint:command.fingerprint,outcome:'not_run'}),{status:403});
    await assert.rejects(a.resolve(owner,{id:command.id,fingerprint:command.fingerprint,outcome:'run_again'}),{code:'invalid_decision'});
    await assert.rejects(a.resolve(owner,{id:command.id,fingerprint:command.fingerprint,outcome:'not_run',state:'done'}),{code:'unknown_action_field'});
    await assert.rejects(a.resolve(owner,{id:command.id,fingerprint:digest('other'),outcome:'not_run'}),{code:'action_changed'});
    await assert.rejects(a.resolve(owner,{id:command.id,fingerprint:command.fingerprint,outcome:'not_run',expected_revision:unclear.revision-1}),{code:'action_changed'});
    const word={id:command.id,fingerprint:command.fingerprint,outcome:'not_run',expected_revision:unclear.revision,operation_id:key+':not-run'};
    const closed=await a.resolve(owner,word);assert.deepEqual(closed,{id:command.id,state:'ambiguous',resolution:'not_run',revision:unclear.revision+1});
    assert.deepEqual(await a.resolve(owner,word),closed,'a repeated press answers the same');
    await assert.rejects(a.resolve(owner,{...word,outcome:'ran'}),{code:'owner_command_conflict'});
    await assert.rejects(a.resolve(owner,{id:command.id,fingerprint:command.fingerprint,outcome:'dismissed'}),{code:'action_already_started_or_closed'});
    const row=await a.row(command.id);assert.equal(row.state,'ambiguous');assert.equal(row.resolution,'not_run');assert.equal(row.error_code,'executor_receipt_missing');
    assert.equal(await waiting(command.id),false,'a closed operation no longer waits');
    assert.equal((await workflowDetail(stores.control,cb.workflow_id)).state,'skipped');assert.equal(await uncertainTools(),before-1,'Health stops counting it as uncertain');
    // The owner's word never runs anything: approving again is still refused, and a claim finds nothing to run.
    await assert.rejects(a.decide(owner,{id:command.id,fingerprint:command.fingerprint,decision:'approve',operation_id:key+':again'}),{code:'action_already_started_or_closed'});
    assert.deepEqual(await x.claim(cb).catch(error=>error.code),'workflow_lease_closed');
    // A late receipt is an observed result: it settles the operation, and the owner's word no longer shows.
    await x.finish({id:command.id,actor:cb.actor,state:'done',result:{stdout:'made-up late receipt'}});
    const late=await a.inspect(owner,command.id);assert.equal(late.state,'done');assert.equal(late.resolution,null);
    assert.equal((await workflowDetail(stores.control,cb.workflow_id)).state,'completed');

    // "It ran" counts the task as done.
    const other=await approved('shell','printf made-up-ran'),ob=await started(other.id);await lost(ob);await finishHost(ob);
    await a.resolve(owner,{id:other.id,fingerprint:other.fingerprint,outcome:'ran'});
    assert.equal((await workflowDetail(stores.control,ob.workflow_id)).state,'completed');
    // Only an unclear operation can be closed this way.
    const waits=await a.propose(actor,{kind:'shell',arguments:{command:'printf made-up-waiting'}});
    await assert.rejects(a.resolve(owner,{id:waits.id,fingerprint:waits.fingerprint,outcome:'dismissed'}),{code:'action_already_started_or_closed'});
    assert.equal((await a.row(waits.id)).state,'proposed');
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

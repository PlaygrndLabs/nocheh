import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {claimHostWorkflow,finishHostWorkflow} from '../src/workflows/host-coordinator.js';
import {controlStorageWorkflow} from '../src/stores/workflow-owner.js';
import {workflowDetail} from '../src/workflows/owner.js';
import {policySnapshot,savePolicy} from '../src/security/store.js';

test('host tool execution fences exact authority and repairs durable results without repeating effects',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-tool-execution-')),key='execution:'+Date.now(),group='-'+Date.now();
  const owner={admin:true,scope:null},s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async(operation)=>{assert.equal(operation,'guard.detect');return {literals:[]};},honcho:async()=>{throw Error('no provider');}});
  const a=s.controlledActions,x=s.controlledExecution,event:Envelope={version:1,key,origin:'live',kind:'telegram_update',bot_id:key,scope:group,source_id:'1',revision:'1',occurred_at:null,text:'Tool execution source',
    payload:{message:{message_id:1,chat:{id:Number(group),type:'supergroup',is_forum:false},from:{id:9},text:'Tool execution source'}}};
  try {
    await s.guards.reconcile();await s.guards.setMode('on');const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);
    const binding=await s.guards.state(),actor={admin:false,scope:group,space:group,turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
    const proposal=async(command:string,approve=true)=>{
      const p=await a.propose(actor,{kind:'shell',arguments:{command}});
      if(approve)await a.decide(owner,{id:p.id,fingerprint:p.fingerprint,decision:'approve'});return p;
    };
    const host=async(id:string)=>{
      const row=(await stores.control.query("SELECT * FROM workflow_registry WHERE family='tools' AND job_id=$1",[id])).rows[0];
      const lease=await claimHostWorkflow(stores.control,{workflow_id:row.id,dispatch:row.dispatch,family:'tools',run_id:'fixture-'+row.id});assert.equal(lease.claimed,true);
      return {id,actor:'wf-'+row.id,workflow_id:row.id,workflow_token:lease.token};
    };
    const finishHost=async(b:any)=>finishHostWorkflow(stores.control,{workflow_id:b.workflow_id,token:b.workflow_token,result:{observed:true}});
    const p=await proposal('printf receipt'),b=await host(p.id);
    await assert.rejects(x.claim({...b,workflow_token:'00000000-0000-0000-0000-000000000000'}),{code:'workflow_lease_closed'});
    const claims=await Promise.all([x.claim(b),x.claim(b)]);assert.equal(claims.filter(c=>c.claimed).length,1);
    assert.equal((claims.find(c=>c.claimed) as any).arguments.command,'printf receipt');
    assert.deepEqual(await x.start(b),{started:true});assert.deepEqual(await x.start(b),{started:false,reason:'execution_already_started'});
    const receipt={id:p.id,actor:b.actor,state:'done',result:{stdout:'synthetic receipt',exit_code:0}},complete=x.complete.bind(x);
    x.complete=async()=>{throw Error('control completion unavailable');};
    try{await assert.rejects(x.finish(receipt),/control completion unavailable/);}finally{x.complete=complete;}
    assert.equal((await a.row(p.id)).state,'running');
    assert.ok((await stores.derived.query('SELECT 1 FROM derived_artifacts WHERE operation_id=$1',['controlled-result:'+p.id])).rowCount,'result persisted before control completion');
    assert.equal((await x.claim(b)).claimed,false,'repair must not release arguments again');
    assert.equal((await a.row(p.id)).state,'done');assert.equal((await a.inspect(owner,p.id)).result.result.stdout,'synthetic receipt');
    assert.deepEqual(await x.finish(receipt),{id:p.id,state:'done'});
    await assert.rejects(x.finish({...receipt,result:{stdout:'changed'}}),{code:'derivative_identity_conflict'});
    await assert.rejects(x.finish({...receipt,actor:'wf-'+digest('different')}),{code:'action_actor_denied'});
    assert.equal((await finishHost(b)).state,'completed');assert.equal((await finishHost(b)).state,'completed');
    assert.equal((await workflowDetail(stores.control,b.workflow_id)).can_retry,false);

    const permission=await proposal('printf revoked',false),grant=await a.grant(owner,{action_id:permission.id,fingerprint:permission.fingerprint,uses:2,minutes:5}),pb=await host(permission.id);
    assert.equal((await x.claim(pb)).claimed,true);
    assert.equal((await stores.control.query('SELECT remaining FROM action_permissions WHERE id=$1',[grant.id])).rows[0].remaining,1);
    assert.equal((await x.claim(pb)).claimed,false,'repeat claim cannot consume a second use');
    await a.revoke(owner,{id:grant.id});assert.deepEqual(await x.start(pb),{started:false,reason:'permission_no_longer_valid'});
    await x.finish({id:permission.id,actor:pb.actor,state:'failed',result:{error:'security_start_denied'}});assert.equal((await finishHost(pb)).state,'failed');

    const denied=await proposal('printf policy'),db=await host(denied.id);assert.equal((await x.claim(db)).claimed,true);
    const original=await policySnapshot(stores.control);
    await savePolicy(stores.control,owner,{expected_revision:original.revision,policy:{version:1,rules:[...original.policy.rules,{id:key,kind:'shell',fingerprint:denied.fingerprint,outcome:'deny'}]}});
    try{assert.equal((await x.start(db)).started,false);}finally{await savePolicy(stores.control,owner,{expected_revision:(await policySnapshot(stores.control)).revision,policy:original.policy});}
    await x.finish({id:denied.id,actor:db.actor,state:'failed',result:{error:'security_start_denied'}});await finishHost(db);

    const uncertain=await proposal('printf uncertain'),ub=await host(uncertain.id);assert.equal((await x.claim(ub)).claimed,true);assert.equal((await x.start(ub)).started,true);
    await stores.control.query("UPDATE controlled_actions SET lease_until=now()-interval '1 second' WHERE id=$1",[uncertain.id]);
    assert.equal((await x.claim(ub)).claimed,false);assert.equal((await a.row(uncertain.id)).state,'ambiguous');
    assert.equal((await finishHost(ub)).state,'ambiguous');
    await a.decide(owner,{id:uncertain.id,fingerprint:uncertain.fingerprint,decision:'approve'});
    assert.equal((await a.row(uncertain.id)).state,'ambiguous','replaying the original owner receipt never revives execution');
    await assert.rejects(a.decide(owner,{id:uncertain.id,fingerprint:uncertain.fingerprint,decision:'approve',operation_id:key+':new-approval'}),{code:'action_already_started_or_closed'});
    // A previously fsynced receipt can settle a late outcome after the workflow lease is closed.
    await x.finish({id:uncertain.id,actor:ub.actor,state:'done',result:{stdout:'late receipt'}});assert.equal((await a.row(uncertain.id)).state,'done');
    const settled=await workflowDetail(stores.control,ub.workflow_id);assert.equal(settled.state,'completed');assert.equal(settled.receipts[0].state,'done');assert.equal(settled.can_retry,false);

    const cancelled=await proposal('printf cancel',false),cw=(await stores.control.query("SELECT * FROM workflow_registry WHERE family='tools' AND job_id=$1",[cancelled.id])).rows[0];
    assert.equal((await workflowDetail(stores.control,cw.id)).can_cancel,true);
    await controlStorageWorkflow(stores.control,owner,cw.id,'cancel',{revision:cw.revision});
    assert.equal((await a.row(cancelled.id)).state,'rejected');
    await assert.rejects(a.decide(owner,{id:cancelled.id,fingerprint:cancelled.fingerprint,decision:'approve'}),{code:'action_already_started_or_closed'});

    const stale=await proposal('printf stale'),sb=await host(stale.id);assert.equal((await x.claim(sb)).claimed,true);
    await s.guards.setMode('off');assert.equal((await x.start(sb)).started,false,'guard-off still revokes stale generation');
    await x.finish({id:stale.id,actor:sb.actor,state:'failed',result:{error:'security_start_denied'}});await finishHost(sb);
    const unclaimed=await a.propose({...actor,guard_epoch:(await s.guards.state()).epoch,revision:(await s.guards.state()).epoch},{kind:'shell',arguments:{command:'printf epoch'}});
    await a.decide(owner,{id:unclaimed.id,fingerprint:unclaimed.fingerprint,decision:'approve'});const ub2=await host(unclaimed.id);
    await s.guards.setMode('on');assert.equal((await x.claim(ub2)).claimed,false);assert.equal((await a.row(unclaimed.id)).state,'rejected');
    assert.equal((await stores.archive.query("SELECT count(*)::int AS n FROM events WHERE kind LIKE 'controlled_%'")).rows[0].n,0);
    assert.equal((await stores.control.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'workflow_tool_%' AND NOT tgisinternal")).rows[0].n,0);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonical,digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {savePolicy} from '../src/security/store.js';

test('one-time memory follow-ups preserve topic, recovery, revocation and delivery authority',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async t=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-memory-followup-'));
  const key='memory-followup:'+Date.now(),owner:Reader={admin:true,scope:null};let sequence=0;
  const fixture=async(topic?:number,autoFollowup=true)=>{
    const label=key+':'+(++sequence),group='-'+(Date.now()*10+sequence),destination=group+(topic?'/topic/'+topic:''),sent:Record<string,unknown>[]=[];
    const receipts=new Set<string>();let loseReceipt=false;
    const services=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(label),policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
      runtime:async(operation,input)=>{
        if(operation==='guard.detect')return {literals:[]};
        assert.equal(operation,'action.execute');const id=String(input.id);
        if(input.observe_only)return {state:receipts.has(id)?'done':'not_found'};
        await services.telegramActions.authorizeDelivery(input);assert.equal(receipts.has(id),false,'the same native effect cannot execute twice');
        sent.push(input);receipts.add(id);if(loseReceipt){loseReceipt=false;throw Error('synthetic lost delivery response');}return {state:'done'};
      },honcho:async()=>{throw Error('no provider');}});
    await services.guards.reconcile();await services.guards.setMode('on');
    const capture=async(scope:string,index:number,text:string)=>{
      const event:Envelope={version:1,key:label+':'+index,origin:'live',kind:'telegram_update',bot_id:label,scope,source_id:String(index),revision:'1',occurred_at:null,text,
        payload:{message:{message_id:index,date:1,chat:{id:Number(scope),type:scope==='123'?'private':'supergroup',is_forum:!!topic},
          from:{id:123,first_name:'Fixture'},text,...(scope===group&&topic?{message_thread_id:topic,is_topic_message:true}:{})}}};
      const source=(await services.capture.capture(event)).source.reference;await services.guards.prepare(source,'fixture',services.detect);return source;
    };
    const project=await services.projects.save(owner,{name:'Orion '+sequence,description:'Synthetic fixture',state:'active',expected_revision:0,operation_id:label+':project'});
    await services.projects.assign(owner,{space_id:destination,project_id:project.id,mode:'assigned',expected_revision:0,operation_id:label+':assign'});
    const evidence=await capture('123',1,'Orion launch schedule milestone is October.'),source=await capture(group,2,'What is the Orion launch schedule?');
    const entity=await services.entities.ensureProject(project),binding=await services.guards.state();
    const fact=await services.entities.publishClaim({subject_id:entity.id,predicate:'launch_schedule',content:'Orion launch schedule milestone is October.',attribution:'reported',uncertainty:'supported',evidence:[evidence]},binding,label+':fact');
    await services.memoryAccess.saveSettings(owner,{destination,notify_owner:false,auto_followup:autoFollowup,expected_revision:1,operation_id:label+':settings'});
    const current=await services.guards.state();
    const principal:Reader={admin:false,scope:group,space:destination,turnEvent:source.id,generation:current.generation,guard_epoch:current.epoch};
    const request=await services.memoryAccess.suggest(principal,'Orion launch schedule October');assert.ok(request);
    const decision={decision:'one_time',wording:'Orion launch schedule milestone is October.',expected_revision:1,operation_id:label+':approve'};
    const approve=()=>services.memoryAccess.decide(owner,request.id,decision);
    const saved=async()=>(await stores.control.query('SELECT * FROM memory_access_requests WHERE id=$1',[request.id])).rows[0];
    const authority={owner:'inngest' as const,epoch:Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='actions'")).rows[0].epoch)};
    return {services,destination,sent,principal,request,fact,approve,saved,authority,source,loseReceipt:()=>{loseReceipt=true;}};
  };
  try {
    await t.test('one-time approval follows up once and is consumed only after confirmation',async()=>{
      const f=await fixture(),approval=await f.approve(),request=await f.saved();assert.ok(request.followup_action_id,'approval must stage its follow-up');
      assert.equal((await f.services.memoryAccess.context(f.principal,'Orion launch schedule')).sources.length,0,'one-time grants never enter later model context');
      assert.equal((await stores.control.query('SELECT state FROM memory_fact_grants WHERE id=$1',[approval.grant_id])).rows[0].state,'active');
      assert.equal((await f.services.telegramActions.run(request.followup_action_id,f.authority)).state,'completed');
      await f.services.memoryAccess.reconcile();assert.equal((await f.saved()).state,'delivered');
      assert.equal((await stores.control.query('SELECT state FROM memory_fact_grants WHERE id=$1',[approval.grant_id])).rows[0].state,'consumed');
      await f.approve();await f.services.telegramActions.run(request.followup_action_id,f.authority);assert.equal(f.sent.length,1);
    });
    await t.test('topic approval stages the exact approved topic',async()=>{
      const f=await fixture(17);await f.approve();const request=await f.saved();assert.ok(request.followup_action_id,'topic approval must stage its follow-up');
      assert.equal((await f.services.telegramActions.inspect(owner,request.followup_action_id)).arguments.destination,f.destination);
      await f.services.telegramActions.run(request.followup_action_id,f.authority);assert.equal(f.sent[0]!.destination,f.destination);
    });
    await t.test('uncertain delivery stays unconsumed until the existing native receipt is observed',async()=>{
      const f=await fixture(),approval=await f.approve(),request=await f.saved();f.loseReceipt();
      assert.equal((await f.services.telegramActions.run(request.followup_action_id,f.authority)).state,'waiting');
      await f.services.memoryAccess.reconcile();assert.equal((await f.saved()).state,'approved');
      assert.equal((await stores.control.query('SELECT state FROM memory_fact_grants WHERE id=$1',[approval.grant_id])).rows[0].state,'active');
      await stores.control.query('UPDATE telegram_action_requests SET next_attempt=now() WHERE id=$1',[request.followup_action_id]);
      assert.equal((await f.services.telegramActions.run(request.followup_action_id,f.authority)).state,'completed');
      await f.services.memoryAccess.reconcile();assert.equal(f.sent.length,1);
      assert.equal((await stores.control.query('SELECT state FROM memory_fact_grants WHERE id=$1',[approval.grant_id])).rows[0].state,'consumed');
    });
    await t.test('retry after interrupted handoff recovers one durable follow-up',async()=>{
      const f=await fixture(),stage=f.services.telegramActions.stageSystem.bind(f.services.telegramActions);let interrupted=true,actionId='';
      f.services.telegramActions.stageSystem=async(...args)=>{const action=await stage(...args);actionId=action.id;
        if(interrupted){interrupted=false;throw Error('synthetic interruption after action staging');}return action;};
      await assert.rejects(f.approve(),/synthetic interruption/);
      const before=await f.saved();assert.equal(before.state,'pending');assert.equal(before.grant_id,null);assert.equal(before.followup_action_id,null);
      assert.equal((await stores.control.query('SELECT id FROM telegram_action_requests WHERE id=$1',[actionId])).rowCount,0,'action insertion rolls back with approval');
      assert.equal((await stores.control.query("SELECT id FROM workflow_registry WHERE family='actions' AND job_id=$1",[actionId])).rowCount,0,'no workflow can escape the failed transaction');
      const first=await f.approve();assert.deepEqual(await f.approve(),first);const request=await f.saved();assert.ok(request.followup_action_id,'retry must stage the same follow-up');
      assert.equal(request.followup_action_id,actionId);
      await f.services.telegramActions.run(request.followup_action_id,f.authority);await f.approve();assert.equal(f.sent.length,1);
    });
    await t.test('revocation before delivery blocks the queued follow-up',async()=>{
      const f=await fixture(),approval=await f.approve(),request=await f.saved();assert.ok(request.followup_action_id);
      await f.services.memoryAccess.revoke(owner,approval.grant_id!,{expected_revision:1,operation_id:key+':revoke'});
      const result=await f.services.telegramActions.run(request.followup_action_id,f.authority);
      assert.ok(['denied','cancelled'].includes(result.state));assert.equal(f.sent.length,0,'revoked wording must never leave the trusted boundary');
    });
    await t.test('an old committed approval can recover its missing handoff on exact replay',async()=>{
      const f=await fixture(),first=await f.approve(),request=await f.saved(),id=request.followup_action_id;assert.ok(id);
      await stores.control.query("DELETE FROM workflow_outbox WHERE workflow_id IN (SELECT id FROM workflow_registry WHERE family='actions' AND job_id=$1)",[id]);
      await stores.control.query("DELETE FROM workflow_registry WHERE family='actions' AND job_id=$1",[id]);
      await stores.control.query('DELETE FROM telegram_action_requests WHERE id=$1',[id]);
      await stores.control.query('UPDATE memory_fact_grants SET delivery_action_id=NULL WHERE id=$1',[first.grant_id]);
      await stores.control.query('UPDATE memory_access_requests SET followup_action_id=NULL WHERE id=$1',[f.request.id]);
      assert.deepEqual(await f.approve(),first);assert.equal((await f.saved()).followup_action_id,id);
      await f.services.telegramActions.run(id,f.authority);await f.approve();assert.equal(f.sent.length,1);
    });
    await t.test('automatic follow-up disabled does not silently create an action',async()=>{
      const f=await fixture(undefined,false),first=await f.approve();assert.deepEqual(await f.approve(),first);
      assert.equal((await f.saved()).followup_action_id,null);
      assert.equal((await stores.control.query('SELECT id FROM telegram_action_requests WHERE source_reference->>\'id\'=$1',[f.source.id])).rowCount,0);
    });
    await t.test('repairing a missing old receipt link never sends the delivered wording again',async()=>{
      const f=await fixture(),approval=await f.approve(),request=await f.saved(),id=request.followup_action_id;
      await f.services.telegramActions.run(id,f.authority);
      await stores.control.query('UPDATE memory_fact_grants SET delivery_action_id=NULL WHERE id=$1',[approval.grant_id]);
      await stores.control.query('UPDATE memory_access_requests SET followup_action_id=NULL WHERE id=$1',[f.request.id]);
      await f.approve();assert.equal((await f.saved()).followup_action_id,id);
      await f.services.telegramActions.run(id,f.authority);await f.services.memoryAccess.reconcile();
      assert.equal(f.sent.length,1);assert.equal((await f.saved()).state,'delivered');
    });
    await t.test('a partially linked confirmed receipt repairs history even after revocation',async()=>{
      const f=await fixture(),approval=await f.approve(),request=await f.saved(),id=request.followup_action_id;
      await f.services.telegramActions.run(id,f.authority);
      await stores.control.query('UPDATE memory_access_requests SET followup_action_id=NULL WHERE id=$1',[f.request.id]);
      await f.services.memoryAccess.revoke(owner,approval.grant_id!,{expected_revision:1,operation_id:key+':revoke-partial-link'});
      await f.services.memoryAccess.reconcile();assert.equal((await f.saved()).state,'delivered');assert.equal((await f.saved()).followup_action_id,id);
      assert.equal((await stores.control.query('SELECT state FROM memory_fact_grants WHERE id=$1',[approval.grant_id])).rows[0].state,'revoked');
      assert.equal(f.sent.length,1,'historical receipt repair performs no new external action');
    });
    await t.test('security denial rolls back the approval and its grant',async()=>{
      const f=await fixture(),revision=Number((await stores.control.query('SELECT revision FROM security_policy WHERE singleton')).rows[0].revision);
      await savePolicy(stores.control,owner,{expected_revision:revision,policy:{version:1,rules:[{id:key+':denied',kind:'telegram.send',outcome:'deny',fingerprint:digest(canonical({destination:f.destination,text:'Orion launch schedule milestone is October.'}))}]}});
      await assert.rejects(f.approve(),{code:'action_delivery_denied'});const request=await f.saved();assert.equal(request.state,'pending');assert.equal(request.grant_id,null);
    });
    await t.test('expiration during preparation cannot commit a follow-up',async()=>{
      const f=await fixture(),prepare=f.services.telegramActions.prepareSystem.bind(f.services.telegramActions);
      f.services.telegramActions.prepareSystem=async(...args)=>{const prepared=await prepare(...args);
        await stores.control.query("UPDATE memory_access_requests SET expires_at=now()-interval '1 second' WHERE id=$1",[f.request.id]);return prepared;};
      await assert.rejects(f.approve(),{code:'memory_access_request_expired'});
      assert.equal((await f.saved()).grant_id,null);assert.equal((await f.saved()).followup_action_id,null);
    });
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

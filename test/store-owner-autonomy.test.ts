import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {savePolicy} from '../src/security/store.js';

test('owner freedom lets only the owner\'s live private requests approve themselves, defaults to approval and keeps deny rules',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-owner-autonomy-')),key='owner-autonomy:'+Date.now(),group='-'+Date.now();
  const owner:Reader={admin:true,scope:null};
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async operation=>{if(operation==='guard.detect')return {literals:[]};throw Error('runtime_not_expected');},honcho:async()=>{throw Error('no memory provider');}});
  let serial=0;
  const capture=async(scope:string,from:number,text:string)=>{
    const label=String(++serial),value:Envelope={version:1,key:key+':'+label,origin:'live',kind:'telegram_update',bot_id:key,scope,source_id:label,revision:'1',occurred_at:null,text,
      payload:{message:{message_id:serial,date:1700000000,chat:{id:Number(scope),type:scope==='123'?'private':'supergroup',is_forum:false},from:{id:from},text}}};
    const source=(await s.capture.capture(value)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const actor=async(source:string,scope:string|null,space:string):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope,space,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const state=async(id:string)=>(await stores.control.query('SELECT state FROM telegram_action_requests WHERE id=$1',[id])).rows[0].state;
  const queued=async(id:string)=>Number((await stores.control.query("SELECT count(*) FROM workflow_registry WHERE family='actions' AND job_id=$1",[id])).rows[0].count);
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    const initial=await s.ownerAutonomy.get(owner);assert.equal(initial.mode,'approval_required','approval is the default');
    await assert.rejects(s.ownerAutonomy.get({admin:false,scope:null}),{status:403});
    const asked=await s.telegramActions.request(await actor((await capture('123',123,'Send a note')).id,null,'123'),{destination:group,text:'Default waits'});
    assert.equal(await state(asked.id),'proposed');assert.equal(await queued(asked.id),0);

    const enabled=await s.ownerAutonomy.save(owner,{mode:'owner_requests_execute',expected_revision:initial.revision,operation_id:key+':enable'});
    assert.deepEqual(await s.ownerAutonomy.save(owner,{mode:'owner_requests_execute',expected_revision:initial.revision,operation_id:key+':enable'}),enabled,'idempotent');
    await assert.rejects(s.ownerAutonomy.save(owner,{mode:'approval_required',expected_revision:initial.revision,operation_id:key+':stale'}),{code:'owner_autonomy_conflict'});
    const epoch=(await s.guards.state()).epoch;
    const direct=await s.telegramActions.request(await actor((await capture('123',123,'Send it now')).id,null,'123'),{destination:group,text:'Owner request runs'});
    assert.equal(direct.state,'approved');assert.equal(await state(direct.id),'approved');assert.equal(await queued(direct.id),1);
    const rule=(await stores.control.query("SELECT rule,origin FROM security_events WHERE state='allowed' AND effect_id=(SELECT effect_id FROM security_events WHERE rule LIKE 'owner_autonomy:%' LIMIT 1)")).rows[0];
    assert.deepEqual(rule,{rule:'owner_autonomy:'+enabled.revision,origin:'grant'},'the decision records the setting revision that authorized it');
    assert.equal((await s.guards.state()).epoch,epoch,'changing the setting and approving a request revoke no context');

    const fromGroup=await s.telegramActions.request(await actor((await capture(group,123,'Owner in a group')).id,group,group),{destination:'current',text:'Group waits'});
    assert.equal(await state(fromGroup.id),'proposed','a group request still waits even when the owner authored it');
    const tool=await s.controlledActions.propose(await actor((await capture('123',123,'Run a tool')).id,null,'123'),{kind:'shell',arguments:{command:'printf ok'}});
    assert.equal(tool.state,'approved');
    const groupTool=await s.controlledActions.propose(await actor((await capture(group,123,'Group tool')).id,group,group),{kind:'shell',arguments:{command:'printf group'}});
    assert.equal(groupTool.state,'proposed');

    const security=(await stores.control.query('SELECT revision FROM security_policy WHERE singleton')).rows[0].revision;
    await savePolicy(stores.control,owner,{expected_revision:Number(security),policy:{version:1,rules:[{id:key+':deny',kind:'telegram.send',outcome:'deny'}]}});
    const denied=await s.telegramActions.request(await actor((await capture('123',123,'Denied send')).id,null,'123'),{destination:group,text:'Deny rule wins'});
    assert.equal(await state(denied.id),'proposed');assert.equal(await queued(denied.id),0,'an explicit deny rule still blocks');
    await savePolicy(stores.control,owner,{expected_revision:Number(security)+1,policy:{version:1,rules:[]}});

    await s.ownerAutonomy.save(owner,{mode:'approval_required',expected_revision:enabled.revision,operation_id:key+':disable'});
    const after=await s.telegramActions.request(await actor((await capture('123',123,'After disabling')).id,null,'123'),{destination:group,text:'Waits again'});
    assert.equal(await state(after.id),'proposed');
    assert.equal((await s.ownerAutonomy.get(owner)).history.length,2);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

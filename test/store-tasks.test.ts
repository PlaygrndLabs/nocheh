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

test('the owner keeps one task list from the dashboard and their private chat, never from a group',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-tasks-')),key='tasks:'+Date.now(),group='-'+Date.now();
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
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    await stores.control.query('DELETE FROM owner_tasks');
    const turn=await capture('123',123,'Remind me to renew the passport by Friday');
    const chat=await actor(turn.id,null,'123');
    const added=await s.tasks.chatCreate(chat,{title:' Renew the passport ',due_on:'2030-01-04'});
    assert.equal(added.title,'Renew the passport');assert.equal(added.origin,'chat');assert.equal(added.source_event,turn.id,'a chat task links the message that asked for it');
    assert.equal((await s.tasks.chatCreate(chat,{title:' Renew the passport ',due_on:'2030-01-04'})).id,added.id,'a repeated tool call in one turn makes no duplicate');

    const fromGroup=await actor((await capture(group,123,'Remind me in the group')).id,group,group);
    await assert.rejects(s.tasks.chatCreate(fromGroup,{title:'Group task'}),{status:403},'the owner writing in a group cannot reach the task list');
    await assert.rejects(s.tasks.chatList(fromGroup),{status:403});
    await assert.rejects(s.tasks.list({admin:false,scope:null}),{status:403},'the dashboard routes need the owner');

    const typed=await s.tasks.create(owner,{operation_id:key+':typed',title:'Call the bank',notes:'Ask about the card'});
    assert.deepEqual(await s.tasks.create(owner,{operation_id:key+':typed',title:'Call the bank',notes:'Ask about the card'}),typed,'a retried save is idempotent');
    await assert.rejects(s.tasks.create(owner,{operation_id:key+':typed',title:'Something else'}),{code:'task_operation_conflict'});
    await assert.rejects(s.tasks.create(owner,{operation_id:key+':blank',title:'   '}),{code:'task_title_required'});
    await assert.rejects(s.tasks.create(owner,{operation_id:key+':due',title:'Bad date',due_on:'next friday'}),{code:'invalid_task_due'});
    await assert.rejects(s.tasks.create(owner,{operation_id:key+':day',title:'No such day',due_on:'2030-02-30'}),{code:'invalid_task_due'});
    await assert.rejects(s.tasks.create(owner,{operation_id:key+':extra',title:'Extra',owner:'someone'}),{code:'unknown_task_field'});

    let open=await s.tasks.list(owner);
    assert.deepEqual(open.tasks.map((task:any)=>task.id),[added.id,typed.id],'tasks with a due date come first');
    assert.deepEqual(open.counts,{open:2,done:0,dropped:0});

    const done=await s.tasks.chatUpdate(chat,added.id,{expected_revision:added.revision,state:'done'});
    assert.equal(done.state,'done');assert.ok(done.done_at);assert.equal(done.revision,added.revision+1);
    await assert.rejects(s.tasks.update(owner,added.id,{operation_id:key+':stale',expected_revision:added.revision,title:'Stale'}),{code:'task_revision_conflict'});
    const reopened=await s.tasks.update(owner,added.id,{operation_id:key+':reopen',expected_revision:done.revision,state:'open',due_on:null});
    assert.equal(reopened.done_at,null);assert.equal(reopened.due_on,null,'clearing the due date is a change');assert.equal(reopened.title,'Renew the passport');
    await assert.rejects(s.tasks.update(owner,digest('missing'),{operation_id:key+':missing',expected_revision:1,state:'done'}),{status:404});
    await assert.rejects(s.tasks.update(owner,added.id,{operation_id:key+':empty',expected_revision:reopened.revision}),{code:'task_change_required'});

    await s.tasks.update(owner,typed.id,{operation_id:key+':drop',expected_revision:typed.revision,state:'dropped'});
    open=await s.tasks.list(owner);
    assert.deepEqual(open.tasks.map((task:any)=>task.id),[added.id]);assert.deepEqual(open.counts,{open:1,done:0,dropped:1});
    assert.equal((await s.tasks.list(owner,{state:'all'})).tasks.length,2);
    const first=await s.tasks.list(owner,{state:'all',limit:'1'});
    assert.equal(first.next,'1');assert.equal((await s.tasks.list(owner,{state:'all',limit:'1',after:first.next!})).tasks.length,1);
    await assert.rejects(s.tasks.list(owner,{state:'later'}),{code:'invalid_task_state'});
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

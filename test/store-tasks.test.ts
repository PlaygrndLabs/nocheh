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

test('the owner keeps task lists from the dashboard and their private chat; an unassigned group reaches none',
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
    assert.equal(added.title,'Renew the passport');assert.equal(added.origin,'chat');assert.equal(added.project_id,null,'a task is personal unless tied to a project');assert.equal(added.source_event,turn.id,'a chat task links the message that asked for it');
    assert.equal((await s.tasks.chatCreate(chat,{title:' Renew the passport ',due_on:'2030-01-04'})).id,added.id,'a repeated tool call in one turn makes no duplicate');

    const fromGroup=await actor((await capture(group,123,'Remind me in the group')).id,group,group);
    await assert.rejects(s.tasks.chatCreate(fromGroup,{title:'Group task'}),{status:403},'a group with no project reaches no task list, even when the owner writes');
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

    // Personal tasks and each project's tasks are separate lists; a domain labels a task within its list.
    await stores.control.query('DELETE FROM owner_tasks');
    const launch=digest(key+':launch'),house=digest(key+':house'),retired=digest(key+':retired');
    for(const [id,name,state] of [[launch,'Launch','active'],[house,'House','active'],[retired,'Retired','archived']])
      await stores.control.query('INSERT INTO projects(id,name,state,revision) VALUES($1,$2,$3,1)',[id,name,state]);
    await stores.control.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1)",[group,launch]);
    const health=await s.tasks.create(owner,{operation_id:key+':health',title:'Book a checkup',domain:'  Health  '});
    assert.equal(health.domain,'Health');assert.equal(health.project_id,null);
    const site=await s.tasks.create(owner,{operation_id:key+':site',title:'Publish the site',scope:launch,domain:'Web'});
    const roof=await s.tasks.chatCreate(chat,{title:'Fix the roof',scope:house});
    assert.equal(roof.project_id,house,'the owner\'s private chat reaches every list');
    await assert.rejects(s.tasks.create(owner,{operation_id:key+':old',title:'Old',scope:retired}),{code:'task_project_archived'});
    await assert.rejects(s.tasks.create(owner,{operation_id:key+':none',title:'None',scope:digest('none')}),{code:'task_project_not_found'});
    await assert.rejects(s.tasks.create(owner,{operation_id:key+':bad',title:'Bad',scope:'house'}),{code:'invalid_task_scope'});
    const listed=await s.tasks.list(owner,{scope:'personal'});
    assert.deepEqual(listed.tasks.map((task:any)=>task.id),[health.id]);assert.deepEqual(listed.domains,[{name:'Health',open:1}]);
    // The shared fixture may hold other tests' projects; only this test's are compared.
    assert.deepEqual(listed.scopes.filter((row:any)=>['personal',house,launch,retired].includes(row.id)).map((row:any)=>[row.id,row.name,row.open]),[['personal',null,1],[house,'House',1],[launch,'Launch',1]],'archived projects with no tasks are not offered');
    assert.deepEqual((await s.tasks.list(owner,{scope:launch})).tasks.map((task:any)=>task.id),[site.id]);
    assert.deepEqual((await s.tasks.list(owner,{domain:'Health'})).tasks.map((task:any)=>task.id),[health.id]);
    assert.equal((await s.tasks.list(owner)).tasks.length,3,'all lists together by default');

    // A chat that belongs to a project reaches that project's own list and nothing else.
    const member=await actor((await capture(group,456,'Add a task to write the launch post')).id,group,group);
    const seen=await s.tasks.chatList(member);
    assert.deepEqual(seen.tasks.map((task:any)=>task.id),[site.id]);
    assert.deepEqual(seen.scopes.map((row:any)=>row.id),[launch],'no other list or project is named');
    assert.deepEqual(seen.domains,[{name:'Web',open:1}]);
    await assert.rejects(s.tasks.chatList(member,{scope:'personal'}),{code:'task_scope_denied'});
    const post=await s.tasks.chatCreate(member,{title:'Write the launch post'});
    assert.equal(post.project_id,launch,'a task added in a project chat joins that project');
    await assert.rejects(s.tasks.chatCreate(member,{title:'Sneak',scope:house}),{code:'task_scope_denied'});
    await assert.rejects(s.tasks.chatUpdate(member,health.id,{expected_revision:health.revision,state:'done'}),{status:404},'a personal task is not found from a project chat');
    await assert.rejects(s.tasks.chatUpdate(member,site.id,{expected_revision:site.revision,scope:house}),{code:'task_scope_denied'});
    assert.equal((await s.tasks.chatUpdate(member,site.id,{expected_revision:site.revision,state:'done'})).state,'done');
    const moved=await s.tasks.update(owner,roof.id,{operation_id:key+':move',expected_revision:roof.revision,scope:'personal',domain:'Home'});
    assert.deepEqual([moved.project_id,moved.domain],[null,'Home'],'the owner moves a task between lists');
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

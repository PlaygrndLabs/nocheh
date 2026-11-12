import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {fixtureServices} from './fixture-brain.js';
import {honchoEngine} from '../src/memory/honcho.js';

const states=(counts:any)=>({open:counts.open,done:counts.done,dropped:counts.dropped});

test('the owner keeps task lists from the dashboard and their private chat; an unassigned group reaches none',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-tasks-')),key='tasks:'+Date.now(),group='-'+Date.now();
  const owner:Reader={admin:true,scope:null};
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async operation=>{if(operation==='guard.detect')return {literals:[]};throw Error('runtime_not_expected');},memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
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
    assert.deepEqual(states(open.counts),{open:2,done:0,dropped:0});

    const done=await s.tasks.chatUpdate(chat,added.id,{expected_revision:added.revision,state:'done'});
    assert.equal(done.state,'done');assert.ok(done.done_at);assert.equal(done.revision,added.revision+1);
    await assert.rejects(s.tasks.update(owner,added.id,{operation_id:key+':stale',expected_revision:added.revision,title:'Stale'}),{code:'task_revision_conflict'});
    const reopened=await s.tasks.update(owner,added.id,{operation_id:key+':reopen',expected_revision:done.revision,state:'open',due_on:null});
    assert.equal(reopened.done_at,null);assert.equal(reopened.due_on,null,'clearing the due date is a change');assert.equal(reopened.title,'Renew the passport');
    await assert.rejects(s.tasks.update(owner,digest('missing'),{operation_id:key+':missing',expected_revision:1,state:'done'}),{status:404});
    await assert.rejects(s.tasks.update(owner,added.id,{operation_id:key+':empty',expected_revision:reopened.revision}),{code:'task_change_required'});

    await s.tasks.update(owner,typed.id,{operation_id:key+':drop',expected_revision:typed.revision,state:'dropped'});
    open=await s.tasks.list(owner);
    assert.deepEqual(open.tasks.map((task:any)=>task.id),[added.id]);assert.deepEqual(states(open.counts),{open:1,done:0,dropped:1});
    assert.equal((await s.tasks.list(owner,{state:'all'})).tasks.length,2);
    const first=await s.tasks.list(owner,{state:'all',limit:'1'});
    assert.equal(first.next,'1');assert.equal((await s.tasks.list(owner,{state:'all',limit:'1',after:first.next!})).tasks.length,1);
    await assert.rejects(s.tasks.list(owner,{state:'later'}),{code:'invalid_task_state'});

    // Personal tasks and each project's tasks are separate lists; tags, a group and people label a task within its list.
    await stores.control.query('DELETE FROM owner_tasks');
    const launch=digest(key+':launch'),house=digest(key+':house'),retired=digest(key+':retired');
    for(const [id,name,state] of [[launch,'Launch','active'],[house,'House','active'],[retired,'Retired','archived']])
      await stores.control.query('INSERT INTO projects(id,name,state,revision) VALUES($1,$2,$3,1)',[id,name,state]);
    await stores.control.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1)",[group,launch]);
    const sara=digest(key+':sara'),omid=digest(key+':omid'),gone=digest(key+':gone');
    for(const [id,name,state] of [[sara,'Sara','active'],[omid,'Omid','active'],[gone,'Gone','rejected']])
      await stores.control.query("INSERT INTO memory_entities(id,kind,name,state) VALUES($1,'person',$2,$3)",[id,name,state]);
    const health=await s.tasks.create(owner,{operation_id:key+':health',title:'Book a checkup',tags:['  Health  ','health','Family']});
    assert.deepEqual(health.tags,['Health','Family'],'a tag is kept once whatever its case');assert.equal(health.project_id,null);
    const site=await s.tasks.create(owner,{operation_id:key+':site',title:'Publish the site',scope:launch,tags:['Web'],group:group+'/topic/7',people:[sara,omid]});
    assert.equal(site.group_id,group+'/topic/7');assert.deepEqual(site.people,[{id:omid,name:'Omid'},{id:sara,name:'Sara'}]);
    await assert.rejects(s.tasks.create(owner,{operation_id:key+':ghost',title:'Ghost',people:[gone]}),{code:'task_person_not_found'},'only known, active people are linked');
    await assert.rejects(s.tasks.create(owner,{operation_id:key+':tags',title:'Tags',tags:'Health'}),{code:'invalid_task_tags'});
    await assert.rejects(s.tasks.create(owner,{operation_id:key+':long',title:'Long',tags:['x'.repeat(41)]}),{code:'invalid_task_tag'});
    await assert.rejects(s.tasks.create(owner,{operation_id:key+':topic',title:'Topic',group:group+'/topic/x'}),{code:'invalid_space'});
    // The owner's private chat reaches every list; a task for a project's list waits for the owner's card (ADR-0243).
    const asked=await s.tasks.chatCreate(chat,{title:'Fix the roof',scope:house});
    assert.deepEqual([asked.state,asked.action,asked.project_id],['proposed','add',house],'a task for a project\'s list waits for the owner\'s card');
    assert.equal((await stores.control.query('SELECT count(*)::int AS count FROM owner_tasks WHERE title=$1',['Fix the roof'])).rows[0].count,0,'nothing is written before the owner approves');
    const {fingerprint}=(await stores.control.query('SELECT fingerprint FROM owner_task_requests WHERE id=$1',[asked.request_id])).rows[0];
    const approved=await s.tasks.decide(owner,{id:asked.request_id,fingerprint,decision:'approve'});
    assert.equal(approved.state,'done');
    await assert.rejects(s.tasks.decide(owner,{id:asked.request_id,fingerprint,decision:'deny'}),{code:'action_already_decided'});
    const roof=await s.tasks.get(owner,approved.task_id!);
    assert.deepEqual([roof.project_id,roof.created_by,roof.origin,roof.source_event],[house,{kind:'owner'},'chat',turn.id],'approved, it is the owner\'s own task from their private chat');
    assert.equal((await s.tasks.chatCreate(chat,{title:'Fix the roof',scope:house})).id,roof.id,'the same call again in that turn returns the task');
    await assert.rejects(s.tasks.create(owner,{operation_id:key+':old',title:'Old',scope:retired}),{code:'task_project_archived'});
    await assert.rejects(s.tasks.create(owner,{operation_id:key+':none',title:'None',scope:digest('none')}),{code:'task_project_not_found'});
    await assert.rejects(s.tasks.create(owner,{operation_id:key+':bad',title:'Bad',scope:'house'}),{code:'invalid_task_scope'});
    const listed=await s.tasks.list(owner,{scope:'personal'});
    assert.deepEqual(listed.tasks.map((task:any)=>task.id),[health.id]);assert.deepEqual(listed.tags,[{name:'Family',open:1},{name:'Health',open:1}]);
    // The shared fixture may hold other tests' projects; only this test's are compared.
    assert.deepEqual(listed.scopes.filter((row:any)=>['personal',house,launch,retired].includes(row.id)).map((row:any)=>[row.id,row.name,row.open]),[['personal',null,1],[house,'House',1],[launch,'Launch',1]],'archived projects with no tasks are not offered');
    assert.deepEqual((await s.tasks.list(owner,{scope:launch})).tasks.map((task:any)=>task.id),[site.id]);
    assert.deepEqual((await s.tasks.list(owner,{tag:'HEALTH'})).tasks.map((task:any)=>task.id),[health.id]);
    assert.deepEqual((await s.tasks.list(owner,{group})).tasks.map((task:any)=>task.id),[site.id],'a group finds the tasks of its topics too');
    assert.deepEqual((await s.tasks.list(owner,{person:sara})).tasks.map((task:any)=>task.id),[site.id]);
    assert.equal((await s.tasks.list(owner)).tasks.length,3,'all lists together by default');

    // A chat that belongs to a project reaches that project's own list and nothing else.
    const member=await actor((await capture(group,456,'Add a task to write the launch post')).id,group,group);
    const seen=await s.tasks.chatList(member);
    assert.deepEqual(seen.tasks.map((task:any)=>task.id),[site.id]);
    assert.deepEqual(seen.scopes.map((row:any)=>row.id),[launch],'no other list or project is named');
    assert.deepEqual(seen.tags,[{name:'Web',open:1}]);
    await assert.rejects(s.tasks.chatList(member,{scope:'personal'}),{code:'task_scope_denied'});
    const post=await s.tasks.chatCreate(member,{title:'Write the launch post'});
    assert.equal(post.project_id,launch,'a task added in a project chat joins that project');assert.equal(post.group_id,group,'and points to the group it was asked in');
    await assert.rejects(s.tasks.chatCreate(member,{title:'Sneak',scope:house}),{code:'task_scope_denied'});
    await assert.rejects(s.tasks.chatUpdate(member,health.id,{expected_revision:health.revision,state:'done'}),{status:404},'a personal task is not found from a project chat');
    await assert.rejects(s.tasks.chatUpdate(member,site.id,{expected_revision:site.revision,scope:house}),{code:'task_scope_denied'});
    assert.equal((await s.tasks.chatUpdate(member,site.id,{expected_revision:site.revision,state:'done'})).state,'done');
    const moved=await s.tasks.update(owner,roof.id,{operation_id:key+':move',expected_revision:roof.revision,scope:'personal',tags:['Home'],people:[sara]});
    assert.deepEqual([moved.project_id,moved.tags,moved.people],[null,['Home'],[{id:sara,name:'Sara'}]],'the owner moves a task between lists');
    const cleared=await s.tasks.update(owner,site.id,{operation_id:key+':clear',expected_revision:site.revision+1,group:null,people:[],tags:[]});
    assert.deepEqual([cleared.group_id,cleared.people,cleared.tags],[null,[],[]],'links and tags can be cleared');
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

test('tasks carry statuses, priority, dates, repeats, subtasks, links, columns, comments, history, reminders, archive and trash',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-tasks-')),key='tasks-full:'+Date.now(),group='-'+Date.now();
  const owner:Reader={admin:true,scope:null};
  const notices:any[]=[];let telegram:'done'|'not_started'|'ambiguous'='done';
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='telegram.notice'){notices.push(input);return {state:telegram};}
      throw Error('runtime_not_expected');
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  let serial=0;
  const capture=async(scope:string,from:number,text:string,name='Owner')=>{
    const label=String(++serial),value:Envelope={version:1,key:key+':'+label,origin:'live',kind:'telegram_update',bot_id:key,scope,source_id:label,revision:'1',occurred_at:null,text,
      payload:{message:{message_id:serial,date:1700000000,chat:{id:Number(scope),type:scope==='123'?'private':'supergroup',is_forum:false},from:{id:from,first_name:name},text}}};
    const source=(await s.capture.capture(value)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const actor=async(source:string,scope:string|null,space:string):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope,space,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  let op=0;const next=()=>key+':'+(++op);
  const add=(body:Record<string,unknown>)=>s.tasks.create(owner,{operation_id:next(),...body});
  const edit=(task:any,body:Record<string,unknown>)=>s.tasks.update(owner,task.id,{operation_id:next(),expected_revision:task.revision,...body});
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    await stores.control.query('DELETE FROM owner_tasks');await stores.control.query("UPDATE owner_task_settings SET settings='{}'::jsonb");

    // Statuses and priority names are the owner's; each kind of state keeps at least one status.
    let settings=await s.tasks.settings(owner);
    assert.deepEqual(settings.statuses.map((status:any)=>[status.id,status.category]),[['todo','not_started'],['doing','active'],['waiting','active'],['done','done'],['dropped','cancelled']]);
    assert.equal(settings.time_zone,'UTC');
    const task=await add({title:'Write the report',status:'in progress',priority:'High',start_on:'2030-01-02',due_on:'2030-01-04',due_time:'09:30'});
    assert.deepEqual([task.status,task.state,task.priority,task.start_on,task.due_on,task.due_time],['doing','open',3,'2030-01-02','2030-01-04','09:30'],'a status and priority can be given by name');
    await assert.rejects(add({title:'Bad status',status:'someday'}),{code:'invalid_task_status'});
    await assert.rejects(add({title:'Time alone',due_time:'09:00'}),{code:'task_due_time_needs_day'});
    await assert.rejects(add({title:'Backwards',start_on:'2030-01-05',due_on:'2030-01-04'}),{code:'task_start_after_due'});
    await assert.rejects(add({title:'Bad time',due_on:'2030-01-04',due_time:'25:00'}),{code:'invalid_task_time'});
    const done=await edit(task,{state:'done'});
    assert.deepEqual([done.status,done.state,done.finished_by],['done','done',{kind:'owner'}],'finishing picks the first done status');
    const back=await edit(done,{status:'waiting'});
    assert.deepEqual([back.state,back.done_at,back.finished_by],['open',null,null]);
    assert.equal((await edit(back,{status:'waiting'})).revision,back.revision,'an edit that changes nothing keeps the revision');
    await assert.rejects(s.tasks.saveSettings(owner,{revision:settings.revision,statuses:settings.statuses.filter((status:any)=>status.category!=='cancelled')}),{code:'task_status_category_required'});
    settings=await s.tasks.saveSettings(owner,{revision:settings.revision,statuses:[{id:'todo',name:'Inbox',category:'not_started',color:'neutral'},
      {id:'doing',name:'Doing',category:'active',color:'info'},{id:'done',name:'Done',category:'done',color:'good'},{id:'dropped',name:'Dropped',category:'cancelled',color:'bad'}],
      priorities:['None','Low','Normal','Important','Now'].map((name,level)=>({level,name,color:'neutral'})),
      properties:[{id:'effort',name:'Effort',type:'number'},{id:'area',name:'Area',type:'select',options:[{id:'home',name:'Home'},{id:'work',name:'Work'}]},
        {id:'link',name:'Link',type:'url'}],time_zone:'Asia/Kolkata'});
    await assert.rejects(s.tasks.saveSettings(owner,{revision:'0',time_zone:'UTC'}),{code:'configuration_conflict'});
    await assert.rejects(s.tasks.saveSettings(owner,{revision:settings.revision,time_zone:'Mars/Base'}),{code:'invalid_task_time_zone'});
    const moved=(await s.tasks.get(owner,task.id));
    assert.equal(moved.status,'doing','a removed status sends its tasks to the first status of the same kind');
    assert.equal((await add({title:'Now',priority:'now'})).priority,4,'renamed priorities are understood by name');

    // The owner's own columns, by name or ID; a removed choice leaves the tasks that used it.
    const columns=await edit(moved,{properties:{Effort:3,area:'Work',Link:'https://example.com/report'}});
    assert.deepEqual(columns.properties,{area:'work',effort:3,link:'https://example.com/report'});
    await assert.rejects(edit(columns,{properties:{Effort:'three'}}),{code:'invalid_task_property_value'});
    await assert.rejects(edit(columns,{properties:{Colour:'red'}}),{code:'unknown_task_property'});
    await assert.rejects(edit(columns,{properties:{Link:'javascript:alert(1)'}}),{code:'invalid_task_url'});
    const cleared=await edit(columns,{properties:{Effort:null}});
    assert.deepEqual(cleared.properties,{area:'work',link:'https://example.com/report'});
    settings=await s.tasks.saveSettings(owner,{revision:settings.revision,properties:[{id:'area',name:'Area',type:'select',options:[{id:'home',name:'Home'}]}]});
    assert.deepEqual((await s.tasks.get(owner,task.id)).properties,{},'removing a column or a choice clears it from tasks');

    // Subtasks live in their parent's list; moving the parent moves them, and a task cannot sit under itself.
    const launch=digest(key+':launch'),house=digest(key+':house');
    for(const [id,name] of [[launch,'Launch'],[house,'House']])await stores.control.query("INSERT INTO projects(id,name,state,revision) VALUES($1,$2,'active',1)",[id,name]);
    await stores.control.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1)",[group,launch]);
    const site=await add({title:'Build the site',scope:launch});
    const page=await add({title:'Write the about page',parent:site.id});
    assert.deepEqual([page.parent_id,page.project_id],[site.id,launch],'a subtask joins its parent\'s list');
    const copy=await add({title:'Proofread',parent:page.id});
    await assert.rejects(add({title:'Elsewhere',parent:site.id,scope:house}),{code:'task_parent_other_list'});
    const current=await s.tasks.get(owner,site.id);
    await assert.rejects(edit(current,{parent:copy.id}),{code:'task_parent_cycle'});
    assert.deepEqual(current.subtasks.map((item:any)=>item.id),[page.id]);assert.deepEqual(current.subtasks[0].subtasks,{open:1,total:1});
    await edit(current,{scope:house});
    assert.equal((await s.tasks.get(owner,copy.id)).project_id,house,'moving a task moves everything under it');
    assert.deepEqual((await s.tasks.list(owner,{scope:house,parent:'top'})).tasks.map((item:any)=>item.id),[site.id]);

    // Links: waiting on a task, related and duplicate; a project chat never sees a task in another list.
    const blocker=await add({title:'Buy the domain',scope:launch});
    const waiting=await add({title:'Publish',scope:launch,blocked_by:[blocker.id],related:[site.id]});
    assert.deepEqual(waiting.blocked_by.map((item:any)=>item.title),['Buy the domain']);
    const detail=await s.tasks.get(owner,blocker.id);
    assert.deepEqual(detail.blocking.map((item:any)=>item.id),[waiting.id]);
    assert.deepEqual((await s.tasks.get(owner,site.id)).related.map((item:any)=>item.id),[waiting.id],'a related task shows from both sides');
    await assert.rejects(add({title:'Self',blocked_by:[digest('missing')]}),{status:404});
    const member=await actor((await capture(group,456,'What is left for the launch?','Sara')).id,group,group);
    assert.deepEqual((await s.tasks.chatGet(member,waiting.id)).related,[],'a link to another list is hidden in a project chat');
    await assert.rejects(s.tasks.chatGet(member,site.id),{status:404});
    await assert.rejects(s.tasks.chatCreate(member,{title:'Sneak',blocked_by:[site.id]}),{status:404});
    await assert.rejects(s.tasks.chatCreate(member,{title:'Peek',attachments:[{kind:'message',id:digest('x')}]}),{code:'task_attachment_denied'});

    // Who does a task and who it is about are separate; people come from Memory › People.
    const sara=digest(key+':sara'),omid=digest(key+':omid');
    for(const [id,name] of [[sara,'Sara'],[omid,'Omid']])await stores.control.query("INSERT INTO memory_entities(id,kind,name,state) VALUES($1,'person',$2,'active')",[id,name]);
    const shared=await edit(waiting,{assignees:[sara],people:[omid],attachments:[{kind:'link',url:'https://example.com/brief',title:'Brief'},{kind:'message',id:digest('m')}]});
    assert.deepEqual([shared.assignees,shared.people],[[{id:sara,name:'Sara'}],[{id:omid,name:'Omid'}]]);
    assert.deepEqual(shared.attachments.map((item:any)=>item.kind),['link','message']);
    assert.deepEqual((await s.tasks.list(owner,{person:sara})).tasks.map((item:any)=>item.id),[waiting.id],'a person filter finds the tasks they do');

    // A project chat records who asked and comments as that person; the history shows every change.
    const added=await s.tasks.chatCreate(member,{title:'Check the copy',priority:2});
    assert.deepEqual(added.created_by,{kind:'member',name:'Sara'});assert.equal(added.project_id,launch);
    const talk=await s.tasks.chatComment(member,added.id,{text:'Waiting for the final text'});
    assert.deepEqual(talk.comments.map((item:any)=>[item.body,item.author]),[['Waiting for the final text',{kind:'member',name:'Sara'}]]);
    const remark=await s.tasks.comment(owner,added.id,{operation_id:next(),text:'Thanks'});
    assert.equal(remark.comments.length,2);
    assert.equal((await s.tasks.comment(owner,added.id,{operation_id:next(),remove:remark.comments[1].id})).comments.length,1);
    await assert.rejects(s.tasks.comment(owner,added.id,{operation_id:next(),text:'  '}),{code:'task_comment_required'});
    const history=(await s.tasks.get(owner,task.id)).activity;
    assert.ok(history.some((item:any)=>item.changes.status_id?.to==='done'),'a status change is in the history');
    assert.ok(history.some((item:any)=>item.changes.created),'and so is the task being made');

    // Today and Upcoming follow the owner's time zone.
    await stores.control.query('DELETE FROM owner_tasks');
    const today=(await stores.control.query(`SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS day`)).rows[0].day as string;
    const shift=(days:number)=>new Date(Date.parse(today+'T00:00:00Z')+days*864e5).toISOString().slice(0,10);
    const late=await add({title:'Late',due_on:shift(-2)}),now=await add({title:'Today',start_on:today}),soon=await add({title:'Soon',due_on:shift(3)});
    await add({title:'Later',due_on:shift(30)});await add({title:'Someday'});
    let list=await s.tasks.list(owner,{when:'today'});
    assert.deepEqual(list.tasks.map((item:any)=>item.id),[late.id,now.id]);assert.equal(list.today,today);
    assert.deepEqual((await s.tasks.list(owner,{when:'upcoming'})).tasks.map((item:any)=>item.id),[soon.id]);
    assert.deepEqual([list.counts.today,list.counts.upcoming,list.counts.open],[2,1,5]);

    // A repeating task makes its next one when it is finished, with its dates and reminders moved on.
    const weekly=await add({title:'Water the plants',due_on:shift(1),start_on:shift(0),repeat:{every:1,unit:'week'},reminders:[shift(1)+'T08:00'],tags:['Home'],people:[omid]});
    assert.deepEqual(weekly.reminders.map((item:any)=>[item.at,item.state]),[[new Date(Date.parse(shift(1)+'T08:00:00+05:30')).toISOString(),'pending']],'a reminder without an offset is in the owner\'s time zone');
    await assert.rejects(edit(weekly,{reminders:['2001-01-01T08:00Z']}),{code:'task_reminder_past'});
    await assert.rejects(add({title:'Bad repeat',repeat:{every:0,unit:'week'}}),{code:'invalid_task_repeat'});
    const finished=await edit(weekly,{state:'done'});
    assert.ok(finished.repeated_to);
    const following=await s.tasks.get(owner,finished.repeated_to);
    assert.deepEqual([following.state,following.status,following.start_on,following.due_on,following.tags,following.people.map((item:any)=>item.id),following.origin],
      ['open','todo',shift(7),shift(8),['Home'],[omid],'repeat']);
    assert.deepEqual(following.reminders.map((item:any)=>item.at),[new Date(Date.parse(shift(8)+'T08:00:00+05:30')).toISOString()]);
    const again=await edit(await edit(finished,{state:'open'}),{state:'done'});
    assert.equal(again.repeated_to,finished.repeated_to,'finishing it again makes no second copy');
    const {nextRepeat}=await import('../src/stores/task-settings.js');
    assert.equal(nextRepeat('2030-01-31',{every:1,unit:'month',from:'due'}),'2030-02-28','a month later stops at the end of a shorter month');
    assert.equal(nextRepeat('2030-01-07',{every:1,unit:'week',weekdays:[1,4],from:'due'}),'2030-01-10','weekly on chosen days goes to the next chosen day');
    assert.equal(nextRepeat('2030-01-10',{every:2,unit:'week',weekdays:[1,4],from:'due'}),'2030-01-21','and skips the weeks in between');

    // Due reminders go to the owner's private chat once; a finished task's reminder is skipped.
    await stores.control.query("UPDATE owner_task_reminders SET remind_at=now()-interval '1 minute' WHERE task_id=$1",[following.id]);
    const quiet=await add({title:'Quiet',reminders:[new Date(Date.now()+120000).toISOString()]});
    await stores.control.query("UPDATE owner_task_reminders SET remind_at=now()-interval '1 minute' WHERE task_id=$1",[quiet.id]);
    await edit(quiet,{state:'dropped'});
    telegram='not_started';
    assert.equal(await s.tasks.remind(),1,'only the skipped reminder is handled while Telegram is not connected');
    telegram='done';
    assert.equal(await s.tasks.remind(),1);
    assert.equal(notices.length,2,'the same reminder is offered again after Telegram was not connected');
    assert.deepEqual(notices.at(-1),{id:notices[0].id,chat_id:'123',text:`⏰ Water the plants\n📅 ${new Date(shift(8)+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric',timeZone:'UTC'})}`});
    assert.equal(await s.tasks.remind(),0,'a sent reminder is not sent again');
    assert.deepEqual((await s.tasks.get(owner,following.id)).reminders.map((item:any)=>item.state),['sent']);
    assert.deepEqual((await s.tasks.get(owner,quiet.id)).reminders.map((item:any)=>item.state),['skipped']);

    // Archive hides finished work; trash hides a task and everything under it until it is restored or deleted for good.
    const parent=await add({title:'Clean the garage'}),child=await add({title:'Sort the boxes',parent:parent.id});
    assert.equal((await s.tasks.archiveFinished(owner,{operation_id:next()})).archived,2,'the finished weekly task and the dropped one');
    list=await s.tasks.list(owner,{state:'all'});
    assert.ok(!list.tasks.some((item:any)=>item.state!=='open'));assert.equal(list.counts.archive,2);
    assert.equal((await s.tasks.list(owner,{state:'all',in:'archive'})).tasks.length,2);
    const trashed=await edit(parent,{trashed:true});
    assert.ok(trashed.deleted_at);
    assert.deepEqual((await s.tasks.list(owner,{in:'trash'})).tasks.map((item:any)=>item.id).sort(),[child.id,parent.id].sort(),'trashing a task trashes its subtasks');
    await assert.rejects(edit(trashed,{title:'Edit in trash'}),{code:'task_in_trash'});
    await assert.rejects(s.tasks.remove(owner,now.id),{code:'task_not_in_trash'});
    const restored=await edit(trashed,{trashed:false});
    assert.equal((await s.tasks.get(owner,child.id)).deleted_at,null,'restoring brings the subtasks back');
    await s.tasks.remove(owner,(await edit(restored,{trashed:true})).id);
    await assert.rejects(s.tasks.get(owner,child.id),{status:404},'deleting for good removes the subtasks too');

    // Outside IDs wait for a later sync; manual order sticks.
    const synced=await edit(now,{external:{notion:'page-123'},position:0.5});
    assert.deepEqual(synced.external,{notion:'page-123'});
    await assert.rejects(edit(synced,{external:{'Bad Name':'x'}}),{code:'invalid_task_external'});
    assert.equal((await s.tasks.list(owner,{sort:'manual'})).tasks[0].id,now.id);
    await assert.rejects(s.tasks.chatUpdate(member,now.id,{expected_revision:synced.revision,external:{}}),{code:'unknown_task_field'},'the assistant cannot set outside IDs');
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

test('a project chat sees a task only as it is on that project\'s board, from when it joined',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-tasks-')),key='tasks-board:'+Date.now(),group='-'+Date.now(),porch='-3'+Date.now();
  const owner:Reader={admin:true,scope:null};
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>({enabled:true,owner_id:'123',group_ids:[group,porch]}),
    runtime:async operation=>{if(operation==='guard.detect')return {literals:[]};throw Error('runtime_not_expected');},memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  let serial=0;
  const capture=async(scope:string,from:number,text:string,name='Owner')=>{
    const label=String(++serial),value:Envelope={version:1,key:key+':'+label,origin:'live',kind:'telegram_update',bot_id:key,scope,source_id:label,revision:'1',occurred_at:null,text,
      payload:{message:{message_id:serial,date:1700000000,chat:{id:Number(scope),type:scope==='123'?'private':'supergroup',is_forum:false},from:{id:from,first_name:name},text}}};
    const source=(await s.capture.capture(value)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const actor=async(source:string,scope:string|null,space:string):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope,space,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const approve=async(result:any)=>{
    assert.equal(result.state,'proposed');
    const {fingerprint}=(await stores.control.query('SELECT fingerprint FROM owner_task_requests WHERE id=$1',[result.request_id])).rows[0];
    return s.tasks.decide(owner,{id:result.request_id,fingerprint,decision:'approve'});
  };
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    await stores.control.query('DELETE FROM owner_tasks');await stores.control.query("UPDATE owner_task_settings SET settings='{}'::jsonb");
    const mark=String(Date.now()),launch=digest(key+':launch'),house=digest(key+':house');
    for(const [id,name] of [[launch,'Launch'],[house,'House']])await stores.control.query("INSERT INTO projects(id,name,state,revision) VALUES($1,$2,'active',1)",[id,name]);
    await stores.control.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1)",[group,launch]);
    await stores.control.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1)",[porch,house]);
    // Effort is shared with project chats; Secret is the owner's own.
    const settings=await s.tasks.settings(owner);
    await s.tasks.saveSettings(owner,{revision:settings.revision,properties:[{id:'effort',name:'Effort',type:'number',shared:true},{id:'secret',name:'Secret',type:'text'}]});

    // A personal task from the owner's private chat, with what only the owner sees: a comment, an archived message, a
    // Notion ID, a private column, a sent reminder and an earlier title.
    const turn=await capture('123',123,'Remember to check the venue'),chat=await actor(turn.id,null,'123');
    const task=await s.tasks.chatCreate(chat,{title:'canary-title-'+mark,notes:'Two rooms'});
    assert.equal(task.project_id,null,'a personal task is written at once');
    await s.tasks.chatComment(chat,task.id,{text:'canary-comment-'+mark});
    const planted=await s.tasks.update(owner,task.id,{operation_id:key+':plant',expected_revision:task.revision,title:'Check the venue',
      attachments:[{kind:'message',id:turn.id,title:'canary-label-'+mark},{kind:'link',url:'https://example.com/venue',title:'Venue'}],
      external:{notion:'page-canary-'+mark},properties:{Secret:'canary-col-'+mark,Effort:3},reminders:[new Date(Date.now()+864e5).toISOString()]});
    await stores.control.query("INSERT INTO owner_task_reminders(id,task_id,remind_at,state,sent_at) VALUES($1,$2,now()-interval '1 day','sent',now())",[digest(key+':sent'),task.id]);

    // Moving it into the project's list from the private chat waits for the owner's card.
    const move=await s.tasks.chatUpdate(chat,task.id,{expected_revision:planted.revision,scope:launch});
    assert.deepEqual([move.state,move.action,move.task_id],['proposed','update',task.id]);
    assert.equal((await s.tasks.get(owner,task.id)).project_id,null,'nothing moves before the owner approves');
    assert.equal((await approve(move)).state,'done');

    const member=await actor((await capture(group,456,'What is on the launch list?','Sara')).id,group,group);
    const seen=await s.tasks.chatGet(member,task.id),listed=await s.tasks.chatList(member);
    for(const canary of ['canary-comment-'+mark,'canary-label-'+mark,'canary-col-'+mark,'canary-title-'+mark,'page-canary-'+mark,turn.id,'Secret','"secret"'])
      for(const [name,value] of [['get',seen],['list',listed]] as const)assert.ok(!JSON.stringify(value).includes(canary),`${name} shows ${canary}`);
    assert.deepEqual(seen.activity.map((item:any)=>item.changes),[{project_id:{to:launch}}],'history starts when it joined, which shows only where it went');
    assert.deepEqual([seen.comments,listed.tasks.find((item:any)=>item.id===task.id).comments],[[],0],'earlier comments are neither shown nor counted');
    assert.deepEqual(seen.attachments.map((item:any)=>[item.kind,item.title]),[['link','Venue']]);
    assert.deepEqual(seen.properties,{effort:3},'only shared columns');
    assert.deepEqual(listed.settings.properties.map((item:any)=>item.name),['Effort'],'and only their names');
    assert.deepEqual(seen.reminders.map((item:any)=>item.state),['pending'],'only reminders still to come');
    assert.deepEqual([seen.external,seen.source_event,seen.notes],[undefined,undefined,'Two rooms']);

    // What happens on the board from then on is seen there.
    const talk=await s.tasks.chatComment(member,task.id,{text:'Booked for Friday'});
    assert.deepEqual(talk.comments.map((item:any)=>item.body),['Booked for Friday']);
    assert.equal((await s.tasks.chatList(member)).tasks.find((item:any)=>item.id===task.id).comments,1);
    // A link edit from the group keeps the owner's archived message; a column the owner keeps is unknown there.
    const links=await s.tasks.chatUpdate(member,task.id,{expected_revision:seen.revision,attachments:[{kind:'link',url:'https://example.com/map',title:'Map'}]});
    assert.deepEqual(links.attachments.map((item:any)=>item.title),['Map']);
    assert.deepEqual((await s.tasks.get(owner,task.id)).attachments.map((item:any)=>[item.kind,item.title]),[['message','canary-label-'+mark],['link','Map']]);
    await assert.rejects(s.tasks.chatUpdate(member,task.id,{expected_revision:links.revision,properties:{Secret:'x'}}),{code:'unknown_task_property'});
    assert.equal((await s.tasks.chatUpdate(member,task.id,{expected_revision:links.revision,properties:{Effort:5}})).properties.effort,5);
    // The owner still sees everything.
    const full=await s.tasks.get(owner,task.id);
    assert.deepEqual([full.properties,full.external,full.source_event],[{effort:5,secret:'canary-col-'+mark},{notion:'page-canary-'+mark},turn.id]);
    assert.deepEqual(full.comments.map((item:any)=>item.body),['canary-comment-'+mark,'Booked for Friday']);
    assert.ok(full.activity.some((item:any)=>item.changes.title?.from==='canary-title-'+mark));
    assert.equal(full.reminders.length,2);

    // A link edit from the group replaces only the links it sees: the owner's links to tasks elsewhere stay.
    const errand=await s.tasks.create(owner,{operation_id:key+':errand',title:'canary-errand-'+mark});
    const flyers=await s.tasks.create(owner,{operation_id:key+':flyers',title:'Print the flyers',scope:launch});
    const tied=await s.tasks.update(owner,task.id,{operation_id:key+':tie',expected_revision:full.revision,blocked_by:[errand.id],related:[errand.id,flyers.id]});
    const retied=await s.tasks.chatGet(member,task.id);
    assert.deepEqual([retied.blocked_by,retied.related.map((item:any)=>item.id)],[[],[flyers.id]],'a link to a task elsewhere is not shown');
    const waits=await s.tasks.chatUpdate(member,task.id,{expected_revision:tied.revision,blocked_by:[flyers.id],related:[]});
    assert.deepEqual([waits.blocked_by.map((item:any)=>item.id),JSON.stringify(waits).includes('canary-errand-'+mark)],[[flyers.id],false]);
    const linkedUp=await s.tasks.get(owner,task.id);
    assert.deepEqual(linkedUp.blocked_by.map((item:any)=>item.id).sort(),[errand.id,flyers.id].sort(),'the owner\'s link to a personal task stays');
    assert.deepEqual(linkedUp.related.map((item:any)=>item.id),[errand.id]);

    // The group always has its own 20 links, whatever the owner attached: the hidden messages are not counted.
    const many=Array.from({length:20},(_,index)=>({kind:'message',id:digest(key+':m'+index),title:'canary-many-'+mark}));
    const loaded=await s.tasks.update(owner,task.id,{operation_id:key+':many',expected_revision:linkedUp.revision,attachments:[...many,{kind:'link',url:'https://example.com/a'}]});
    const twenty=Array.from({length:20},(_,index)=>({kind:'link',url:'https://example.com/'+index}));
    const filled=await s.tasks.chatUpdate(member,task.id,{expected_revision:loaded.revision,attachments:twenty});
    assert.deepEqual([filled.attachments.length,JSON.stringify(filled).includes('canary-many-'+mark)],[20,false]);
    await assert.rejects(s.tasks.chatUpdate(member,task.id,{expected_revision:filled.revision,attachments:[...twenty,{kind:'link',url:'https://example.com/x'}]}),{code:'invalid_task_attachments'});
    const both=await s.tasks.get(owner,task.id);
    assert.deepEqual(['message','link'].map(kind=>both.attachments.filter((item:any)=>item.kind===kind).length),[20,20]);
    await assert.rejects(s.tasks.update(owner,task.id,{operation_id:key+':more',expected_revision:both.revision,attachments:[...many,{kind:'message',id:digest(key+':m20')}]}),
      {code:'invalid_task_attachments'},'up to 20 archived messages');

    // A task made and finished in another project's group shows neither that group nor who made or finished it.
    const porchTask=await s.tasks.create(owner,{operation_id:key+':porch',title:'Paint the porch',scope:house,group:porch});
    await stores.control.query(`UPDATE owner_tasks SET created_by='{"kind":"member","name":"Alice"}',finished_by='{"kind":"member","name":"Alice"}',state='done',
      status_id='done',done_at=now() WHERE id=$1`,[porchTask.id]);
    const painted=await s.tasks.get(owner,porchTask.id);
    await s.tasks.update(owner,porchTask.id,{operation_id:key+':porch-move',expected_revision:painted.revision,scope:launch});
    const repainted=await s.tasks.chatGet(member,porchTask.id);
    assert.deepEqual([repainted.group_id,repainted.created_by,repainted.finished_by],[null,null,null]);
    assert.ok(!JSON.stringify(repainted).includes(porch)&&!JSON.stringify(repainted).includes('Alice'),'another group and its people stay private');
    assert.deepEqual((await s.tasks.chatList(member,{group:porch,state:'all'})).tasks,[],'nor is a task found by that group');
    const banner=await s.tasks.chatCreate(member,{title:'Hang the banner'});
    assert.deepEqual([banner.group_id,banner.created_by],[group,{kind:'member',name:'Sara'}],'a task made on the list shows its group and who made it');
    assert.deepEqual((await s.tasks.chatList(member,{group,state:'all'})).tasks.map((item:any)=>item.id),[banner.id]);
    const own=await s.tasks.get(owner,porchTask.id);
    assert.deepEqual([own.group_id,own.created_by.name],[porch,'Alice'],'the owner still sees them');

    // A personal task moved under a project's task joins that list with everything under it, from then on.
    const top=await s.tasks.create(owner,{operation_id:key+':top',title:'Plan the launch',scope:launch});
    const box=await s.tasks.chatCreate(chat,{title:'Pack the boxes'}),inner=await s.tasks.chatCreate(chat,{title:'Label the boxes',parent:box.id});
    await s.tasks.chatComment(chat,inner.id,{text:'canary-sub-'+mark});
    const under=await s.tasks.chatUpdate(chat,box.id,{expected_revision:box.revision,parent:top.id});
    assert.equal(under.project_id,launch,'a new parent in a project\'s list moves a task into it, so it waits for the card');
    await approve(under);
    for(const id of [box.id,inner.id]) {
      const value=await s.tasks.chatGet(member,id);
      assert.ok(value.project_since,'a subtask joins with its parent');assert.deepEqual(value.comments,[]);
      assert.ok(!JSON.stringify(value).includes('canary-sub-'+mark));
    }
    assert.equal((await s.tasks.chatGet(member,inner.id)).parent.id,box.id);

    // A move from another project's list hides that list and its comments.
    const shed=await s.tasks.create(owner,{operation_id:key+':shed',title:'Clear the shed',scope:house});
    await s.tasks.comment(owner,shed.id,{operation_id:key+':shed-note',text:'canary-house-'+mark});
    await s.tasks.update(owner,shed.id,{operation_id:key+':shed-move',expected_revision:shed.revision,scope:launch});
    const there=await s.tasks.chatGet(member,shed.id);
    assert.deepEqual([there.comments,there.activity.map((item:any)=>item.changes)],[[],[{project_id:{to:launch}}]]);
    assert.ok(!JSON.stringify(there).includes(house)&&!JSON.stringify(there).includes('canary-house-'+mark),'the earlier list stays private');
    // A project's task with no joining time shows no comments or history.
    await stores.control.query('UPDATE owner_tasks SET project_since=NULL WHERE id=$1',[task.id]);
    const unknown=await s.tasks.chatGet(member,task.id);
    assert.deepEqual([unknown.comments,unknown.activity],[[],[]]);
    assert.equal((await s.tasks.chatList(member)).tasks.find((item:any)=>item.id===task.id).comments,0);
    // Its next comment or change gives it a joining time: what is written from then on shows, nothing before it does.
    const again=await s.tasks.chatComment(member,task.id,{text:'Still on for Friday'});
    assert.deepEqual(again.comments.map((item:any)=>item.body),['Still on for Friday']);
    const renamed=await s.tasks.chatUpdate(member,task.id,{expected_revision:again.revision,title:'Check the venue again'});
    assert.deepEqual(renamed.revision,again.revision+1);
    assert.deepEqual((await s.tasks.chatGet(member,task.id)).activity.map((item:any)=>item.changes.title?.to),['Check the venue again']);

    // A comment written while a task moves in, on a task under it, stays private: the move holds every task under it
    // before it reads its joining time.
    const shelf=await s.tasks.create(owner,{operation_id:key+':shelf',title:'Build the shelf'});
    const plank=await s.tasks.create(owner,{operation_id:key+':plank',title:'Cut the planks',parent:shelf.id});
    const hold=new pg.Client({...config,database:'nocheh_control'});await hold.connect();
    try {
      await hold.query('BEGIN');await hold.query('SELECT 1 FROM owner_tasks WHERE id=$1 FOR UPDATE',[shelf.id]);
      const moving=s.tasks.update(owner,shelf.id,{operation_id:key+':shelf-move',expected_revision:shelf.revision,scope:launch});
      // The move has begun and waits for the task; a comment on the task under it starts and ends meanwhile.
      const holder=(await hold.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      for(let tries=0;!(await hold.query('SELECT 1 FROM pg_locks WHERE NOT granted AND $1=ANY(pg_blocking_pids(pid))',[holder])).rows.length;tries++){
        assert.ok(tries<200,'the move waits for the task');await new Promise(done=>setTimeout(done,25));
      }
      await s.tasks.comment(owner,plank.id,{operation_id:key+':plank-note',text:'canary-race-'+mark});
      await hold.query('COMMIT');
      assert.equal((await moving).project_id,launch);
    }finally{await hold.end();}
    const cut=await s.tasks.chatGet(member,plank.id);
    assert.deepEqual([cut.project_id,cut.comments],[launch,[]]);
    assert.ok(!JSON.stringify(cut).includes('canary-race-'+mark));
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

test('from the owner\'s private chat, a change a project\'s chats would see waits for a card that names them',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-tasks-')),key='tasks-card:'+Date.now();
  const group='-'+Date.now(),forum='-100'+Date.now(),other='-2'+Date.now();
  const owner:Reader={admin:true,scope:null},cards:Record<string,any>[]=[];
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>({enabled:true,owner_id:'123',group_ids:[group,forum,other]}),
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      assert.equal(operation,'telegram.approval');cards.push(input);
      return input.kind==='card'?{state:'done',chat_id:input.chat_id,message_id:'5'}:{state:'done'};
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  const bot=String(Date.now()).slice(-9);let serial=0,updates=0,messages=100;
  const capture=async(scope:string,from:number,payload:Record<string,unknown>)=>{
    const label=String(++serial),update=payload.update_id;
    const value:Envelope={version:1,key:update?`telegram:${bot}:update:${update}`:key+':'+label,origin:'live',kind:'telegram_update',bot_id:update?bot:key,scope,
      source_id:update?String(update):label,revision:'1',occurred_at:null,text:'',payload};
    const source=(await s.capture.capture(value)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const ask=(text:string)=>capture('123',123,{message:{message_id:++messages,date:1700000000,chat:{id:123,type:'private'},from:{id:123,first_name:'Owner'},text}});
  const press=(data:string,from=123)=>capture('123',from,{update_id:++updates,callback_query:{id:'query-'+updates,from:{id:from},chat_instance:'1',data,
    message:{message_id:5,date:1700000000,chat:{id:123,type:'private'},reply_markup:{inline_keyboard:[[{text:'Approve',callback_data:data}]]}}}});
  const actor=async(source:string):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope:null,space:'123',turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const last=(kind:string)=>cards.filter(card=>card.kind===kind).at(-1)!;
  const tasks=async(title:string)=>(await stores.control.query('SELECT id,project_id FROM owner_tasks WHERE title=$1',[title])).rows;
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    await stores.control.query('DELETE FROM owner_tasks');await stores.control.query("UPDATE owner_task_settings SET settings='{}'::jsonb");
    const launch=digest(key+':launch'),house=digest(key+':house');
    for(const [id,name] of [[launch,'Launch'],[house,'House']])await stores.control.query("INSERT INTO projects(id,name,state,revision) VALUES($1,$2,'active',1)",[id,name]);
    // The launch list is seen in a group and in one topic of a forum; a private chat assigned to it is not a group, so it is not named.
    for(const space of [group,forum+'/topic/7','456'])
      await stores.control.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1)",[space,launch]);
    for(const [chat,title,forumChat] of [[group,'Launch team',false],[forum,'Plans team',true]] as const)
      await stores.control.query(`INSERT INTO telegram_chat_observations(chat_id,state,chat_type,title,username,is_forum,migrate_to_chat_id,observed_at)
        VALUES($1,'available','supergroup',$2,NULL,$3,NULL,now()) ON CONFLICT DO NOTHING`,[chat,title,forumChat]);
    await stores.control.query("INSERT INTO telegram_topic_registrations(chat_id,topic_id,name) VALUES($1,7,'Venue')",[forum]);
    const seenIn='👥 Seen in “Plans team” › Venue, “Launch team”';

    // A new task for the launch list: one card, the reply to the request, naming both chats and showing the task exactly.
    const turn=await ask('Add booking the venue to the launch list'),chat=await actor(turn.id);
    const body={title:'Book the venue',scope:launch,notes:'Two rooms',tags:['Venue']};
    const asked=await s.tasks.chatCreate(chat,body);
    assert.equal(asked.state,'proposed');assert.deepEqual(await tasks('Book the venue'),[]);
    assert.equal((await s.tasks.chatCreate(chat,body)).request_id,asked.request_id,'the same call in one turn reuses its request');
    const offered=await s.actionCommands.offer('task',asked),card=last('card');
    assert.deepEqual([card.chat_id,card.id,card.reply_to],['123',asked.request_id,String(messages)],'the card answers the request in the private chat');
    assert.equal(card.text,`📋 Add a task to the list of “Launch”\n${seenIn}\n\nTitle: Book the venue\nNotes: Two rooms\nStatus: To do\nTags: Venue`);
    assert.ok(card.links.some((link:any)=>link.url===`https://t.me/c/${forum.slice(4)}/7`),'the topic links to Telegram');
    assert.match(offered.message,/posted here as the reply to it[^]*\[NO_REPLY\]/);
    const [[,yes],[,no]]=card.buttons;
    assert.match(yes,/^na[a-f0-9]{56}$/);assert.match(no,/^nd[a-f0-9]{56}$/);
    // Only the owner's press decides it; approved, it is the owner's own task from their private chat.
    assert.equal(await s.actionCommands.callback(await press(yes,456)),true);
    assert.equal(last('answer').text,'Only the owner can approve or reject this.');assert.deepEqual(await tasks('Book the venue'),[]);
    assert.equal(await s.actionCommands.callback(await press(yes)),true);
    assert.equal(last('answer').text,'✅ Approved and changed.');
    const made=await s.tasks.get(owner,(await tasks('Book the venue'))[0].id);
    assert.deepEqual([made.project_id,made.created_by,made.origin,made.source_event],[launch,{kind:'owner'},'chat',turn.id]);
    assert.equal(last('settle').text,card.text+'\n\n✅ Approved and changed.');
    assert.equal((await s.tasks.chatCreate(chat,body)).id,made.id,'asked again in that turn, it is the same task');
    assert.equal(await s.actionCommands.callback(await press(yes)),true);
    assert.equal(last('answer').text,'This request was already decided or can no longer change. Review it in the dashboard Inbox.');

    // Status, priority and dates change at once; other changes wait for a card that shows the task and the change.
    const started=await s.actionCommands.offer('task',await s.tasks.chatUpdate(chat,made.id,{expected_revision:made.revision,status:'doing',priority:2,due_on:'2030-01-04'}));
    assert.deepEqual([started.status,started.priority,started.due_on],['doing',2,'2030-01-04']);
    // A repeat or a reminder, which the list's chats see too, is not among them: it waits.
    for(const change of [{reminders:['2030-01-03T09:00']},{repeat:{every:1,unit:'week',from:'due'}}])
      assert.equal((await s.tasks.chatUpdate(chat,made.id,{expected_revision:started.revision,...change})).state,'proposed');
    const before=cards.length;
    const rename=await s.actionCommands.offer('task',await s.tasks.chatUpdate(chat,made.id,{expected_revision:started.revision,title:'Book the hall',priority:0}));
    assert.equal(rename.state,'proposed');
    assert.equal(last('card').text,`📋 Change a task in the list of “Launch”\n${seenIn}\n\nTask: Book the venue\nTitle: Book the hall\nPriority: No priority`);
    // A change in the meantime makes the card stale: approving it changes nothing.
    await s.tasks.update(owner,made.id,{operation_id:key+':edit',expected_revision:started.revision,notes:'Changed on the dashboard'});
    await s.actionCommands.callback(await press(last('card').buttons[0][1]));
    assert.match(last('answer').text,/^🚫 Not changed/);
    assert.equal((await s.tasks.get(owner,made.id)).title,'Book the venue');
    assert.equal(cards.length,before+3,'one card, one answer and one settled card');

    // A comment on a project's task waits too; a chat added to the list after the card makes it stale.
    const comment=await s.actionCommands.offer('task',await s.tasks.chatComment(chat,made.id,{text:'Ask for the corner room'}));
    assert.equal(last('card').text,`📋 Comment on a task in the list of “Launch”\n${seenIn}\n\nTask: Book the venue\nComment: Ask for the corner room`);
    assert.equal(comment.state,'proposed');
    await stores.control.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1)",[other,launch]);
    await s.actionCommands.callback(await press(last('card').buttons[0][1]));
    assert.match(last('answer').text,/^🚫 Not changed/,'the card no longer names every chat that would see it');
    assert.deepEqual((await s.tasks.get(owner,made.id)).comments,[]);
    await stores.control.query('DELETE FROM project_assignments WHERE space_id=$1',[other]);
    // A comment card on a task changed since, such as renamed, changes nothing either.
    const current=await s.tasks.get(owner,made.id);
    await s.actionCommands.offer('task',await s.tasks.chatComment(chat,made.id,{text:'Ask for the window room'}));
    assert.match(last('card').text,/Task: Book the venue\nComment: Ask for the window room$/);
    await s.tasks.update(owner,made.id,{operation_id:key+':rename',expected_revision:current.revision,title:'Cancel the venue'});
    await s.actionCommands.callback(await press(last('card').buttons[0][1]));
    assert.match(last('answer').text,/^🚫 Not changed/,'the task is no longer as its card showed it');
    assert.deepEqual((await s.tasks.get(owner,made.id)).comments,[]);

    // Moving a personal task in names what stays private; Reject leaves it where it was.
    const own=await s.tasks.chatCreate(chat,{title:'Check the lights'});
    assert.equal(own.project_id,null,'a personal task is written at once');
    const move=await s.actionCommands.offer('task',await s.tasks.chatUpdate(chat,own.id,{expected_revision:own.revision,scope:launch}));
    assert.equal(move.state,'proposed');
    assert.equal(last('card').text,`📋 Move a task into the list of “Launch”\n${seenIn}\n🔒 Its earlier comments and history, the archived messages attached to it, `+
      'its IDs in outside tools such as Notion and the columns you have not shared stay private.\n\nTitle: Check the lights\nStatus: To do');
    await s.actionCommands.callback(await press(last('card').buttons[1][1]));
    assert.equal(last('answer').text,'❌ Rejected. Nothing changed.');
    assert.equal((await s.tasks.get(owner,own.id)).project_id,null);
    assert.equal(last('settle').text.split('\n').at(-1),'❌ Rejected. Nothing changed.');

    // A task moves in with every task under it, archived and in the trash too: the card shows each of them, and a
    // task added or changed under it after the card makes it stale.
    const boxes=await s.tasks.chatCreate(chat,{title:'Pack the crates'});
    const label=await s.tasks.chatCreate(chat,{title:'Label the crates',parent:boxes.id,notes:'canary-under'});
    const old=await s.tasks.chatCreate(chat,{title:'Old labels',parent:label.id});
    await s.tasks.update(owner,old.id,{operation_id:key+':old-trash',expected_revision:old.revision,trashed:true});
    const family=await s.actionCommands.offer('task',await s.tasks.chatUpdate(chat,boxes.id,{expected_revision:boxes.revision,scope:launch}));
    assert.equal(family.state,'proposed');
    const shown=last('card').text;
    assert.ok(shown.startsWith(`📋 Move a task, with 2 under it, into the list of “Launch”\n${seenIn}\n🔒 Their earlier comments and history, `),shown);
    assert.match(shown,/Title: Pack the crates\nStatus: To do\n\nSubtasks › 1\nTitle: Label the crates\nNotes: canary-under\nStatus: To do\nUnder: Pack the crates\n\nSubtasks › 2\nTitle: Old labels\nStatus: To do\nUnder: Label the crates\nIn the trash: true$/);
    const later=await s.tasks.chatCreate(chat,{title:'Tape the crates',parent:boxes.id});
    assert.equal(later.project_id,null,'a personal task is written at once');
    await s.actionCommands.callback(await press(last('card').buttons[0][1]));
    assert.match(last('answer').text,/^🚫 Not changed/,'the card no longer shows every task that would move');
    assert.deepEqual((await tasks('Label the crates')).map(item=>item.project_id),[null]);
    // Asked again, the card shows all three, and approving moves them all.
    const chat2=await actor((await ask('Move the crates to the launch list')).id);
    await s.actionCommands.offer('task',await s.tasks.chatUpdate(chat2,boxes.id,{expected_revision:boxes.revision,scope:launch}));
    assert.match(last('card').text,/^📋 Move a task, with 3 under it, into the list of “Launch”/);
    await s.actionCommands.callback(await press(last('card').buttons[0][1]));
    assert.equal(last('answer').text,'✅ Approved and changed.');
    for(const title of ['Pack the crates','Label the crates','Old labels','Tape the crates'])assert.deepEqual((await tasks(title)).map(item=>item.project_id),[launch],title);

    // A list no chat sees yet still asks first, and says so.
    await s.actionCommands.offer('task',await s.tasks.chatCreate(chat,{title:'Fix the gate',scope:house}));
    assert.equal(last('card').text,'📋 Add a task to the list of “House”\n👥 Seen in no chat yet. Chats you add to this project later will see it too.\n\nTitle: Fix the gate\nStatus: To do');
    // A change too long to show exactly on a card is never made from chat.
    const count=cards.length,long={title:'Long notes',scope:launch,notes:'x'.repeat(5000)};
    const refused=await s.actionCommands.offer('task',await s.tasks.chatCreate(chat,long));
    assert.deepEqual([refused.state,refused.error,cards.length],['refused','task_card_too_long',count]);
    assert.deepEqual([(await s.tasks.chatCreate(chat,long)).state,await tasks('Long notes')],['refused',[]]);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

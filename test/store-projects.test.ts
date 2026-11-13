import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest} from '../src/archive.js';
import {initializeStoreDatabases,connectStores} from '../src/stores/connections.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {GuardRepository} from '../src/stores/guards.js';
import {ProjectRepository,SharingPolicyRepository} from '../src/stores/projects.js';
const owner={admin:true,scope:null};
test('owner project inheritance, explicit sharing and revocation are separate, versioned and idempotent',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!},admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),projects=new ProjectRepository(stores.control),sharing=new SharingPolicyRepository(stores.control);
  const guards=new GuardRepository(stores,new ArchiveRepository(stores.archive)),key='projects:'+Date.now(),group=String(-Date.now()),second=String(Number(group)-1),topic=group+'/topic/17';
  try {
    const input={name:'Synthetic project',description:'Two conversations',state:'active',expected_revision:0,operation_id:key+':new'};
    await assert.rejects(projects.save({admin:false,scope:group},input),{code:'owner_required'});
    const before=await guards.state(),project=await projects.save(owner,input);
    await assert.rejects(guards.assertCurrent(before),{code:'guard_context_changed'});
    assert.deepEqual(await projects.save(owner,input),project);
    await assert.rejects(projects.save(owner,{...input,name:'Conflicting retry'}),{code:'owner_command_conflict'});
    const assigned=await projects.assign(owner,{space_id:group,mode:'assigned',project_id:project.id,expected_revision:0,operation_id:key+':assign'});
    await projects.assign(owner,{space_id:second,mode:'assigned',project_id:project.id,expected_revision:0,operation_id:key+':assign-two'});
    const inherited=await projects.effective(topic);assert.equal(inherited.project?.id,project.id);assert.equal(inherited.inherited,true);
    assert.deepEqual(await sharing.forDestination(second),[],'same project never creates a sharing policy');
    // A topic always follows its group's project; its only choice is to follow it (ADR-0246).
    await assert.rejects(projects.assign(owner,{space_id:topic,mode:'none',expected_revision:0,operation_id:key+':exclude'}),{code:'project_topic_follows_group'});
    assert.equal((await projects.effective(topic)).project?.id,project.id);
    await projects.assign(owner,{space_id:topic,mode:'inherit',expected_revision:0,operation_id:key+':inherit'});
    assert.equal((await projects.effective(topic)).project?.id,project.id);
    await assert.rejects(projects.assign(owner,{space_id:group,mode:'none',expected_revision:0,operation_id:key+':stale'}),{code:'assignment_revision_conflict'});
    const rule=await sharing.save(owner,{name:'Approved synthetic source',sources:[group],destination:second,enabled:true,mode:'approved',expected_revision:0,operation_id:key+':share'});
    assert.equal((await sharing.forDestination(second))[0]?.id,rule.id);
    assert.deepEqual(await sharing.forDestination(second+'/topic/18'),[],'chat sharing never implicitly grants every topic');
    const binding=await guards.state();
    const {revision:shareRevision,...shareFields}=rule;
    const disabled=await sharing.save(owner,{...shareFields,enabled:false,expected_revision:shareRevision,operation_id:key+':revoke'});
    assert.equal(disabled.revision,2);assert.deepEqual(await sharing.forDestination(second),[]);
    await assert.rejects(guards.assertCurrent(binding),{code:'guard_context_changed'});
    await assert.rejects(sharing.save({admin:false,scope:group},{...shareFields,expected_revision:shareRevision,operation_id:key+':conversation-rule'}),{code:'owner_required'});
    await assert.rejects(projects.save(owner,{...input,admin:true,operation_id:key+':unknown'}),{code:'unknown_policy_field'});
    const {revision:projectRevision,...projectFields}=project;
    const archived=await projects.save(owner,{...projectFields,state:'archived',expected_revision:projectRevision,operation_id:key+':archive'});
    assert.equal((await projects.effective(group)).project?.state,'archived');assert.equal(archived.revision,2);
    await assert.rejects(projects.assign(owner,{space_id:group,mode:'assigned',project_id:project.id,expected_revision:assigned.revision,operation_id:key+':archived'}),{code:'active_project_required'});
    assert.ok((await projects.list(owner)).projects.some(p=>p.id===project.id));
    assert.ok((await projects.assignments(owner)).assignments.some(p=>p.space_id===topic));
    assert.ok((await sharing.list(owner)).rules.some(r=>r.id===rule.id&&!r.enabled));
  } finally {await stores.close();}
});

test('an owner rule never reads from or shares into a private chat, and an older or imported one is skipped',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!},admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),projects=new ProjectRepository(stores.control),sharing=new SharingPolicyRepository(stores.control);
  const key='private-rules:'+Date.now(),group=String(-Date.now()),second=String(Number(group)-1),third=String(Number(group)-2),privateChat=String(Date.now());
  try {
    const rule={name:'Synthetic rule',enabled:true,mode:'approved',instructions:'',expected_revision:0};
    for(const space of [privateChat,privateChat+'/topic/5','desktop:personal_chat:9']) {
      await assert.rejects(sharing.save(owner,{...rule,sources:[group,space],destination:second,operation_id:key+':from:'+space}),{code:'sharing_private_chat'},space);
      await assert.rejects(sharing.save(owner,{...rule,sources:[group],destination:space,operation_id:key+':into:'+space}),{code:'sharing_private_chat'},space);
    }
    assert.equal((await sharing.save(owner,{...rule,sources:[group,group+'/topic/3'],destination:second,operation_id:key+':groups'})).destination,second,'groups and topics share');

    // Rows written before private chats were refused, or imported, are read as reading and sharing into no private chat.
    const older=digest(key+':older'),into=digest(key+':into');
    await stores.control.query(`INSERT INTO sharing_rules(id,name,sources,destination,enabled,mode,instructions,revision)
      VALUES($1,'Older rule',$2,$3,true,'approved','',1),($4,'Older rule into a private chat',$5,$6,true,'approved','',1)`,
      [older,JSON.stringify([group,privateChat]),third,into,JSON.stringify([group]),privateChat]);
    const [stored]=await sharing.forDestination(third);assert.equal(stored!.id,older);
    assert.equal(await sharing.covers(stored!,privateChat),false,'a private source is never read');
    assert.equal(await sharing.covers({...stored!,sources:[privateChat+'/topic/5']},privateChat+'/topic/5'),false);
    assert.equal(await sharing.covers(stored!,group),true);
    assert.equal(await sharing.covers(stored!,group+'/topic/5'),false,'an owner rule reads only its exact chats, never a topic of one');
    assert.deepEqual(await sharing.forDestination(privateChat),[],'nothing is shared into a private chat');
    const listed=new Map<string,any>();let after='';
    for(;;){const page=await sharing.list(owner,after);for(const row of page.rules)listed.set(row.id,row);if(!page.next)break;after=page.next;}
    assert.deepEqual(listed.get(older).private_sources,[privateChat],'the rules list names the private chat Nocheh skips');
    assert.deepEqual(listed.get(into).private_sources,[privateChat]);
    // Such a rule can be turned off as it is, but never turned on or given another private chat while it names one.
    const saved=(id:string)=>({...rule,id,name:listed.get(id).name,sources:listed.get(id).sources,destination:listed.get(id).destination,expected_revision:1});
    assert.equal((await sharing.save(owner,{...saved(older),enabled:false,operation_id:key+':older-off'})).enabled,false,'an older rule can be turned off');
    assert.equal((await sharing.save(owner,{...saved(into),enabled:false,operation_id:key+':into-off'})).enabled,false,'one into a private chat too');
    await assert.rejects(sharing.save(owner,{...saved(older),expected_revision:2,operation_id:key+':older-on'}),{code:'sharing_private_chat'},'it is never turned on again');
    await assert.rejects(sharing.save(owner,{...saved(older),enabled:false,sources:[group,privateChat,privateChat+'1'],expected_revision:2,operation_id:key+':older-more'}),{code:'sharing_private_chat'});
    await assert.rejects(sharing.save(owner,{...saved(into),enabled:false,destination:privateChat+'1',expected_revision:2,operation_id:key+':into-other'}),{code:'sharing_private_chat'});
    await assert.rejects(sharing.save(owner,{...rule,enabled:false,sources:[group],destination:privateChat,operation_id:key+':new-off'}),{code:'sharing_private_chat'},'a new rule, even off, never names one');
    assert.deepEqual((await sharing.save(owner,{...saved(older),sources:[group],expected_revision:2,operation_id:key+':older-fixed'})).sources,[group],'with the private chat removed it turns on');

    const project=await projects.save(owner,{name:'Synthetic project',description:'',state:'active',expected_revision:0,operation_id:key+':project'});
    for(const space of [privateChat,privateChat+'/topic/5','desktop:personal_chat:9'])
      await assert.rejects(projects.assign(owner,{space_id:space,mode:'assigned',project_id:project.id,expected_revision:0,operation_id:key+':assign:'+space}),{code:'project_private_chat'},space);
    assert.equal((await projects.assign(owner,{space_id:privateChat,mode:'none',expected_revision:0,operation_id:key+':none'})).mode,'none','a private chat may be kept out');
    await stores.control.query("UPDATE project_assignments SET project_id=$2,mode='assigned' WHERE space_id=$1",[privateChat,project.id]);
    const effective=await projects.effective(privateChat);
    assert.deepEqual([effective.project,effective.assignment],[null,null],'an older row puts a private chat in no project');
    assert.deepEqual([effective.own_assignment?.mode,effective.own_assignment?.project_id],['assigned',project.id],'the row is shown, so the owner can clear it');
    await projects.assign(owner,{space_id:privateChat,mode:'none',expected_revision:effective.own_assignment!.revision,operation_id:key+':clear'});
    assert.equal((await projects.effective(privateChat)).own_assignment?.mode,'none');
  } finally {await stores.close();}
});

test('a project never shares between its groups, lists only its served groups, and a topic always follows its group',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!},admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const key='project-groups:'+Date.now(),group=String(-Date.now()),second=String(Number(group)-1),third=String(Number(group)-2),unserved=String(Number(group)-3);
  const topic=group+'/topic/17',privateChat=String(Date.now());let n=0;
  const op=(label:string)=>key+':'+label+':'+(++n);
  const stores=connectStores(config,passwords),projects=new ProjectRepository(stores.control,()=>[group,second,third,privateChat,topic]),sharing=new SharingPolicyRepository(stores.control);
  const assign=async(space:string,mode:'assigned'|'none'|'inherit',project:string|null=null)=>projects.assign(owner,{space_id:space,mode,
    ...(mode==='assigned'?{project_id:project}:{}),expected_revision:(await projects.effective(space)).own_assignment?.revision??0,operation_id:op('assign')});
  const listed=async(id:string)=>{let after='';for(;;){const page=await projects.list(owner,after);const row=page.projects.find(p=>p.id===id);if(row)return row;if(!page.next)return null;after=page.next;}};
  const rules=async()=>(await stores.control.query('SELECT count(*)::int AS n FROM sharing_rules')).rows[0].n;
  try {
    // The share box is gone: its fields are refused, never stored or ignored (ADR-0246).
    const fields={name:'P1',description:'',state:'active',expected_revision:0};
    for(const extra of [{sharing_enabled:true},{sharing_enabled:false},{sharing_mode:'filtered'}])
      await assert.rejects(projects.save(owner,{...fields,...extra,operation_id:op('box')}),{code:'unknown_policy_field'},JSON.stringify(extra));
    const before=await rules(),project=await projects.save(owner,{...fields,operation_id:op('new')});
    assert.deepEqual(Object.keys(project).sort(),['description','id','name','revision','state']);
    const other=await projects.save(owner,{...fields,name:'P2',operation_id:op('other')});
    for(const space of [group,second,unserved])await assign(space,'assigned',project.id);
    await assert.rejects(projects.assign(owner,{space_id:third,mode:'assigned',project_id:project.id,share_into:true,expected_revision:0,operation_id:op('share')}),
      {code:'unknown_policy_field'});
    // Nothing is shared between the project's groups: no rule is written, and no group gets one from the others.
    assert.equal(await rules(),before,'project saves and assignments write no sharing rule');
    for(const space of [group,second])assert.deepEqual(await sharing.forDestination(space,space),[],space);
    assert.equal((await stores.control.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=current_schema() AND "+
      "(table_name,column_name) IN (('projects','sharing_enabled'),('projects','sharing_mode'),('project_assignments','share_into'),('sharing_rules','project_id'))")).rows[0].n,0);

    // A topic always follows its group's project: a choice of its own is refused, following it is allowed.
    for(const mode of ['none','assigned'] as const)
      await assert.rejects(projects.assign(owner,{space_id:topic,mode,...(mode==='assigned'?{project_id:other.id}:{}),expected_revision:0,operation_id:op('topic')}),
        {code:'project_topic_follows_group'},mode);
    await assign(topic,'inherit');
    let followed=await projects.effective(topic);assert.equal(followed.project?.id,project.id);assert.equal(followed.inherited,true);
    // A topic's own row saved before that rule is shown, so the owner sees it, and never used.
    await stores.control.query("UPDATE project_assignments SET mode='assigned',project_id=$2 WHERE space_id=$1",[topic,other.id]);
    followed=await projects.effective(topic);
    assert.deepEqual([followed.project?.id,followed.own_assignment?.project_id,followed.inherited],[project.id,other.id,true]);
    await stores.control.query("UPDATE project_assignments SET mode='inherit',project_id=NULL WHERE space_id=$1",[topic]);

    // A project lists its groups: the served groups assigned to it, never a topic, a private chat or a group not served.
    await stores.control.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1)",[privateChat,project.id]);
    assert.deepEqual((await listed(project.id))?.groups,[group,second].sort());
    assert.deepEqual((await listed(other.id))?.groups,[]);
    await assign(second,'assigned',other.id);
    assert.deepEqual([(await listed(project.id))?.groups,(await listed(other.id))?.groups],[[group],[second]],'a group belongs to one project at a time');
    await assign(second,'none');
    assert.deepEqual((await listed(other.id))?.groups,[],'"none" is an answer, and leaves the project');
    assert.equal((await projects.effective(second)).own_assignment?.mode,'none');
    assert.deepEqual((await new ProjectRepository(stores.control).list(owner)).projects.find(p=>p.id===project.id)?.groups,[],'nothing served, no group listed');

    // The owner's own rule still works, for its exact chats only, whatever project they are in.
    const rule=await sharing.save(owner,{name:'Owner rule',sources:[group],destination:third,enabled:true,mode:'approved',instructions:'',expected_revision:0,operation_id:op('rule')});
    assert.deepEqual(Object.keys(rule).includes('project_id'),false);
    assert.equal(await sharing.covers(rule,group),true);assert.equal(await sharing.covers(rule,topic),false,'a topic that follows its group into a project is not added');
    assert.deepEqual((await sharing.forDestination(third)).map(row=>row.id),[rule.id]);
  } finally {await stores.close();}
});

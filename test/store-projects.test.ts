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
    await projects.assign(owner,{space_id:topic,mode:'none',expected_revision:0,operation_id:key+':exclude'});
    assert.equal((await projects.effective(topic)).project,null);
    await projects.assign(owner,{space_id:topic,mode:'inherit',expected_revision:1,operation_id:key+':inherit'});
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

test('a project shares between its group chats only when the owner turns it on, and never into a chat left out',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!},admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),projects=new ProjectRepository(stores.control),sharing=new SharingPolicyRepository(stores.control);
  const key='project-sharing:'+Date.now(),group=String(-Date.now()),second=String(Number(group)-1),topic=group+'/topic/17',privateChat='123';let n=0;
  const op=(label:string)=>key+':'+label+':'+(++n);
  const fields:Record<string,unknown>={name:'Synthetic shared project',description:'',state:'active'};
  try {
    let project=await projects.save(owner,{...fields,expected_revision:0,operation_id:op('new')});
    assert.equal(project.sharing_enabled,false);assert.equal(project.sharing_mode,'filtered');
    const save=async(changes:Record<string,unknown>)=>{Object.assign(fields,changes);
      project=await projects.save(owner,{id:project.id,...fields,expected_revision:project.revision,operation_id:op('save')});};
    const assign=async(space:string,mode:'assigned'|'none'|'inherit',extra:Record<string,unknown>={})=>projects.assign(owner,{space_id:space,mode,
      ...(mode==='assigned'?{project_id:project.id}:{}),expected_revision:(await projects.effective(space)).own_assignment?.revision??0,operation_id:op('assign'),...extra});
    const rows=async()=>(await stores.control.query('SELECT * FROM sharing_rules WHERE project_id=$1 ORDER BY destination',[project.id])).rows;
    const into=(space:string)=>digest('project-sharing:'+project.id+':'+space);
    const rule=async(space:string)=>(await rows()).find(row=>row.destination===space);
    for(const space of [group,second,privateChat])await assign(space,'assigned');
    assert.deepEqual(await rows(),[],'a project that does not share writes no rule');
    assert.deepEqual(await sharing.forDestination(second),[]);

    await save({sharing_enabled:true});
    let [intoSecond]=await sharing.forDestination(second),[intoGroup]=await sharing.forDestination(group);
    assert.equal(intoSecond!.id,into(second));assert.equal(intoSecond!.project_id,project.id);assert.equal(intoSecond!.mode,'filtered');
    assert.deepEqual(intoSecond!.sources,[group]);assert.deepEqual(intoGroup!.sources,[second],'a private chat is never a source');
    assert.equal(await rule(privateChat),undefined,'nor a destination');

    assert.equal(await sharing.covers(intoSecond!,topic),true,'a topic that follows its group into the project is a source');
    await assign(topic,'none');assert.equal(await sharing.covers(intoSecond!,topic),false);
    assert.equal((await rule(second)).revision,2,'a topic that stops following its group narrows the rules that read the group');
    assert.equal((await rule(group)).revision,1);
    await assign(topic,'inherit');assert.equal(await sharing.covers(intoSecond!,topic),true);
    assert.equal((await rule(second)).revision,2,'coming back widens it again and revives no earlier text');
    assert.equal(await sharing.covers({...intoSecond!,project_id:null},topic),false,'an owner rule reads only its exact chats');

    const ownerRule={name:'Taken over',sources:[group],destination:second,enabled:false,mode:'approved',instructions:''};
    await assert.rejects(sharing.save(owner,{...ownerRule,id:intoSecond!.id,expected_revision:intoSecond!.revision,operation_id:op('take')}),{code:'sharing_rule_project_managed'});
    await assert.rejects(sharing.save(owner,{...ownerRule,id:into(second+'/topic/3'),destination:second+'/topic/3',expected_revision:0,operation_id:op('squat')}),
      {code:'sharing_rule_project_managed'},'an owner rule never takes an ID a project would use');

    await assign(topic,'assigned');
    assert.equal(await rule(topic),undefined,'a topic whose group is in the project reads the group\'s rule');
    [intoSecond]=await sharing.forDestination(second);assert.deepEqual(intoSecond!.sources,[group,topic]);
    assert.equal(intoSecond!.revision,2,'a wider rule keeps texts approved earlier');
    await assert.rejects(projects.assign(owner,{space_id:second,mode:'none',share_into:false,expected_revision:1,operation_id:op('invalid')}),{code:'invalid_project_assignment'});
    await assign(topic,'assigned',{share_into:false});
    assert.deepEqual(await sharing.forDestination(topic,group),[],'leaving out a topic leaves out its group while topics share memory');
    [intoSecond]=await sharing.forDestination(second);assert.deepEqual(intoSecond!.sources,[group,topic],'a chat left out still shares out');
    await assign(topic,'assigned',{share_into:true});
    [intoGroup]=await sharing.forDestination(group);assert.equal(intoGroup!.revision,2,'turned off and on again, earlier texts stay invalid');
    await assign(second,'assigned',{share_into:false});
    assert.deepEqual(await sharing.forDestination(second),[]);assert.deepEqual((await sharing.forDestination(group))[0]!.sources,[second]);
    await assign(second,'assigned',{share_into:true});

    const before=(await rows()).map(row=>row.revision);
    project=await projects.save(owner,{id:project.id,name:'Renamed shared project',description:'',state:'active',expected_revision:project.revision,operation_id:op('rename')});
    fields.name=project.name;assert.equal(project.sharing_enabled,true,'a save that leaves out sharing keeps it');assert.equal(project.sharing_mode,'filtered');
    assert.ok((await rows()).every(row=>row.name==='Renamed shared project'));assert.deepEqual((await rows()).map(row=>row.revision),before,'a rename keeps texts valid');
    await save({state:'archived'});
    assert.ok((await rows()).every(row=>!row.enabled));assert.deepEqual((await rows()).map(row=>row.revision),before.map(r=>r+1),'an archived project shares nothing');
    await save({state:'active'});
    assert.ok((await rows()).every(row=>row.enabled));assert.deepEqual((await rows()).map(row=>row.revision),before.map(r=>r+1));
    await save({sharing_mode:'approved'});
    assert.ok((await rows()).every(row=>row.mode==='approved'));assert.deepEqual((await rows()).map(row=>row.revision),before.map(r=>r+2));

    // Ten automatic filters at most reach a group, its General chat and its topics together.
    const fillers=Array.from({length:10},(_,i)=>digest(key+':filler:'+i));
    for(const [i,id] of fillers.entries())await stores.control.query(`INSERT INTO sharing_rules(id,name,sources,destination,enabled,mode,instructions,revision)
      VALUES($1,'Synthetic filler','["-1"]',$2,true,'filtered','',1)`,[id,i%2?group:group+'/topic/'+(30+i)]);
    const saved=project,stored=await rows();
    await assert.rejects(save({sharing_mode:'filtered'}),{code:'sharing_rule_limit'});project=saved;
    assert.equal((await stores.control.query('SELECT revision FROM projects WHERE id=$1',[project.id])).rows[0].revision,saved.revision);assert.deepEqual(await rows(),stored);
    await assert.rejects(sharing.save(owner,{...ownerRule,name:'One too many',destination:group+'/topic/99',enabled:true,mode:'filtered',expected_revision:0,operation_id:op('eleventh')}),
      {code:'sharing_rule_limit'});
    await stores.control.query('UPDATE sharing_rules SET enabled=false WHERE id=ANY($1::text[])',[fillers]);
    await save({sharing_mode:'filtered'});assert.ok((await rows()).every(row=>row.enabled&&row.mode==='filtered'));

    // A rule reads at most 100 chats.
    const crowd=Array.from({length:100},(_,i)=>String(Number(group)-1000-i));
    await stores.control.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) SELECT unnest($1::text[]),$2,'assigned',1",[crowd,project.id]);
    const full=project;await assert.rejects(save({description:'Too many chats'}),{code:'sharing_rule_limit'});project=full;fields.description='';
    await stores.control.query('DELETE FROM project_assignments WHERE space_id=ANY($1::text[])',[crowd]);

    // An owner rule that already holds the ID a project would use for a chat keeps it; that chat can't join while it does.
    const third=String(Number(group)-2),squat=await sharing.save(owner,{...ownerRule,id:into(third),expected_revision:0,operation_id:op('squat-first')});
    await assert.rejects(assign(third,'assigned'),{code:'sharing_rule_project_managed'});
    const kept=(await stores.control.query('SELECT * FROM sharing_rules WHERE id=$1',[into(third)])).rows[0];
    assert.deepEqual({project_id:kept.project_id,sources:kept.sources,destination:kept.destination,revision:kept.revision},
      {project_id:null,sources:[group],destination:second,revision:squat.revision},'the project never takes over an owner rule');
    assert.equal((await projects.effective(third)).own_assignment,null,'and the refused assignment is not written');

    // Read through the Sharing page's own list, every page of it.
    const listed=async()=>{const found:string[]=[];let after='';
      for(;;){const page=await sharing.list(owner,after);found.push(...page.rules.filter(row=>row.project_id===project.id).map(row=>row.destination));if(!page.next)return found.sort();after=page.next;}};
    assert.deepEqual(await listed(),[group,second]);
    await assign(second,'inherit');
    assert.equal((await rows()).length,2,'rules are kept for their previews and releases');assert.ok((await rows()).every(row=>!row.enabled));
    assert.deepEqual(await listed(),[group],'the rule of a chat that left the project is not listed');
    assert.deepEqual(await sharing.forDestination(second),[]);
  } finally {await stores.close();}
});

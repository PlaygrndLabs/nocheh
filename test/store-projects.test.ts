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

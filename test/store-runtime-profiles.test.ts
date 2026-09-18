import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest} from '../src/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';

test('native profile configuration retains stable preference identities while revoking old execution generations',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-profiles-')),key='profile-'+Date.now(),owner={admin:true,scope:null};
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:['-456']}),
    runtime:async()=>{throw Error('no runtime calls');},honcho:async()=>{throw Error('no provider calls');}});
  try {
    await s.guards.reconcile();await s.guards.setMode('on');const before=await s.guards.state();
    const count=(await stores.archive.query('SELECT count(*) FROM events')).rows[0].count;
    const defaults=await s.runtimeProfiles.list(owner);assert.equal(defaults.profiles.filter(p=>p.managed).length,2);
    const primary=await s.runtimeProfiles.resolve(owner,{profile:'default'});assert.equal(primary.owner,true);assert.equal(primary.is_default,true);
    assert.equal(primary.native_profile,s.turns.profile({admin:false,scope:null,space:'123',revision:before.epoch},before));
    await assert.rejects(s.runtimeProfiles.list({admin:false,scope:null}),{status:403});
    const request={name:key,state:'active',expected_revision:0,operation_id:key+':create'};
    const custom=await s.runtimeProfiles.save(owner,request);assert.deepEqual(await s.runtimeProfiles.save(owner,request),custom);
    await assert.rejects(s.guards.assertCurrent(before),{code:'guard_context_changed'});
    const first=await s.runtimeProfiles.resolve(owner,{profile:key});assert.equal(first.logical_profile,custom.id);assert.equal(first.preference_profile,custom.id);
    assert.equal((await s.runtimeProfiles.resolve(owner,{profile:first.native_profile})).name,key);
    await assert.rejects(s.runtimeProfiles.save(owner,{...request,scope:'-456'}),{code:'invalid_profile_request'});
    const renamed=await s.runtimeProfiles.save(owner,{id:custom.id,name:key+'-renamed',state:'active',expected_revision:1,operation_id:key+':rename'});
    const second=await s.runtimeProfiles.resolve(owner,{profile:renamed.name});assert.equal(second.logical_profile,first.logical_profile);
    assert.equal(second.preference_profile,first.preference_profile);assert.notEqual(second.native_profile,first.native_profile);
    await assert.rejects(s.runtimeProfiles.resolve(owner,{profile:first.native_profile}),{code:'profile_not_found'});
    await assert.rejects(s.runtimeProfiles.save(owner,{id:custom.id,name:key,state:'active',expected_revision:1,operation_id:key+':stale'}),{code:'profile_revision_conflict'});
    await assert.rejects(s.runtimeProfiles.resolve(owner,{profile:custom.id,space:'-456'}),{code:'profile_scope_denied'});
    const space='-456/topic/7',topic=await s.runtimeProfiles.resolve(owner,{profile:'nocheh-'+digest(space).slice(0,24),space});
    assert.equal(topic.owner,false);assert.equal(topic.space,space);assert.notEqual(topic.native_profile,(await s.runtimeProfiles.resolve(owner,{profile:'nocheh-'+digest('-456').slice(0,24)})).native_profile);
    await assert.rejects(s.runtimeProfiles.resolve(owner,{profile:'nocheh-'+digest('-999/topic/7').slice(0,24),space:'-999/topic/7'}),{code:'profile_scope_denied'});
    await s.runtimeProfiles.save(owner,{id:custom.id,name:renamed.name,state:'retired',expected_revision:2,operation_id:key+':retire'});
    await assert.rejects(s.runtimeProfiles.resolve(owner,{profile:custom.id}),{code:'profile_not_found'});
    await assert.rejects(s.runtimeProfiles.save(owner,{id:custom.id,name:key,state:'active',expected_revision:3,operation_id:key+':revive'}),{code:'profile_retired'});
    const replacement=await s.runtimeProfiles.save(owner,{name:renamed.name,state:'active',expected_revision:0,operation_id:key+':replacement'});
    assert.notEqual(replacement.id,custom.id);assert.notEqual((await s.runtimeProfiles.resolve(owner,{profile:renamed.name})).preference_profile,first.preference_profile);
    await s.runtimeProfiles.save(owner,{id:replacement.id,name:renamed.name,state:'retired',expected_revision:1,operation_id:key+':cleanup'});
    assert.equal((await stores.archive.query('SELECT count(*) FROM events')).rows[0].count,count,'configuration changes create no archive sources');
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

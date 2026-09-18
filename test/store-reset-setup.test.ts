import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {digest} from '../src/archive.js';
import {connectStores,initializeStoreDatabases,storeNames,type StorePasswords} from '../src/stores/connections.js';
import {storeSchemas} from '../src/stores/schema.js';
import {resetSetupSnapshot,restoreResetSetup} from '../src/stores/reset-setup.js';

test('reset setup restores only current configuration under a new generation and replays exactly',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);const schema='reset_setup_'+randomUUID().replaceAll('-','');
  for(const name of storeNames) {
    const db=new pg.Client({...config,database:'nocheh_'+name});await db.connect();
    try {
      await db.query(`CREATE SCHEMA ${schema} AUTHORIZATION nocheh_${name}_owner; SET search_path=${schema},pg_catalog; SET ROLE nocheh_${name}_owner`);
      await db.query(storeSchemas[name]);
      if(name==='control')await db.query('INSERT INTO installation(singleton,generation) VALUES(true,$1)',['33333333-3333-4333-8333-333333333333']);
      await db.query(`GRANT USAGE ON SCHEMA ${schema} TO nocheh_${name}; GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA ${schema} TO nocheh_${name}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO nocheh_${name}`);
      if(name==='archive')await db.query('GRANT UPDATE(file_hash,byte_size) ON artifacts TO nocheh_archive');
      else if(name==='derived')await db.query('GRANT UPDATE(active_revision,state) ON guard_sources TO nocheh_derived; GRANT UPDATE(active_revision,imported) ON derivative_selections,learned_entries TO nocheh_derived');
      else await db.query(`GRANT UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO nocheh_control`);
    } finally {await db.end();}
  }
  const stores=connectStores({...config,options:'-c search_path='+schema+',pg_catalog'},passwords),profile='profile-'+'c'.repeat(48);
  const snapshot={format:'nocheh-reset-configuration-v1',layout:'original-only-v1',configuration:{
    security_policy:[{document:{version:1,rules:[{id:'fixture-deny-shell',kind:'shell',outcome:'deny'}]}}],
    installation_generation:[{generation:'11111111-1111-4111-8111-111111111111'}],guard_mode:[{mode:'off'}],
    runtime_configuration:[{name:'assistant',document:{enabled:true,owner_id:'123',group_ids:['-1001','-1002']}}],
    projects:[{id:'a'.repeat(64),name:'Saved project',description:'Configuration only',state:'archived'}],
    project_assignments:[{space_id:'-1001',project_id:'a'.repeat(64),mode:'assigned'}],
    sharing_rules:[{id:'b'.repeat(64),name:'Saved share',sources:['-1001'],destination:'-1002',enabled:true,mode:'approved',instructions:'Share only approved text'}],
    runtime_profiles:[{id:profile,name:'research',owner_id:'123'}]}} as const;
  const input={snapshot,generation:'22222222-2222-4222-8222-222222222222',reset_id:'44444444-4444-4444-8444-444444444444',
    profile_commands:[{id:profile,name:'research',state:'active',expected_revision:0,operation_id:'restore-preferences:'+profile}]};
  try {
    assert.deepEqual(resetSetupSnapshot(snapshot),snapshot);
    await assert.rejects(restoreResetSetup(stores,{...input,unexpected:true} as any),/snapshot_invalid/);
    await assert.rejects(restoreResetSetup(stores,{...input,generation:snapshot.configuration.installation_generation[0].generation}),/generation_reused/);
    await assert.rejects(restoreResetSetup(stores,{...input,profile_commands:[{...input.profile_commands[0],operation_id:'forged'}]}),/profiles_invalid/);
    const first=await restoreResetSetup(stores,input),again=await restoreResetSetup(stores,input);
    assert.deepEqual(again,first);assert.equal(first.generation,input.generation);assert.equal(first.binding.generation,input.generation);
    assert.equal(first.binding.mode,'off');assert.equal(first.binding.epoch,2);assert.equal(first.configuration_records,8);
    assert.equal((await stores.archive.query('SELECT count(*)::int AS count FROM events')).rows[0].count,0);
    assert.equal((await stores.derived.query('SELECT count(*)::int AS count FROM derived_artifacts')).rows[0].count,0);
    assert.equal((await stores.control.query('SELECT count(*)::int AS count FROM owner_commands')).rows[0].count,1);
    assert.equal((await stores.control.query("SELECT count(*)::int AS count FROM workflow_registry WHERE family IN ('honcho','memory_review')")).rows[0].count,2);
    assert.equal((await stores.control.query('SELECT count(*)::int AS count FROM security_policy_versions')).rows[0].count,2);
    assert.equal((await stores.control.query('SELECT count(*)::int AS count FROM runtime_configuration_versions')).rows[0].count,1);
    await stores.control.query("INSERT INTO projects(id,name,state,revision) VALUES($1,'foreign','active',1)",['d'.repeat(64)]);
    await assert.rejects(restoreResetSetup(stores,input),/target_changed/);
  } finally {
    await stores.close();
    for(const name of storeNames){const db=new pg.Client({...config,database:'nocheh_'+name});await db.connect();try{await db.query(`DROP SCHEMA ${schema} CASCADE`);}finally{await db.end();}}
  }
});

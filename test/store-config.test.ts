import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {storageConfiguration,storageLayout} from '../src/stores/config.js';
import {runtimeStores} from '../src/stores/runtime-pools.js';
import {connectDatabase} from '../src/database.js';
import {digest} from '../src/archive.js';
import {settings} from '../src/config.js';

const env=()=>({NOCHEH_STORAGE_LAYOUT:'original-only-v1',NOCHEH_ARCHIVE_PASSWORD:digest('archive'),NOCHEH_DERIVED_PASSWORD:digest('derived'),NOCHEH_CONTROL_PASSWORD:digest('control')});
test('storage layout and role secrets fail closed without inheriting database authority',async()=>{
  assert.equal(storageLayout({}),'legacy');assert.throws(()=>storageLayout({NOCHEH_STORAGE_LAYOUT:'unknown'}),/invalid_storage_layout/);
  assert.throws(()=>storageConfiguration({}),/original_storage_layout_required/);
  const value=storageConfiguration({...env(),PGHOST:'fixture',PGPORT:'6543',PGUSER:'nocheh',PGDATABASE:'nocheh'});
  assert.deepEqual(value.connection,{host:'fixture',port:6543});assert.equal(new Set(Object.values(value.passwords)).size,3);
  for(const port of ['0','65536','not-port','1.5'])assert.throws(()=>storageConfiguration({...env(),PGPORT:port}),/invalid_store_port/);
  assert.throws(()=>storageConfiguration({...env(),NOCHEH_CONTROL_PASSWORD:env().NOCHEH_ARCHIVE_PASSWORD}),/must_differ/);
  assert.throws(()=>runtimeStores({...env(),PGPASSWORD:'administrator'}),/bootstrap_credential_not_allowed/);
  assert.throws(()=>runtimeStores({...env(),PGPASSWORD_FILE:'/not/read'}),/bootstrap_credential_not_allowed/);
  assert.throws(()=>runtimeStores({...env(),INNGEST_POSTGRES_PASSWORD:'workflow-administrator'}),/bootstrap_credential_not_allowed/);
  const stores=runtimeStores({...env(),PGPASSWORD:''});
  try {
    for(const name of ['archive','derived','control'] as const) {
      assert.equal(stores[name].options.user,'nocheh_'+name);assert.equal(stores[name].options.database,'nocheh_'+name);
    }
  }finally{await stores.close();}
  const root=await mkdtemp(join(tmpdir(),'nocheh-store-config-'));
  try {
    const path=join(root,'archive.secret');await writeFile(path,env().NOCHEH_ARCHIVE_PASSWORD,{mode:0o600});
    const configuration={...env(),NOCHEH_ARCHIVE_PASSWORD_FILE:path};delete (configuration as Partial<typeof configuration>).NOCHEH_ARCHIVE_PASSWORD;
    assert.equal(storageConfiguration(configuration).passwords.archive,env().NOCHEH_ARCHIVE_PASSWORD);
    assert.throws(()=>storageConfiguration({...configuration,NOCHEH_ARCHIVE_PASSWORD:''}),/invalid_archive_credential/,'explicit empty values cannot fall back to secret files');
  }finally{await rm(root,{recursive:true,force:true});}
});
test('new-layout settings do not require administrator credentials and cannot use legacy initialization',()=>{
  const saved={...process.env};
  try {
    delete process.env.PGPASSWORD;delete process.env.PGPASSWORD_FILE;
    Object.assign(process.env,env(),{SERVICE_TOKEN:digest('fixture-service'),GUARD_MODE:'on'});
    const config=settings();assert.equal(config.databasePassword,'');assert.equal(config.storageLayout,'original-only-v1');
    assert.throws(()=>connectDatabase(config),/separated_storage_repositories_required/);
  }finally{for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,saved);}
});

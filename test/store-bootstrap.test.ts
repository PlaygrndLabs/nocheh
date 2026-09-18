import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest} from '../src/archive.js';
import {bootstrapStores} from '../src/stores/bootstrap.js';
import {runtimeStores} from '../src/stores/runtime-pools.js';

test('installation bootstrap provisions separate domains and workflow storage without activating an inactive restore',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const admin=new pg.Pool({host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD});
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const saved={...process.env},root=await mkdtemp(join(tmpdir(),'nocheh-bootstrap-'));
  // The shared synthetic Inngest service uses the configured fixture key too.
  // Do not rotate its role while other serial acceptance checks reuse it.
  const workflowPassword=process.env.INNGEST_POSTGRES_PASSWORD??digest('workflow-fixture');
  try {
    Object.assign(process.env,{NOCHEH_DATA_DIR:root,NOCHEH_STORAGE_LAYOUT:'original-only-v1',
      NOCHEH_ARCHIVE_PASSWORD:digest('archive-fixture'),NOCHEH_DERIVED_PASSWORD:digest('derived-fixture'),NOCHEH_CONTROL_PASSWORD:digest('control-fixture'),INNGEST_POSTGRES_PASSWORD:workflowPassword});
    await bootstrapStores();
    const env={...process.env};delete env.PGPASSWORD;delete env.PGPASSWORD_FILE;delete env.INNGEST_POSTGRES_PASSWORD;delete env.INNGEST_POSTGRES_PASSWORD_FILE;
    const stores=runtimeStores(env);
    try {
      const before=(await stores.control.query('SELECT generation FROM installation')).rows[0].generation;
      const revisions=(await stores.derived.query("SELECT count(*) FROM guard_revisions WHERE author='owner'")).rows[0].count;
      const maintenance=new pg.Client({host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD});await maintenance.connect();
      try {await maintenance.query('SELECT pg_advisory_lock(803361)');await assert.rejects(bootstrapStores(),/store_maintenance_busy/);}
      finally{await maintenance.end();}
      await bootstrapStores();assert.equal((await stores.control.query('SELECT generation FROM installation')).rows[0].generation,before);
      assert.equal((await stores.derived.query("SELECT count(*) FROM guard_revisions WHERE author='owner'")).rows[0].count,revisions);
      for(const name of ['archive','derived','control'] as const) {
        const role=(await stores[name].query('SELECT current_user AS name')).rows[0].name;
        assert.equal(role,'nocheh_'+name);
        await assert.rejects(stores[name].query('CREATE DATABASE portable_bootstrap_forbidden'),{code:'42501'});
      }
      const workflow=new pg.Pool({host:process.env.PGHOST,user:'nocheh_inngest',database:'nocheh_inngest',password:workflowPassword});
      try {assert.equal((await workflow.query('SELECT current_user AS name')).rows[0].name,'nocheh_inngest');}
      finally{await workflow.end();}
      await mkdir(join(root,'spool'));await writeFile(join(root,'spool/.restore-inactive'),'inactive');
      await assert.rejects(bootstrapStores(),/inactive_installation_requires_explicit_activation/);
      assert.equal((await stores.control.query('SELECT generation FROM installation')).rows[0].generation,before);
    }finally{await stores.close();}
  }finally {
    for(const name of Object.keys(process.env))delete process.env[name];Object.assign(process.env,saved);
    await rm(root,{recursive:true,force:true});
  }
});

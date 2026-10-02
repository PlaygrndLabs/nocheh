import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest} from '../src/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {listWorkflows,workflowDetail} from '../src/workflows/owner.js';

test('event workflow inspection resolves receipt and reconciliation links under a populated backlog',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:60000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);const stores=connectStores(config,passwords);
  const db=await stores.control.connect();
  try {
    await db.query('BEGIN');
    await db.query("INSERT INTO memory_generations(id,installation_generation,guard_epoch,audience) VALUES(repeat('f',64),gen_random_uuid(),1,'synthetic-workflow-list')");
    await db.query(`INSERT INTO memory_ingestion_receipts(id,generation,source_reference,guard_source_id,prepared_id,content_hash,state)
      SELECT lpad(to_hex(n),64,'0'),repeat('f',64),jsonb_build_object('id',CASE WHEN n=1 THEN repeat('a',64) ELSE repeat('b',64) END),
      'fixture-source',repeat('c',64),repeat('d',64),'done' FROM generate_series(1,2500) n`);
    await db.query(`INSERT INTO workflow_registry(id,family,job_id,version,generation)
      SELECT lpad(to_hex(10000+n),64,'0'),'honcho','receipt:'||lpad(to_hex(n),64,'0'),1,1 FROM generate_series(1,2500) n`);
    await db.query(`INSERT INTO workflow_registry(id,family,job_id,version,generation)
      SELECT lpad(to_hex(20000+n),64,'0'),'honcho','generation:'||lpad(to_hex(n),64,'0'),1,1 FROM generate_series(1,8000) n`);
    await db.query("INSERT INTO workflow_registry(id,family,job_id,version,generation) VALUES(repeat('e',64),'honcho','reconcile:'||lpad('1',64,'0'),1,1)");
    await db.query('ANALYZE workflow_registry');await db.query('ANALYZE memory_ingestion_receipts');
    // A source-scoped owner read must not scan every receipt for every workflow.
    // Keep a generous database deadline; the indexed candidate is far below it.
    await db.query("SET LOCAL statement_timeout='5s'");
    const page=await listWorkflows(db as unknown as pg.Pool,{event:'a'.repeat(64)});
    assert.equal(page.workflows.length,2);assert.equal(page.next,null);
    assert.deepEqual(new Set(page.workflows.map(x=>x.job_id)),new Set(['receipt:'+('1'.padStart(64,'0')),'reconcile:'+('1'.padStart(64,'0'))]));
    for(const row of page.workflows){assert.equal(row.source_event_id,'a'.repeat(64));assert.equal(row.state,'completed');}
    const detail=await workflowDetail(db as unknown as pg.Pool,'e'.repeat(64));assert.equal(detail.source_event_id,'a'.repeat(64));
    const missing=await listWorkflows(db as unknown as pg.Pool,{event:'9'.repeat(64)});assert.deepEqual(missing.workflows,[]);
  } finally {await db.query('ROLLBACK');db.release();await stores.close();}
});

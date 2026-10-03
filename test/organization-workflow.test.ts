import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {storageWorkflowOperations} from '../src/stores/workflow-operations.js';
import type {StorageServices} from '../src/stores/services.js';
import {workflowSchema,requestWorkflow} from '../src/workflows/store.js';
import {safeMetadata} from '../src/workflows/boundary.js';

test('organization workflows retain domain outcomes behind owner fencing and bounded history',async()=>{
  const queries:string[]=[],jobs:string[]=[];
  let permitted=true,state='waiting',reason='current_owner_reply_not_finished';
  const db={query:async(sql:string)=>{queries.push(sql);return {rows:sql.includes('pg_try_advisory_lock_shared')?[{locked:true}]:
    sql.includes('SELECT owner,epoch,admission')?[{owner:'inngest',epoch:1,admission:permitted}]:[],rowCount:1};},release:()=>{}};
  const service={stores:{control:{connect:async()=>db}},knowledge:{process:async(job:string)=>{jobs.push(job);return {state,reason};}}} as unknown as StorageServices;
  const operations=storageWorkflowOperations(service,async()=>({})),run=operations.organization!,job='proposal:'+'a'.repeat(64),authority={owner:'inngest' as const,epoch:1};
  let result=await run(job,authority);assert.equal(result.state,'waiting');assert.equal(result.waiting_reason,'receipt_pending');safeMetadata(result);
  const results:Record<string,string>={review:'completed',applied:'completed',noop:'completed',cancelled:'cancelled',failed:'failed',stale:'skipped',undone:'skipped'};
  for(const [domain,workflow] of Object.entries(results)){
    state=domain;reason='source_content_never_serialized';result=await run(job,authority);assert.equal(result.state,workflow);safeMetadata(result);
    assert.equal(JSON.stringify(result).includes(reason),false);
  }
  state='unknown';await assert.rejects(run(job,authority),{code:'invalid_organization_outcome'});
  permitted=false;const count=jobs.length;assert.equal((await run(job,authority)).waiting_reason,'owner_paused');assert.equal(jobs.length,count);
  assert.equal((await run('proposal:../unsafe',authority)).state,'failed');assert.equal(jobs.length,count);
  assert.ok(queries.some(sql=>sql.includes('pg_advisory_unlock_shared')),'all authorized attempts release the family fence');
});

test('organization family migrates an existing CHECK before owner registration without altering old ownership',
 {skip:!process.env.PGHOST},async()=>{
  const connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD};
  const admin=new pg.Pool(connection),schema='organization_migration_'+Date.now();await admin.query('CREATE SCHEMA '+schema);
  const pool=new pg.Pool({...connection,options:'-c search_path='+schema});
  try {
    await pool.query("CREATE TABLE workflow_owners(family text PRIMARY KEY CHECK(family IN ('telegram','honcho')),owner text NOT NULL DEFAULT 'legacy',epoch integer NOT NULL DEFAULT 1,admission boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT now())");
    await pool.query("INSERT INTO workflow_owners(family,epoch) VALUES('telegram',7)");
    await pool.query(workflowSchema);await pool.query(workflowSchema);
    assert.deepEqual((await pool.query("SELECT owner,epoch,admission FROM workflow_owners WHERE family='telegram'")).rows[0],{owner:'legacy',epoch:7,admission:false});
    assert.equal((await pool.query("SELECT owner FROM workflow_owners WHERE family='organization'")).rows[0].owner,'inngest');
    const db=await pool.connect();try{
      await db.query('BEGIN');const id=await requestWorkflow(db,'organization','proposal:'+'a'.repeat(64));await db.query('COMMIT');
      assert.equal((await pool.query('SELECT count(*) FROM workflow_outbox WHERE workflow_id=$1',[id])).rows[0].count,'1');
    }finally{db.release();}
  }finally{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {bootstrapWorkflowDatabase,initializeWorkflowDatabase} from '../src/workflows/bootstrap.js';

test('failed provisioning releases its lock, destroys the session and hides SQL details',async()=>{
  const queries:string[]=[];let destroyed=false;
  const client={query:async(sql:string)=>{
    queries.push(sql);
    if(sql.startsWith('CREATE ROLE'))throw Error('private database detail');
    return {rowCount:0};
  },escapeLiteral:(value:string)=>`'${value}'`,release:(destroy:boolean)=>{destroyed=destroy;}};
  await assert.rejects(initializeWorkflowDatabase({connect:async()=>client} as unknown as pg.Pool,'a'.repeat(64)),{message:'workflow_database_setup_failed'});
  assert.equal(queries.at(-1),'SELECT pg_advisory_unlock(803320)');
  assert.equal(destroyed,true);
});

test('invalid provisioning credentials cannot mutate a database',async()=>{
  let queried=false;
  await assert.rejects(bootstrapWorkflowDatabase({query:async()=>{queried=true;}} as unknown as pg.Client,''),/invalid_workflow_database_password/);
  assert.equal(queried,false);
});

test('repeated and concurrent startup preserves workflow data and archive isolation',{
  skip:process.env.NOCHEH_WORKFLOW_FIXTURE!=='1',
},async()=>{
  const pool=new pg.Pool();
  const password=process.env.INNGEST_POSTGRES_PASSWORD!;
  const workflow=new pg.Client({database:'nocheh_inngest',user:'nocheh_inngest',password});
  const forbidden=new pg.Client({database:'nocheh',user:'nocheh_inngest',password});
  try {
    await workflow.connect();
    await workflow.query('CREATE TABLE bootstrap_preservation_fixture (id integer PRIMARY KEY)');
    await workflow.query('INSERT INTO bootstrap_preservation_fixture VALUES (1)');
    await Promise.all([initializeWorkflowDatabase(pool,password),initializeWorkflowDatabase(pool,password)]);
    assert.deepEqual((await workflow.query('SELECT id FROM bootstrap_preservation_fixture')).rows,[{id:1}]);
    const role=(await pool.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname='nocheh_inngest'")).rows[0];
    assert.deepEqual(role,{rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false});
    await assert.rejects(forbidden.connect(),{code:'42501'});
  } finally {
    await workflow.query('DROP TABLE IF EXISTS bootstrap_preservation_fixture').catch(()=>{});
    await Promise.all([workflow.end(),forbidden.end().catch(()=>{}),pool.end()]);
  }
});

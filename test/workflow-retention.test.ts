import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {expireWorkflowHistory,retentionDays} from '../src/workflows/retention.js';

test('workflow history retention is off by default and rejects invalid day counts',()=>{
  assert.equal(retentionDays('0'),0);assert.equal(retentionDays('14'),14);assert.equal(retentionDays('3650'),3650);
  for(const value of ['','-1','3651','1.5','14d',' 14'])assert.throws(()=>retentionDays(value),/invalid_workflow_history_retention/);
});

test('retention removes only telemetry of runs idle past the cutoff',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:60000},async()=>{
  const config:pg.ClientConfig={host:process.env.PGHOST!,port:Number(process.env.PGPORT??5432),user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const client=new pg.Client(config);await client.connect();const schema='retention_'+Date.now();
  try {
    assert.equal((await client.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');
    await client.query(`CREATE SCHEMA ${schema}`);await client.query(`SET search_path=${schema}`);
    // Column subset of the pinned Inngest PostgreSQL schema used by retention.
    await client.query(`CREATE TABLE spans(span_id text,trace_id text,run_id text NOT NULL,start_time timestamptz NOT NULL,end_time timestamptz NOT NULL);
      CREATE TABLE history(run_id bytea NOT NULL,created_at timestamp NOT NULL);
      CREATE TABLE traces(run_id char(26),"timestamp" timestamp NOT NULL)`);
    const day=86400000,now=Date.now(),at=(age:number)=>new Date(now-age*day),utc=(age:number)=>at(age).toISOString().slice(0,-1);
    // idle: finished 30 days ago. active: started 30 days ago, still writing today. recent: today.
    for(const [run,ages] of [['idle',[31,30]],['active',[30,0.01]],['recent',[0.02,0.01]]] as const)
      for(const age of ages) {
        await client.query('INSERT INTO spans VALUES($1,$1,$2,$3,$3)',[run+age,run,at(age)]);
        await client.query("INSERT INTO history VALUES(convert_to($1,'UTF8'),$2::timestamp)",[run,utc(age)]);
        await client.query('INSERT INTO traces VALUES(NULL,$1::timestamp)',[utc(age)]);
      }
    const pruned=await expireWorkflowHistory(client,at(14),0);
    assert.deepEqual(pruned,{spans:2,history:2,traces:3});
    assert.deepEqual((await client.query('SELECT DISTINCT run_id FROM spans ORDER BY 1')).rows.map(row=>row.run_id),['active','recent']);
    assert.equal((await client.query("SELECT count(*)::int AS count FROM history WHERE run_id=convert_to('active','UTF8')")).rows[0].count,2,'an active run keeps its older history');
    assert.deepEqual(await expireWorkflowHistory(client,at(14),0),{spans:0,history:0,traces:0},'a repeated pass is a no-op');
  } finally {await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(()=>{});await client.end();}
});

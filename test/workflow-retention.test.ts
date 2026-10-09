import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {expireWorkflowHistory,retentionDays} from '../src/workflows/retention.js';

test('workflow history retention keeps 14 days by default and rejects invalid day counts',()=>{
  const saved=process.env.NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS;delete process.env.NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS;
  try{assert.equal(retentionDays(),14);}finally{if(saved!==undefined)process.env.NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS=saved;}
  assert.equal(retentionDays('0'),0);assert.equal(retentionDays('14'),14);assert.equal(retentionDays('3650'),3650);
  for(const value of ['','-1','3651','1.5','14d',' 14'])assert.throws(()=>retentionDays(value),/invalid_workflow_history_retention/);
});

test('retention removes only history of runs idle past the cutoff',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:60000},async()=>{
  const config:pg.ClientConfig={host:process.env.PGHOST!,port:Number(process.env.PGPORT??5432),user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const client=new pg.Client(config);await client.connect();const schema='retention_'+Date.now();
  try {
    assert.equal((await client.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');
    await client.query(`CREATE SCHEMA ${schema}`);await client.query(`SET search_path=${schema}`);
    // Column subset of the pinned Inngest PostgreSQL schema used by retention.
    await client.query(`CREATE TABLE spans(span_id text,trace_id text,run_id text NOT NULL,start_time timestamptz NOT NULL,end_time timestamptz NOT NULL);
      CREATE TABLE history(run_id bytea NOT NULL,created_at timestamp NOT NULL);
      CREATE TABLE traces(run_id char(26),"timestamp" timestamp NOT NULL);
      CREATE TABLE function_runs(run_id bytea NOT NULL,run_started_at timestamp NOT NULL,event_id bytea NOT NULL);
      CREATE TABLE function_finishes(run_id bytea,created_at timestamp NOT NULL);
      CREATE TABLE events(internal_id bytea,received_at timestamp NOT NULL);
      CREATE TABLE event_batches(id char(26) NOT NULL,run_id char(26) NOT NULL,executed_at timestamp NOT NULL);
      CREATE TABLE trace_runs(run_id char(26) NOT NULL,queued_at bigint NOT NULL,started_at bigint NOT NULL,ended_at bigint NOT NULL);
      CREATE TABLE worker_connections(id bytea NOT NULL,connected_at bigint NOT NULL,disconnected_at bigint,recorded_at bigint NOT NULL,inserted_at bigint NOT NULL)`);
    const day=86400000,now=Date.now(),at=(age:number)=>new Date(now-age*day),utc=(age:number)=>at(age).toISOString().slice(0,-1),ms=(age:number)=>Math.round(now-age*day);
    const bytes="convert_to($1,'UTF8')";
    // idle: finished 30 days ago. active: started 30 days ago, still writing today. recent: today.
    for(const [run,ages] of [['idle',[31,30]],['active',[30,0.01]],['recent',[0.02,0.01]]] as const) {
      for(const age of ages) {
        await client.query('INSERT INTO spans VALUES($1,$1,$2,$3,$3)',[run+age,run,at(age)]);
        await client.query(`INSERT INTO history VALUES(${bytes},$2::timestamp)`,[run,utc(age)]);
        await client.query('INSERT INTO traces VALUES(NULL,$1::timestamp)',[utc(age)]);
      }
      await client.query(`INSERT INTO events VALUES(${bytes},$2::timestamp)`,[run,utc(ages[0])]);
      await client.query(`INSERT INTO function_runs VALUES(${bytes},$2::timestamp,${bytes})`,[run,utc(ages[0])]);
      // A running trace records the zero time as its end; it stays while its spans are recent.
      await client.query('INSERT INTO trace_runs VALUES($1,$2,$2,$3)',[run,ms(ages[0]),run==='active'?-62135596800000:ms(ages[1])]);
    }
    await client.query(`INSERT INTO function_finishes VALUES(${bytes},$2::timestamp),(convert_to('recent','UTF8'),$3::timestamp)`,['idle',utc(30),utc(0.01)]);
    await client.query(`INSERT INTO events VALUES(convert_to('unused-old','UTF8'),$1::timestamp),(convert_to('unused-new','UTF8'),$2::timestamp)`,[utc(20),utc(1)]);
    await client.query(`INSERT INTO event_batches VALUES('old','idle',$1::timestamp),('new','recent',$2::timestamp)`,[utc(30),utc(0.01)]);
    await client.query(`INSERT INTO worker_connections VALUES('closed',$1,$1,$1,$1),('open',$1,NULL,$1,$1),('closing',$1,$2,$2,$2)`,[ms(30),ms(1)]);
    const pruned=await expireWorkflowHistory(client,at(14),0);
    assert.deepEqual(pruned,{spans:2,history:2,traces:3,function_runs:1,function_finishes:1,events:2,event_batches:1,trace_runs:1,worker_connections:1});
    const left=async(table:string,column='run_id')=>(await client.query(`SELECT ${column}::text AS id FROM ${table} ORDER BY 1`)).rows.map(row=>row.id.trim());
    assert.deepEqual((await client.query('SELECT DISTINCT run_id FROM spans ORDER BY 1')).rows.map(row=>row.run_id),['active','recent']);
    assert.equal((await client.query("SELECT count(*)::int AS count FROM history WHERE run_id=convert_to('active','UTF8')")).rows[0].count,2,'an active run keeps its older history');
    assert.deepEqual((await client.query("SELECT convert_from(run_id,'UTF8') AS id FROM function_runs ORDER BY 1")).rows.map(row=>row.id),['active','recent'],'an active run keeps its start record');
    assert.deepEqual((await client.query("SELECT convert_from(internal_id,'UTF8') AS id FROM events ORDER BY 1")).rows.map(row=>row.id),['active','recent','unused-new'],'an event stays while its run is recorded');
    assert.deepEqual(await left('trace_runs'),['active','recent'],'a running trace stays');
    assert.deepEqual(await left('event_batches','id'),['new']);
    assert.deepEqual((await client.query("SELECT convert_from(id,'UTF8') AS id FROM worker_connections ORDER BY 1")).rows.map(row=>row.id),['closing','open'],'a connected worker stays');
    assert.ok(Object.values(await expireWorkflowHistory(client,at(14),0)).every(count=>count===0),'a repeated pass is a no-op');
  } finally {await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(()=>{});await client.end();}
});

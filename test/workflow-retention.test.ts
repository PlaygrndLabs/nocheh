import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {expireGuardFragments,expireMemorySummaries,expireTelemetry,expireWorkflowHistory,expireWorkflowRecords,retentionDays} from '../src/workflows/retention.js';
import {hash,workflowSchema} from '../src/workflows/store.js';
import {controlGuardSchema,derivedGuardSchema} from '../src/stores/guard-schema.js';
import {securityCoreSchema} from '../src/security/store.js';

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

test('record retention removes only spent publication records and run links, never the registry or receipts',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:60000},async()=>{
  const config:pg.ClientConfig={host:process.env.PGHOST!,port:Number(process.env.PGPORT??5432),user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const client=new pg.Client(config);await client.connect();const schema='records_'+Date.now();
  try {
    assert.equal((await client.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');
    await client.query(`CREATE SCHEMA ${schema}`);await client.query(`SET search_path=${schema}`);await client.query(workflowSchema);
    const ago=(days:number)=>new Date(Date.now()-days*86400000);
    // name, state, current dispatch, registry update age, and per dispatch: [published age or null, run seen age]
    const workflows=[['closed-old','completed',1,30,[[30,30]]],['closed-recent','failed',1,0.01,[[0.02,0.02]]],
      ['continued','waiting',3,0.01,[[30,30],[null,20],[0.01,0.01]]],['open-old','waiting',1,30,[[30,30]]]] as const;
    for(const [name,state,dispatch,age,dispatches] of workflows) {
      const id=hash(name);
      await client.query(`INSERT INTO workflow_registry(id,family,job_id,version,generation,state,dispatch,updated_at) VALUES($1,'telegram',$2,1,1,$3,$4,$5)`,[id,name,state,dispatch,ago(age)]);
      await client.query(`INSERT INTO workflow_receipts(workflow_id,step,attempt,state,created_at) VALUES($1,'telegram',1,'done',$2)`,[id,ago(30)]);
      for(const [index,[published,seen]] of dispatches.entries()) {
        await client.query('INSERT INTO workflow_outbox(id,workflow_id,dispatch,published_at,created_at) VALUES($1,$2,$3,$4,$5)',
          [hash(id+':'+(index+1)),id,index+1,published===null?null:ago(published),ago(published??seen)]);
        await client.query('INSERT INTO workflow_runs(workflow_id,run_id,dispatch,owner_epoch,seen_at) VALUES($1,$2,$3,1,$4)',[id,name+(index+1),index+1,ago(seen)]);
      }
    }
    assert.deepEqual(await expireWorkflowRecords(client,ago(14),0),{workflow_outbox:3,workflow_runs:3});
    const left=async(table:string)=>(await client.query(`SELECT w.job_id||':'||t.dispatch AS key FROM ${table} t JOIN workflow_registry w ON w.id=t.workflow_id ORDER BY 1`)).rows.map(row=>row.key);
    const kept=['closed-recent:1','continued:3','open-old:1'];
    assert.deepEqual(await left('workflow_outbox'),kept,'the current dispatch of an open workflow and recently closed work stay');
    assert.deepEqual(await left('workflow_runs'),kept);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM workflow_registry')).rows[0].count,4,'the registry is never pruned');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM workflow_receipts')).rows[0].count,4,'effect receipts are never pruned');
    assert.deepEqual(await expireWorkflowRecords(client,ago(14),0),{workflow_outbox:0,workflow_runs:0},'a repeated pass is a no-op');
  } finally {await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(()=>{});await client.end();}
});

test('telemetry retention removes only old model-call events and invalidation notes, never action effects',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:60000},async()=>{
  const config:pg.ClientConfig={host:process.env.PGHOST!,port:Number(process.env.PGPORT??5432),user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const client=new pg.Client(config);await client.connect();const schema='telemetry_'+Date.now();
  try {
    assert.equal((await client.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');
    await client.query(`CREATE SCHEMA ${schema}`);await client.query(`SET search_path=${schema}`);
    await client.query(securityCoreSchema);await client.query(controlGuardSchema);
    const ago=(days:number)=>new Date(Date.now()-days*86400000);
    const effects=[['model-old','model.request','completed',30],['model-recent','model.request','completed',1],
      ['action-old','telegram.send','ambiguous',30],['action-old-done','controlled_action_result','completed',30]] as const;
    for(const [id,kind,state,age] of effects)await client.query(`INSERT INTO security_events(effect_id,state,kind,scope,profile,policy_revision,origin,rule,created_at)
      SELECT $1,$2,$3,'owner','owner',max(revision),'default','default',$4 FROM security_policy_versions`,[id,state,kind,ago(age)]);
    for(const [source,epoch,age] of [['old',1,30],['recent',2,1]] as const)
      await client.query('INSERT INTO guard_invalidations(source_id,epoch,created_at) VALUES($1,$2,$3)',[source,epoch,ago(age)]);
    assert.deepEqual(await expireTelemetry(client,ago(14),0),{model_effects:1,guard_invalidations:1});
    assert.deepEqual((await client.query('SELECT effect_id FROM security_events ORDER BY effect_id')).rows.map(row=>row.effect_id),
      ['action-old','action-old-done','model-recent'],'action effects are the owner audit and stay');
    assert.deepEqual((await client.query('SELECT source_id FROM guard_invalidations')).rows.map(row=>row.source_id),['recent']);
    assert.deepEqual(await expireTelemetry(client,ago(14),0),{model_effects:0,guard_invalidations:0},'a repeated pass is a no-op');
  } finally {await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(()=>{});await client.end();}
});

test('summary retention removes only spent Honcho context summaries and their guarded copies',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:60000},async()=>{
  const config:pg.ClientConfig={host:process.env.PGHOST!,port:Number(process.env.PGPORT??5432),user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const client=new pg.Client(config);await client.connect();const schema='summaries_'+Date.now();
  try {
    assert.equal((await client.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');
    await client.query(`CREATE SCHEMA ${schema}`);await client.query(`SET search_path=${schema}`);
    // Column subsets of the derived schema used by summary retention.
    await client.query(`CREATE TABLE derived_artifacts(id text PRIMARY KEY,kind text NOT NULL,operation_id text UNIQUE NOT NULL,created_at timestamptz NOT NULL);
      ${derivedGuardSchema}
      CREATE TABLE runtime_prepared_inputs(id text PRIMARY KEY,source_id text NOT NULL REFERENCES guard_sources(id))`);
    const ago=(hours:number)=>new Date(Date.now()-hours*3600000);
    // Each context read n writes Honcho's output rn and its bounded summary bn.
    const rebuild=async(n:string,hours:number,bounded=true)=>{
      await client.query(`INSERT INTO derived_artifacts VALUES($1,'memory_result',$2,$3)`,['r'+n,'native-context:w:1:'+n,ago(hours)]);
      if(bounded)await client.query(`INSERT INTO derived_artifacts VALUES($1,'memory_context',$2,$3)`,['b'+n,'native-context:w:1:'+n+':bounded',ago(hours)]);
    };
    for(const [n,hours,bounded] of [['1',48,true],['2',47,true],['3',48,true],['4',0.1,true],['5',48,false],['6',48,true]] as const)await rebuild(n,hours,bounded);
    await client.query(`INSERT INTO derived_artifacts VALUES('recall','memory_result','native-recall-output:x',$1)`,[ago(48)]);
    for(const n of ['1','6']) {
      const source='derived_artifacts:b'+n;
      await client.query(`INSERT INTO guard_sources(id,kind,source_id,reference,input_hash,input,active_revision,state) VALUES($1,'derived_artifacts',$2,'{}','h','\\x00',1,'ready')`,[source,'b'+n]);
      await client.query(`INSERT INTO guard_revisions(id,source_id,revision,content,search_text,input_hash,author,preparation_version,operation_id) VALUES($1,$1,1,'\\x00','','h','automatic','v',$1)`,[source]);
      await client.query('INSERT INTO guard_activations(operation_id,source_id,revision) VALUES($1,$1,1)',[source]);
      await client.query(`INSERT INTO guard_fragments(id,source_id,input_hash,preparation_version,content) VALUES($1,$1,'h','v','\\x00')`,[source]);
    }
    await client.query("INSERT INTO runtime_prepared_inputs VALUES('in','derived_artifacts:b6')");
    assert.deepEqual(await expireMemorySummaries(client,ago(1),0),{memory_contexts:3,memory_results:4});
    assert.deepEqual((await client.query('SELECT id FROM derived_artifacts ORDER BY 1')).rows.map(row=>row.id),['b4','b6','r4','r6','recall'],
      'a recent read, a summary still referenced and other memory results stay');
    assert.deepEqual((await client.query('SELECT id FROM guard_sources ORDER BY 1')).rows.map(row=>row.id),['derived_artifacts:b6']);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM guard_revisions')).rows[0].count,1);
    assert.deepEqual(await expireMemorySummaries(client,ago(1),0),{memory_contexts:0,memory_results:0},'a repeated pass is a no-op');
  } finally {await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(()=>{});await client.end();}
});

test('fragment retention removes guard fragments only once their source has a published revision',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:60000},async()=>{
  const config:pg.ClientConfig={host:process.env.PGHOST!,port:Number(process.env.PGPORT??5432),user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const client=new pg.Client(config);await client.connect();const schema='fragments_'+Date.now();
  try {
    assert.equal((await client.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');
    await client.query(`CREATE SCHEMA ${schema}`);await client.query(`SET search_path=${schema}`);await client.query(derivedGuardSchema);
    const ago=(hours:number)=>new Date(Date.now()-hours*3600000);
    // `done` is published, `pending` is still being prepared, `recent` was published moments ago.
    for(const [source,published] of [['done',true],['pending',false],['recent',true]] as const)
      await client.query(`INSERT INTO guard_sources(id,kind,source_id,reference,input_hash,input,active_revision,state) VALUES($1,'events',$1,'{}','h','\\x00',$2,$3)`,
        [source,published?1:null,published?'ready':'pending']);
    for(const [id,source,hours] of [['d1','done',5],['d2','done',5],['p1','pending',5],['r1','recent',0.1]] as const)
      await client.query(`INSERT INTO guard_fragments(id,source_id,input_hash,preparation_version,content,created_at) VALUES($1,$2,'h','v','\\x00',$3)`,[id,source,ago(hours)]);
    assert.deepEqual(await expireGuardFragments(client,ago(1),0),{guard_fragments:2});
    assert.deepEqual((await client.query('SELECT id FROM guard_fragments ORDER BY 1')).rows.map(row=>row.id),['p1','r1'],
      'an unfinished preparation keeps its checkpoints, and a just-finished one keeps them for an hour');
    assert.deepEqual(await expireGuardFragments(client,ago(1),0),{guard_fragments:0});
  } finally {await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(()=>{});await client.end();}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {settings} from '../src/config.js';
import {initialize} from '../src/database.js';
import {captureInput,claimRun,finishRun,recoverScheduled,scheduleDefinition,cancelScheduled} from '../src/managed-runs.js';
import {scheduleOperation,scheduledContext,scheduledAuthority} from '../src/workflows/schedules.js';
import {managedRunOperation} from '../src/workflows/browser.js';
import {pauseFamily,switchFamily} from '../src/workflows/store.js';
import {hermesAdapter} from '../src/hermes-adapter.js';

test('scheduled workflows preserve native cursors, capacity, occurrence identity and async receipts',{skip:!process.env.PGHOST},async()=>{
  const config=settings(),connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:config.databasePassword};
  config.assistant={enabled:false,owner_id:'42',group_ids:[]};
  const root=new pg.Pool(connection),schema='schedule_workflow_'+Date.now();await root.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({...connection,options:`-c search_path=${schema}`,max:8});
  try {
    await initialize(pool);
    const definition={profile:'private',prompt:'Private schedule canary',deliver:'local',execution_version:'v1'};
    const request={scope:'42',profile:'private',job_id:'native-job',definition,workflow_cursor:'a'.repeat(64),workflow_sequence:1};
    await scheduleDefinition(pool,config,request);await scheduleDefinition(pool,config,request);
    const job=(await pool.query("SELECT job_id FROM workflow_registry WHERE family='schedules'")).rows[0].job_id;
    assert.equal((await pool.query("SELECT count(*)::int n FROM workflow_registry WHERE family='schedules'")).rows[0].n,1);
    let nextCalls=0;const future=Date.now()+3600000;
    const controller=scheduleOperation(pool,async(operation,input)=>{nextCalls++;assert.equal(operation,'schedule.advance');assert.equal(input.cursor,request.workflow_cursor);assert.ok(!('definition' in input));return {state:'waiting',next_attempt:future};},async()=>{throw Error('unexpected occurrence');});
    assert.equal((await controller(job,{owner:'inngest',epoch:2})).next_attempt,future);
    await scheduleDefinition(pool,config,{...request,workflow_cursor:'b'.repeat(64),workflow_sequence:2});
    await scheduleDefinition(pool,config,request);
    assert.equal((await pool.query('SELECT cursor FROM workflow_schedules')).rows[0].cursor,'b'.repeat(64));
    await assert.rejects(scheduleDefinition(pool,config,{...request,workflow_sequence:2}),/schedule_sequence_conflict/);
    assert.equal((await controller(job,{owner:'inngest',epoch:2})).state,'skipped');assert.equal(nextCalls,1);
    assert.equal((await pool.query('SELECT state FROM workflow_registry WHERE job_id=$1',[job])).rows[0].state,'skipped');
    await pauseFamily(pool,'schedules',1);await switchFamily(pool,'schedules',1,'inngest');
    const authority={owner:'inngest' as const,epoch:2};
    const source={id:'fire',conversation:'native-job',scope:'42',profile:'private',text:definition.prompt,job_id:'native-job',
      job_revision:'revision-one',scheduled_for:'2026-09-12T00:00:00Z',fire_reason:'scheduled',definition};
    await assert.rejects(captureInput(pool,config,source,'scheduler'),/workflow_owner_changed/);
    const first=await captureInput(pool,config,source,'scheduler',authority);
    const overlap=await captureInput(pool,config,{...source,id:'overlap'},'scheduler',authority);
    assert.equal(overlap.fire_reason,'overlap');
    for(let i=2;i<=4;i++)await captureInput(pool,config,{...source,id:'profile-'+i,profile:'profile'+i,job_id:'job'+i},'scheduler',authority);
    const limit=await captureInput(pool,config,{...source,id:'profile-5',profile:'profile5',job_id:'job5'},'scheduler',authority);
    assert.equal(limit.fire_reason,'overlap');
    const duplicate=await captureInput(pool,config,{...source,fire_reason:'missed'},'scheduler',authority);
    assert.equal(duplicate.event_id,first.event_id);assert.equal(duplicate.fire_reason,'scheduled');
    await recoverScheduled(pool);assert.equal((await pool.query('SELECT state FROM managed_runs WHERE event_id=$1',[first.event_id])).rows[0].state,'captured');
    let effects=0;
    const native=hermesAdapter({url:'http://scheduled-fixture.invalid',token:'fixture',fetch:async(url,options)=>{
      const input=JSON.parse(String(options?.body)),path=new URL(String(url)).pathname;
      assert.equal(input.channel,'scheduler');
      if(path==='/internal/run/resume')return Response.json({state:effects?'running':'not_found'});
      assert.equal(path,'/internal/run/start');effects++;
      const context=await scheduledContext(pool,config,input);
      await claimRun(pool,config,context,'scheduler',await scheduledAuthority(pool,config,context));
      throw Error('lost start response');
    }});
    const run=managedRunOperation(pool,config,native.call,'scheduler');
    assert.equal((await run(overlap.event_id,authority)).state,'skipped');assert.equal(effects,0);
    assert.equal((await run(first.event_id,authority)).state,'running');
    assert.equal((await run(first.event_id,authority)).state,'running');assert.equal(effects,1);
    await finishRun(pool,{event_id:first.event_id,actor:'run_'+first.event_id,state:'done',text:'Private schedule result canary',session:'native-session'});
    assert.equal((await run(first.event_id,authority)).state,'completed');
    assert.equal((await pool.query("SELECT state FROM workflow_receipts WHERE step='schedules'")).rows[0].state,'done');
    await cancelScheduled(pool,{event_id:limit.event_id});assert.equal((await run(limit.event_id,authority)).state,'skipped');
    await assert.rejects(scheduledContext(pool,config,{event_id:first.event_id,owner_epoch:1}),/workflow_owner_changed/);
  }finally{await pool.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
});

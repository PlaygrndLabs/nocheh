import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {settings} from '../src/config.js';
import {initialize} from '../src/database.js';
import {captureInput,claimRun,finishRun,cancelScheduled,renewRun,recoverScheduled,scheduledRuns,scheduledDelivery,scheduleDefinition} from '../src/managed-runs.js';

test('real PostgreSQL: scheduled fire identity, missed runs, cancellation, restart and delivery approval',{skip:!process.env.PGHOST},async()=>{
  const config=settings(),connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:config.databasePassword};
  config.assistant={enabled:false,owner_id:'42',group_ids:['-10']};
  const root=new pg.Pool(connection),schema='scheduler_'+Date.now();await root.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({...connection,options:`-c search_path=${schema}`});
  try {
    await initialize(pool);
    const definition={profile:'private',name:'Fixture',prompt:' Original\r\n\0 ',deliver:'telegram'};
    const source={id:'fire-one',conversation:'job-one',scope:'42',profile:'private',space:'42',revision:0,text:definition.prompt,
      job_id:'job-one',job_revision:'v1',scheduled_for:'2026-09-08T10:00:00Z',fire_reason:'scheduled',definition};
    const saved=await scheduleDefinition(pool,config,{scope:'42',profile:'private',job_id:'job-one',definition});
    assert.equal((await pool.query('SELECT original_text FROM events WHERE id=$1',[saved.id])).rows[0].original_text.toString(),definition.prompt);
    const fire=await captureInput(pool,config,source,'scheduler');
    assert.equal((await captureInput(pool,config,source,'scheduler')).duplicate,true);
    await assert.rejects(captureInput(pool,config,{...source,text:'changed'},'scheduler'),/source_identity_conflict/);
    const claim={event_id:fire.event_id,actor:'scheduler-one',profile:'private',scope:'42'};
    await assert.rejects(claimRun(pool,config,claim),/captured_run_not_found/,'browser endpoint cannot claim a scheduled source');
    assert.equal((await claimRun(pool,config,claim,'scheduler')).claimed,true);
    assert.equal((await claimRun(pool,config,claim,'scheduler')).claimed,false);
    await finishRun(pool,{...claim,session:'cron_job_one',state:'done',text:'Synthetic approved result'});
    const proposal=await scheduledDelivery(pool,{event_id:fire.event_id});
    assert.equal(proposal.state,'proposed');
    assert.deepEqual(await scheduledDelivery(pool,{event_id:fire.event_id}),proposal);
    assert.equal((await pool.query('SELECT state FROM action_requests')).rows[0].state,'proposed','delivery is not sent or approved');
    const result=(await scheduledRuns(pool,{profile:'private',job_id:'job-one'})).runs[0]!;
    assert.equal(result.native_session,'cron_job_one');assert.equal(result.text,'Synthetic approved result');
    assert.equal((await pool.query("SELECT kind FROM derived_artifacts WHERE event_id=$1",[fire.event_id])).rows[0].kind,'scheduled_result');
    const missed=await captureInput(pool,config,{...source,id:'missed',fire_reason:'missed'},'scheduler');
    assert.equal((await claimRun(pool,config,{...claim,event_id:missed.event_id},'scheduler')).state,'cancelled');
    const cancel=await captureInput(pool,config,{...source,id:'cancel'},'scheduler');
    await cancelScheduled(pool,{event_id:cancel.event_id});
    assert.equal((await claimRun(pool,config,{...claim,event_id:cancel.event_id},'scheduler')).claimed,false);
    const active=await captureInput(pool,config,{...source,id:'active'},'scheduler');
    const activeClaim={...claim,event_id:active.event_id};await claimRun(pool,config,activeClaim,'scheduler');
    await cancelScheduled(pool,{event_id:active.event_id});assert.equal((await renewRun(pool,activeClaim)).cancel_requested,true);
    await finishRun(pool,{...activeClaim,session:'cancelled',state:'done',text:'Late result'});
    assert.equal((await scheduledDelivery(pool,{event_id:active.event_id})).state,'withheld');
    const restart=await captureInput(pool,config,{...source,id:'restart'},'scheduler');
    await recoverScheduled(pool);assert.equal((await claimRun(pool,config,{...claim,event_id:restart.event_id},'scheduler')).state,'interrupted');
    assert.equal((await scheduledRuns(pool,{profile:'different'})).runs.length,0);
  }finally{await pool.end();await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}
});

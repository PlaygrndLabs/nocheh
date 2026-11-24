import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {canonical,digest} from '../src/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {fixtureServices} from './fixture-agent.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {reviveSchedules} from '../src/workflows/schedules.js';
import {issueClockGrant,issueScheduleGrant,recordScheduleDefinition} from '../src/stores/schedules.js';
import {localFields} from '../src/schedule-timing.js';
import {storageWorkflowOperations} from '../src/stores/workflow-operations.js';

test('schedule definitions and fires are recoverable control operations with durable guarded derivatives',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-schedules-')),base=Date.now();let fail='',lostCommit=false,detectorDown=false;
  const control=new Proxy(stores.control,{get(target,key){if(key==='connect')return async()=>{
    const db=await target.connect();return new Proxy(db,{get(client,name){if(name==='query')return (sql:any,...args:any[])=>{
      if(lostCommit&&sql==='COMMIT'){lostCommit=false;return (client.query as any)(sql,...args).then(()=>{throw Error('lost commit acknowledgement');});}
      if(fail&&String(sql).startsWith(fail)){fail='';return Promise.reject(Error('lost control write'));}
      return (client.query as any)(sql,...args);};const value=Reflect.get(client,name);return typeof value==='function'?value.bind(client):value;}});
  };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const owner={admin:true,scope:null},profile='nocheh-'+digest('123').slice(0,24),job='fixture-'+base;
  const s=fixtureServices({...stores,control},{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:['-123']}),
    runtime:async(op,body)=>{assert.equal(op,'guard.detect');if(detectorDown)throw Error('detector unavailable');return {literals:String(body.text).includes('fixture-secret')?['fixture-secret']:[]};},
    memoryEngine:honchoEngine(async()=>{throw Error('no providers');})});
  let definition:any={profile,name:'Synthetic job',prompt:'Exact\r\nfixture-secret\0 schedule',schedule:{kind:'interval',minutes:1},deliver:'local',repeat:null,
    enabled:true,removed:false,preferences:{'agent.max_iterations':4},execution_version:'v1'};
  let sequence=0;
  const schedule=digest(canonical([profile,job])),cursor=()=>digest('cursor-'+sequence);
  // Hermes's own post (admin): a checkpoint, or a change with a press's edit grant.
  const publish=(changes:Record<string,unknown>={})=>s.schedules.definition(owner,{scope:'123',profile,job_id:job,definition,
    workflow_cursor:digest('cursor-'+(++sequence)),workflow_sequence:sequence,...changes});
  // A version set by asking, as the turn route records it.
  const asked=(changes:Record<string,unknown>={})=>recordScheduleDefinition(s.schedules,{scope:'123',profile,job_id:job,definition,
    workflow_cursor:digest('cursor-'+(++sequence)),workflow_sequence:sequence,...changes});
  // Timed fires on whole minutes within the last ten; each needs the clock grant of an advance.
  const due=(ago:number)=>new Date((Math.floor(Date.now()/60000)-ago)*60000).toISOString();
  const clock=async()=>issueClockGrant(stores.control,schedule,(await stores.control.query('SELECT cursor FROM workflow_schedules WHERE id=$1',[schedule])).rows[0].cursor,
    (await s.schedules.ownership()).epoch);
  const input=async(id:string,changes:Record<string,unknown>={})=>({scope:'123',space:'123',profile,job_id:job,id,conversation:job,
    text:definition.prompt,files:[],definition,job_revision:digest(canonical(definition)),scheduled_for:due(5),
    fire_reason:'scheduled',owner_epoch:(await s.schedules.ownership()).epoch,...changes});
  const row=async(id:string)=>(await stores.control.query('SELECT * FROM managed_runs WHERE event_id=$1',[id])).rows[0];
  const latest=async()=>(await stores.control.query('SELECT v.* FROM workflow_schedules s JOIN schedule_versions v ON v.id=s.version_id WHERE s.id=$1',[schedule])).rows[0];
  const grant=(operation:'pause'|'resume'|'delete'|'run',request_id:string,person='owner')=>issueScheduleGrant(stores.control,{profile,job_id:job,operation,person,request_id});
  const derivedCount=async()=>Number((await stores.derived.query("SELECT count(*) FROM derived_artifacts WHERE kind='schedule_definition'")).rows[0].count);
  try{
    await s.guards.reconcile();await s.guards.setMode('on');
    await assert.rejects(s.schedules.definition({admin:false,scope:'123'},{}),{status:403});
    // A schedule follows its chat's tool switches; it carries none of its own.
    for(const key of ['nocheh_tools.shell','nocheh_tools.browser','nocheh_tools.mcp'])
      await assert.rejects(s.schedules.definition(owner,{scope:'123',profile,job_id:job,definition:{...definition,preferences:{[key]:'off'}},
        workflow_cursor:digest('tools-'+key),workflow_sequence:1}),{status:400,code:'invalid_schedule_preference'},key);
    // Hermes alone cannot set a new schedule (ADR-0290): nothing is recorded, not even its derived records.
    const derivedBefore=await derivedCount();
    await assert.rejects(s.schedules.definition(owner,{scope:'123',profile,job_id:job,definition,workflow_cursor:digest('made-up'),workflow_sequence:1}),
      {status:403,code:'schedule_definition_not_allowed'});
    await assert.rejects(s.schedules.definition(owner,{scope:'123',profile,job_id:job,definition,workflow_cursor:digest('made-up'),workflow_sequence:1,grant:'../x'}),
      {status:400,code:'invalid_schedule_definition'});
    assert.equal(await derivedCount(),derivedBefore);
    const before=Number((await stores.archive.query('SELECT count(*) FROM events')).rows[0].count);
    const record=s.derived.record.bind(s.derived);let missing=true;
    s.derived.record=async value=>{if(missing&&value.kind==='scheduled_prompt'){missing=false;throw Error('derived outage');}return record(value);};
    await assert.rejects(asked({workflow_sequence:1,workflow_cursor:digest('cursor-1')}),/derived outage/);s.derived.record=record;
    fail='INSERT INTO schedule_versions';await assert.rejects(asked({workflow_sequence:1,workflow_cursor:digest('cursor-1')}),/lost control write/);
    const initial=await asked({workflow_sequence:1,workflow_cursor:digest('cursor-1')});assert.ok('prompt' in initial);sequence=1;
    const prompt=initial.prompt!,reference=initial.definition!;
    assert.equal((await stores.derived.query('SELECT content FROM derived_artifacts WHERE id=$1',[prompt.id])).rows[0].content.toString(),definition.prompt);
    const guarded=await s.guards.read('derived_artifacts:'+prompt.id,await s.guards.state());assert.ok(!JSON.stringify(guarded).includes('fixture-secret'));
    assert.equal(JSON.parse((await stores.derived.query('SELECT content FROM derived_artifacts WHERE id=$1',[reference.id])).rows[0].content.toString()).prompt,definition.prompt);
    const duplicate=await publish({workflow_sequence:1,workflow_cursor:digest('cursor-1')});assert.equal(duplicate.duplicate,true);
    await assert.rejects(publish({workflow_sequence:1}),{code:'schedule_sequence_conflict'});
    await assert.rejects(publish({workflow_sequence:0}),{code:'invalid_schedule_sequence'});
    // A Run now moves the cursor away and back to an earlier one, whose row is closed: a new generation runs it. Each move is
    // Hermes's checkpoint: the same execution version, needing no grant.
    const timed="SELECT state,generation FROM workflow_registry WHERE family='schedules' AND job_id LIKE 'schedule:%:'||$1 ORDER BY generation";
    await publish({workflow_cursor:digest('cursor-2')});await publish({workflow_cursor:digest('cursor-1')});
    assert.deepEqual((await latest()).set_by,{via:'turn',person:'owner',turn:'fixture'},'the same document keeps its version');
    assert.deepEqual((await stores.control.query(timed,[digest('cursor-1')])).rows.map(row=>[row.state,row.generation]),[['skipped',1],['queued',2]]);
    assert.deepEqual((await stores.control.query(timed,[digest('cursor-2')])).rows.map(row=>row.state),['skipped']);
    // A schedule an earlier Run now left with only a superseded row starts again once at startup.
    await stores.control.query("UPDATE workflow_registry SET state='skipped',waiting_reason='superseded' WHERE family='schedules' AND job_id LIKE 'schedule:%'");
    assert.equal(await reviveSchedules(stores.control),1);assert.equal(await reviveSchedules(stores.control),0);
    assert.deepEqual((await stores.control.query(timed,[digest('cursor-1')])).rows.map(row=>[row.state,row.generation]),[['skipped',1],['skipped',2],['queued',3]]);
    // A press bound to one chat gets no grant for a schedule Nocheh holds for another, whatever the agent's list said.
    await assert.rejects(issueScheduleGrant(stores.control,{profile,job_id:job,operation:'pause',person:'f'.repeat(64),request_id:'press-elsewhere',scope:'701'}),
      {status:404,code:'schedule_not_found'});
    assert.equal(await issueScheduleGrant(stores.control,{profile,job_id:job,operation:'pause',person:'owner',request_id:'press-here',scope:'123'}),'press-here');
    assert.equal((await stores.control.query("SELECT count(*)::int AS n FROM schedule_grants WHERE request_id='press-elsewhere'")).rows[0].n,0);
    // A timed fire needs the clock grant of an advance for this cursor and epoch; a missing one is refused.
    await assert.rejects(s.schedules.capture(owner,await input('no-clock')),{status:403,code:'fire_grant_clock'});
    // Refused before anything is written, or once its operation is written (a grant gone meanwhile, as when an advance timed
    // out): Hermes's retry of that slot in a later advance, by then missed, is the same fire, never an identity conflict that
    // would stop the schedule for good.
    await assert.rejects(s.schedules.capture(owner,await input('lost-clock',{scheduled_for:due(9)})),{status:403,code:'fire_grant_clock'});
    await clock();fail='SELECT id FROM schedule_grants';
    await assert.rejects(s.schedules.capture(owner,await input('lost-clock',{scheduled_for:due(9)})),/lost control write/);
    await clock();assert.equal((await s.schedules.capture(owner,await input('lost-clock',{scheduled_for:due(9),fire_reason:'missed'}))).state,'cancelled');
    await stores.control.query("DELETE FROM schedule_grants WHERE kind='clock' AND used_by IS NULL");
    const first=await input('first',{scheduled_for:due(8)});await clock();fail='INSERT INTO managed_runs';await assert.rejects(s.schedules.capture(owner,first),/lost control write/);
    lostCommit=true;await assert.rejects(s.schedules.capture(owner,first),/lost commit acknowledgement/);
    const committed=await s.schedules.capture(owner,first);assert.equal(committed.state,'captured');
    assert.equal((await s.schedules.capture(owner,first)).event_id,committed.event_id);
    assert.deepEqual([(await row(committed.event_id)).fired_by,(await row(committed.event_id)).scheduled_for.toISOString()],['clock',first.scheduled_for]);
    await assert.rejects(s.schedules.capture(owner,{...first,text:'changed'}),{code:'schedule_input_conflict'});
    await assert.rejects(s.schedules.capture(owner,{...first,owner_epoch:999}),{code:'workflow_owner_changed'});
    const run=await row(committed.event_id);assert.equal(run.source_reference.store,'control');assert.equal(run.trigger_reference.store,'derived');
    // The grant went with that fire; the same minute again, one too soon for the schedule's interval, an early one or a
    // stale one is refused with a grant too.
    await assert.rejects(s.schedules.capture(owner,await input('again')),{status:403,code:'fire_grant_clock'});
    await clock();
    await assert.rejects(s.schedules.capture(owner,await input('same',{scheduled_for:first.scheduled_for})),{status:403,code:'fire_grant_time'});
    await assert.rejects(s.schedules.capture(owner,await input('soon',{scheduled_for:new Date(Date.parse(first.scheduled_for)+30000).toISOString()})),
      {status:403,code:'fire_grant_time'},'half a minute after the last');
    await assert.rejects(s.schedules.capture(owner,await input('early',{scheduled_for:new Date(Date.now()+60000).toISOString()})),{status:403,code:'fire_grant_time'});
    await assert.rejects(s.schedules.capture(owner,await input('stale',{scheduled_for:new Date(Date.now()-3600000).toISOString()})),{status:403,code:'fire_grant_time'});
    // Busy: a timed fire Hermes claimed becomes an overlap, still the clock's.
    const overlap=await s.schedules.capture(owner,await input('overlap',{scheduled_for:due(6)}));assert.equal(overlap.fire_reason,'overlap');
    assert.equal((await row(overlap.event_id)).fired_by,'clock');
    const epoch=(await s.guards.state()).epoch;
    // Off by Hermes's own checkpoint (a completed schedule): allowed, and its admitted run stays.
    definition={...definition,enabled:false};await publish();assert.equal((await s.guards.state()).epoch,epoch,'clock completion must not revoke its admitted run');
    assert.deepEqual((await latest()).set_by,{via:'checkpoint'});
    assert.equal((await row(committed.event_id)).state,'captured');assert.equal((await row(overlap.event_id)).state,'cancelled');
    await assert.rejects(s.schedules.capture(owner,await input('disabled')),{code:'schedule_definition_changed'});
    // Never back on without a press: not as a checkpoint, not as a new version.
    await assert.rejects(publish({definition:{...definition,enabled:true}}),{status:403,code:'schedule_definition_not_allowed'});
    await assert.rejects(publish({definition:{...definition,enabled:true,execution_version:'v1-on'}}),{status:403,code:'schedule_definition_not_allowed'});
    const old=definition;definition={...definition,prompt:'Different text'};
    await assert.rejects(publish(),{code:'schedule_execution_version_conflict'});definition=old;
    // A press's resume grant turns it on once, as that press; reused, for another change, or with a different body, it is refused.
    await grant('resume','press-resume');
    await assert.rejects(grant('pause','press-resume'),{status:409,code:'schedule_request_conflict'});
    await assert.rejects(grant('resume','press-resume','f'.repeat(64)),{status:409,code:'schedule_request_conflict'});
    await assert.rejects(publish({definition:{...definition,enabled:true,prompt:'Sneaked in',execution_version:'v1-resumed'},grant:'press-resume'}),
      {status:403,code:'schedule_definition_not_allowed'},'an edit grant never changes what the schedule says');
    await assert.rejects(publish({definition:{...definition,enabled:true,removed:true,execution_version:'v1-resumed'},grant:'press-resume'}),
      {status:403,code:'schedule_definition_not_allowed'},'a resume grant does not delete');
    definition={...definition,enabled:true,execution_version:'v1-resumed'};await publish({grant:'press-resume'});
    assert.deepEqual((await latest()).set_by,{via:'edit',person:'owner',request_id:'press-resume'});
    definition={...definition,enabled:false,execution_version:'v1-paused'};
    await assert.rejects(publish({grant:'press-resume'}),{status:403,code:'schedule_definition_not_allowed'},'used once');
    await grant('pause','press-late');await stores.control.query("UPDATE schedule_grants SET expires_at=now()-interval '1 second' WHERE request_id='press-late'");
    await assert.rejects(publish({grant:'press-late'}),{status:403,code:'schedule_definition_not_allowed'},'expired');
    await grant('pause','press-pause');
    await publish({grant:'press-pause'});assert.deepEqual((await latest()).set_by,{via:'edit',person:'owner',request_id:'press-pause'});
    // A version from before grants has no body hash; its definition record gives it, so a press still works.
    await stores.control.query('UPDATE schedule_versions SET body_hash=NULL,set_by=NULL WHERE schedule_id=$1',[schedule]);
    await grant('resume','press-legacy');definition={...definition,enabled:true,execution_version:'v1-legacy'};await publish({grant:'press-legacy'});
    // What it says changes only by asking: a new execution version revokes the admitted run.
    definition={...definition,prompt:'Owner revised prompt',enabled:true,execution_version:'v2'};
    await assert.rejects(publish(),{status:403,code:'schedule_definition_not_allowed'});
    await asked();
    assert.equal((await row(committed.event_id)).state,'cancelled');assert.ok((await s.guards.state()).epoch>epoch);
    await assert.rejects(s.schedules.capture(owner,{...first,id:'obsolete'}),{code:'schedule_definition_changed'});
    await clock();assert.equal((await s.schedules.capture(owner,await input('missed',{fire_reason:'missed',scheduled_for:due(4)}))).state,'cancelled');
    // Catch-up is off; a Run now needs its press's request id and grant, fires while paused and is the presser's.
    await assert.rejects(s.schedules.capture(owner,await input('catch-up',{fire_reason:'catch_up'})),{status:403,code:'schedule_catch_up_off'});
    await assert.rejects(s.schedules.capture(owner,await input('manual',{fire_reason:'manual'})),{status:400,code:'invalid_scheduled_fire'});
    await assert.rejects(s.schedules.capture(owner,await input('manual',{fire_reason:'manual',request_id:'press-run'})),{status:403,code:'fire_grant_run_now'});
    await grant('pause','press-run-edit');
    await assert.rejects(s.schedules.capture(owner,await input('manual',{fire_reason:'manual',request_id:'press-run-edit'})),{status:403,code:'fire_grant_run_now'},'an edit grant does not run');
    await grant('run','press-run','a'.repeat(64));
    const manual=await s.schedules.capture(owner,await input('manual',{fire_reason:'manual',request_id:'press-run'}));assert.equal(manual.state,'captured');
    assert.equal((await row(manual.event_id)).fired_by,'a'.repeat(64));
    await assert.rejects(s.schedules.capture(owner,await input('manual-again',{fire_reason:'manual',request_id:'press-run'})),{status:403,code:'fire_grant_run_now'});
    await grant('delete','press-delete');
    // A removal is taken also when Hermes holds a body a refused turn changed: what it says no longer matters.
    definition={...definition,prompt:'Changed in a refused turn',removed:true,enabled:false,execution_version:'v3'};await publish({grant:'press-delete'});
    assert.equal((await row(manual.event_id)).state,'cancelled');
    await grant('run','press-run-removed');
    await assert.rejects(s.schedules.capture(owner,await input('removed',{fire_reason:'manual',request_id:'press-run-removed'})),{code:'schedule_definition_changed'});
    await grant('resume','press-revive');
    await assert.rejects(publish({definition:{...definition,removed:false,enabled:true,execution_version:'v3-revived'},grant:'press-revive'}),
      {status:403,code:'schedule_definition_not_allowed'},'a deleted schedule never comes back by a press');
    const version=(await stores.control.query('SELECT * FROM schedule_versions WHERE schedule_id=$1 ORDER BY created_at DESC LIMIT 1',[schedule])).rows[0];
    assert.equal('prompt' in version.configuration,false);assert.equal(version.operation_reference.store,'control');
    assert.equal(Number((await stores.archive.query('SELECT count(*) FROM events')).rows[0].count),before);
    assert.equal((await stores.archive.query("SELECT count(*)::int AS count FROM events WHERE channel='scheduler'")).rows[0].count,0);
    assert.equal((await stores.control.query("SELECT count(*)::int AS count FROM workflow_registry WHERE family='schedules' AND job_id=$1",['run:'+committed.event_id])).rows[0].count,1);
    await s.guards.setMode('off');detectorDown=true;
    definition={...definition,removed:false,enabled:true,execution_version:'v4',prompt:'Unguarded explicit off mode'};await asked();
    await clock();assert.equal((await s.schedules.capture(owner,await input('off',{scheduled_for:due(2)}))).state,'captured');
    await assert.rejects(publish({profile:'nocheh-'+digest('-123').slice(0,24)}),{code:'profile_scope_denied'});
    // Expired grants are kept a day, then dropped on the next grant.
    await stores.control.query("UPDATE schedule_grants SET expires_at=now()-interval '2 days' WHERE request_id='press-late'");
    await grant('pause','press-tidy');
    assert.equal((await stores.control.query("SELECT count(*)::int AS n FROM schedule_grants WHERE request_id='press-late'")).rows[0].n,0);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

test('a schedule registered before grants keeps firing, pausing and running now with no action from the owner',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-legacy-schedule-')),owner={admin:true,scope:null};
  const profile='nocheh-'+digest('123').slice(0,24),job='legacy-'+Date.now(),schedule=digest(canonical([profile,job])),zone='Asia/Tokyo';
  // A morning brief whose minute is the last whole minute, on the wall clock of its own zone.
  const due=new Date(Math.floor(Date.now()/60000)*60000-60000),local=localFields(due.getTime(),zone)!;
  let definition:any={profile,name:'Morning brief',prompt:'Brief me',schedule:{kind:'cron',expr:`${local.minute} ${local.hour} * * *`,display:'daily'},
    deliver:'telegram',repeat:null,enabled:true,removed:false,preferences:{},execution_version:'legacy-v1',timezone:zone};
  let sequence=1;const advances:unknown[]=[];
  const fire=async(id:string,reason:string,epoch:unknown,extra:Record<string,unknown>={})=>s.schedules.capture(owner,{scope:'123',space:'123',profile,job_id:job,id,
    text:definition.prompt,files:[],definition,job_revision:digest(canonical(definition)),scheduled_for:due.toISOString(),fire_reason:reason,owner_epoch:epoch,...extra});
  const checkpoint=(changes:Record<string,unknown>={})=>s.schedules.definition(owner,{scope:'123',profile,job_id:job,definition,
    workflow_cursor:digest('legacy-cursor-'+(++sequence)),workflow_sequence:sequence,...changes});
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[]}),
    runtime:async(op,body)=>{
      if(op==='guard.detect')return {literals:[]};
      // Hermes's scheduler when Nocheh advances: the job is due, so it captures the timed fire, then checkpoints its cursor.
      assert.equal(op,'schedule.advance');advances.push(body);
      const fired=await fire('timed-1','scheduled',body.owner_epoch);await checkpoint();
      return {state:'completed',fired};
    },memoryEngine:honchoEngine(async()=>{throw Error('no providers');})});
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    // As it was before grants: a version with no body hash or setter, a creator nobody recorded, and a run nobody marked.
    await recordScheduleDefinition(s.schedules,{scope:'123',profile,job_id:job,definition,workflow_cursor:digest('legacy-cursor-1'),workflow_sequence:1});
    await stores.control.query('UPDATE schedule_versions SET body_hash=NULL,set_by=NULL WHERE schedule_id=$1',[schedule]);
    await stores.control.query('UPDATE workflow_schedules SET created_by=NULL,created_turn=NULL WHERE id=$1',[schedule]);
    const ownership=await s.schedules.ownership(),authority={owner:'inngest' as const,epoch:ownership.epoch};
    // Inngest wakes it: Nocheh's clock grant lets Hermes capture the timed fire, and its checkpoint moves the cursor on.
    const woke=await storageWorkflowOperations(s,async()=>({})).schedules!('schedule:'+schedule+':'+digest('legacy-cursor-1'),authority);
    assert.equal(woke.state,'completed');assert.equal(advances.length,1);
    const runs=(await stores.control.query("SELECT fire_reason,fired_by,state FROM managed_runs WHERE channel='scheduler' AND job_id=$1",[job])).rows;
    assert.deepEqual(runs,[{fire_reason:'scheduled',fired_by:'clock',state:'captured'}]);
    assert.equal((await stores.control.query('SELECT cursor FROM workflow_schedules WHERE id=$1',[schedule])).rows[0].cursor,digest('legacy-cursor-2'));
    assert.equal((await stores.control.query("SELECT count(*)::int AS n FROM schedule_grants WHERE kind='clock' AND used_by IS NULL")).rows[0].n,0);
    // The owner's Pause and Resume on the Schedules page: the version's body comes from its definition record.
    await issueScheduleGrant(stores.control,{profile,job_id:job,operation:'pause',person:'owner',request_id:'legacy-pause'});
    definition={...definition,enabled:false,execution_version:'legacy-paused'};await checkpoint({grant:'legacy-pause'});
    await issueScheduleGrant(stores.control,{profile,job_id:job,operation:'resume',person:'owner',request_id:'legacy-resume'});
    definition={...definition,enabled:true,execution_version:'legacy-resumed'};await checkpoint({grant:'legacy-resume'});
    // Run now, as the owner pressed it.
    await issueScheduleGrant(stores.control,{profile,job_id:job,operation:'run',person:'owner',request_id:'legacy-run'});
    const pressed=await fire('pressed','manual',authority.epoch,{request_id:'legacy-run',scheduled_for:new Date().toISOString()});
    assert.equal(pressed.state,'captured');
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});

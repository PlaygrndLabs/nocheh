import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {canonical,digest} from '../src/archive.js';
import {reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {fixtureServices,type FakeCall} from './fixture-agent.js';
import {storageWorkflowOperations} from '../src/stores/workflow-operations.js';
import {workflowDetail} from '../src/workflows/owner.js';
import {controlStorageWorkflow} from '../src/stores/workflow-owner.js';
import {safeMetadata} from '../src/workflows/boundary.js';
import {honchoEngine} from '../src/memory/honcho.js';

test('scheduled execution uses guarded operation roots and stages exact delivery without reopening a closed turn',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-scheduled-runs-')),base=Date.now(),token=digest('scheduled-'+base);
  let failCompletion=false,mode='done',serial=0,answer='Scheduled answer fixture-secret';const calls:any[]=[],native=new Map<string,any>(),contexts=new Map<string,any>(),claims=new Map<string,any>(),tasksRead:string[]=[];
  // The groups the owner serves, which a test turns off as the owner would; `deselect` turns them off as a run finishes.
  // Notices to the owner are kept apart: the bot sends each id once.
  let groups=['-123'],deselect=false;const notices:any[]=[];
  const control=new Proxy(stores.control,{get(target,key){if(key==='connect')return async()=>{
    const db=await target.connect();return new Proxy(db,{get(client,name){if(name==='query')return (sql:any,...args:any[])=>{
      if(failCompletion&&String(sql).startsWith('UPDATE managed_runs SET state=$2,result_reference')){failCompletion=false;return Promise.reject(Error('lost control completion'));}
      return (client.query as any)(sql,...args);};const value=Reflect.get(client,name);return typeof value==='function'?value.bind(client):value;}});
  };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const runtime:FakeCall=async(op,body)=>{
    if(op==='guard.detect')return {literals:String(body.text).includes('fixture-secret')?['fixture-secret']:[]};
    if(op==='telegram.notice'){notices.push(body);return {state:'done'};}
    calls.push({op,body});if(op==='schedule.advance')return {state:'waiting',next_attempt:Date.now()+60000};
    assert.ok(op.startsWith('run.'),'no external delivery while staging a proposal');const id=String(body.event_id);
    if(op==='run.resume'){assert.equal(body.observe_only,true);return native.get(id)??{state:'not_found'};}
    if(op==='run.cancel'){native.set(id,{state:'cancelled'});return {state:'cancelled'};}
    assert.equal(op,'run.start');assert.equal(body.channel,'scheduler');
    const context:any=await s.scheduled.context(body);contexts.set(id,context);assert.ok(!('prompt' in context.definition));
    const claim=await s.scheduled.claim(context);claims.set(id,claim);assert.equal(claim.claimed,true);assert.ok(!claim.text!.includes('fixture-secret'));
    const principal=reader({headers:{authorization:'Bearer '+claim.archive_credential}} as any,token);
    const binding=await s.turns.binding(principal);assert.equal(binding.reference!.store,'control');assert.equal(binding.job,context.job_id);
    // A schedule's run in the owner's private chat, such as a morning brief, reads the task lists and the owner's views and
    // changes none; a group's schedule run gets none (ADR-0266).
    if(claim.scope==='123') {
      assert.ok(await s.tasks.chatList(principal,{}));tasksRead.push(id);
      await assert.rejects(s.tasks.chatCreate(principal,{title:'From a schedule'}),{code:'task_read_only'});
      assert.equal(await s.knowledge.ownerReader(principal),id);
      await assert.rejects(s.knowledge.ownerTurn(principal),{code:'owner_private_turn_required'},'a run is not the owner\'s live message');
    } else {
      await assert.rejects(s.tasks.chatList(principal,{}),{status:403});
      await assert.rejects(s.knowledge.ownerReader(principal),{status:403});
    }
    assert.equal((await s.scheduled.claim(context)).claimed,false);assert.deepEqual(await s.scheduled.prepare(context),{transcripts:[],files:[]});
    native.set(id,{state:'running'});if(mode==='running')return {state:'running'};
    await s.scheduled.finish({event_id:id,actor:context.actor,state:'done',session:context.conversation,text:answer});
    if(deselect){deselect=false;groups=[];}
    native.set(id,{state:'done'});if(mode==='ack_lost'){mode='done';throw Error('lost native acknowledgement');}return {state:'done'};
  };
  const s=fixtureServices({...stores,control},{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>({enabled:true,owner_id:'123',group_ids:groups}),runtime,
    memoryEngine:honchoEngine(async()=>{throw Error('no providers');})}),owner={admin:true,scope:null};
  const authority=async()=>({owner:'inngest' as const,epoch:(await s.schedules.ownership()).epoch});
  const capture=async(options:Record<string,unknown>={})=>{
    const scope=String(options.scope??'123'),profile='nocheh-'+digest(scope).slice(0,24),job='execution-'+base+'-'+(++serial);
    const definition={profile,name:'Fixture',prompt:'Prompt fixture-secret',schedule:{kind:'interval',minutes:60},deliver:'local',repeat:null,enabled:true,removed:false,
      preferences:{'agent.reasoning_effort':'high'},execution_version:'v1',...options};delete (definition as any).scope;delete (definition as any).fire_reason;
    const saved=await s.schedules.definition(owner,{scope,profile,job_id:job,definition,workflow_cursor:digest(job),workflow_sequence:1});
    const fire=await s.schedules.capture(owner,{scope,space:scope,profile,job_id:job,id:'first',text:definition.prompt,files:[],definition,
      job_revision:digest(canonical(definition)),scheduled_for:'2026-09-18T12:00:00Z',fire_reason:String(options.fire_reason??'manual'),owner_epoch:(await authority()).epoch});
    return {...fire,scope,profile,job,definition,schedule:saved.id};
  };
  const run=async(id:string)=>{const result=await storageWorkflowOperations(s,runtime).schedules!('run:'+id,await authority());safeMetadata(result);return result;};
  const saved=async(id:string)=>(await stores.control.query('SELECT * FROM managed_runs WHERE event_id=$1',[id])).rows[0];
  try{
    await s.guards.reconcile();await s.guards.setMode('on');
    const local=await capture();mode='ack_lost';assert.equal((await run(local.event_id)).state,'waiting');assert.equal((await run(local.event_id)).state,'completed');
    assert.equal((await s.scheduled.delivery(local)).state,'local');
    assert.equal(calls.filter(call=>call.op==='run.start'&&call.body.event_id===local.event_id).length,1);
    await assert.rejects(s.turns.binding(reader({headers:{authorization:'Bearer '+claims.get(local.event_id).archive_credential}} as any,token)),{code:'runtime_turn_changed'});
    assert.ok(tasksRead.includes(local.event_id),'the owner chat\'s run read its tasks');
    await assert.rejects(s.tasks.chatList(reader({headers:{authorization:'Bearer '+claims.get(local.event_id).archive_credential}} as any,token),{}),{code:'runtime_turn_changed'},'a finished run reads nothing');
    await assert.rejects(s.knowledge.ownerReader(reader({headers:{authorization:'Bearer '+claims.get(local.event_id).archive_credential}} as any,token)),{code:'runtime_turn_changed'});
    const delivered=await capture({scope:'-123',deliver:'telegram'});await run(delivered.event_id);
    const proposal=await s.scheduled.delivery(delivered);assert.equal(proposal.state,'proposed');assert.ok('id' in proposal);
    const inspected=await s.telegramActions.inspect(owner,proposal.id!);assert.ok(!JSON.stringify(inspected).includes('fixture-secret'));
    assert.equal((await s.scheduled.delivery(delivered)).state,'proposed');assert.equal((await saved(delivered.event_id)).state,'done');
    assert.equal((await stores.control.query('SELECT count(*)::int AS n FROM telegram_action_requests WHERE source_reference->>\'id\'=$1',[delivered.event_id])).rows[0].n,1);
    // Sent as a scheduled result, which memory learns with its class (ADR-0256).
    assert.equal((await stores.control.query('SELECT send_class FROM telegram_action_requests WHERE id=$1',[proposal.id])).rows[0].send_class,'scheduled_run');
    assert.equal((await s.scheduled.history({profile:delivered.profile,job_id:delivered.job})).runs[0]!.native_session,contexts.get(delivered.event_id).conversation);
    await assert.rejects(s.telegramActions.requestScheduled({admin:false,scope:'-123'},delivered.event_id),{status:403});
    // The owner's private chat: its results go there with no card, as a trusted scheduled send (ADR-0266); a scheduled run
    // that answers only [SILENT] sends nothing, and a Run now says so in one fixed line. A schedule's own time zone is part
    // of its definition.
    const own=await capture({scope:'123',deliver:'telegram',timezone:'Asia/Tokyo'});await run(own.event_id);
    const sent=await s.scheduled.delivery(own);assert.equal(sent.state,'approved');assert.ok('id' in sent);
    const row=(await stores.control.query('SELECT state,send_class,destination FROM telegram_action_requests WHERE id=$1',[sent.id])).rows[0];
    assert.deepEqual(row,{state:'approved',send_class:'scheduled_run',destination:'123'});
    assert.equal((await stores.control.query("SELECT count(*)::int AS n FROM security_events WHERE state='allowed' AND rule='owner_scheduled_chat'")).rows[0].n,1);
    assert.equal(((await s.scheduled.delivery(own)) as {id?:string}).id,sent.id,'one send for the run');
    answer='[SILENT]';const quiet=await capture({scope:'123',deliver:'telegram',fire_reason:'scheduled'});await run(quiet.event_id);
    assert.deepEqual(await s.scheduled.delivery(quiet),{state:'local'});
    const pressed=await capture({scope:'123',deliver:'telegram'});await run(pressed.event_id);
    const told=await s.scheduled.delivery(pressed);assert.equal(told.state,'approved');assert.ok('id' in told);
    assert.equal((await stores.control.query('SELECT text_hash FROM telegram_action_requests WHERE id=$1',[told.id])).rows[0].text_hash,
      digest('✅ Ran now: nothing new right now.'),'a Run now with nothing new says so');
    const group=await capture({scope:'-123',deliver:'telegram'});await run(group.event_id);
    assert.deepEqual(await s.scheduled.delivery(group),{state:'local'},'a group\'s Run now with nothing new sends nothing');
    answer='Scheduled answer fixture-secret';
    await assert.rejects(capture({timezone:'../../etc'}),{code:'invalid_schedule_definition'});
    const recovered=await capture();failCompletion=true;assert.equal((await run(recovered.event_id)).state,'waiting');
    const before=calls.length;assert.equal((await run(recovered.event_id)).state,'completed');assert.equal(calls.length,before,'durable derivative receipt repairs control without new native execution');
    const uncertain=await capture();mode='running';await run(uncertain.event_id);native.delete(uncertain.event_id);
    assert.equal((await run(uncertain.event_id)).state,'ambiguous');assert.equal((await s.scheduled.delivery(uncertain)).state,'withheld');
    const cancelled=await capture();await s.scheduled.cancel(cancelled);assert.equal((await run(cancelled.event_id)).state,'cancelled');
    // The owner stopped serving the group as its run finished: the result is held back, and the owner is told once, by the
    // run (ADR-0254). Nothing is proposed.
    mode='done';const unserved=await capture({scope:'-123',deliver:'telegram',prompt:'Group result fixture'});deselect=true;
    assert.equal((await run(unserved.event_id)).state,'completed');assert.deepEqual(groups,[]);
    const notSent=digest(canonical(['schedule-result-not-sent-v1',unserved.event_id]));
    assert.deepEqual(notices.map(notice=>notice.id),[notSent]);
    assert.deepEqual(await s.scheduled.delivery(unserved),{state:'withheld',reason:'destination_not_served'});
    assert.deepEqual([...new Set(notices.map(notice=>notice.id))],[notSent],'a run is told once');
    assert.equal(notices[0].chat_id,'123');
    assert.match(notices[0].text,/^⚠\ufe0f A scheduled task in .* \(not served now\) finished, but its result was not sent: Nocheh does not serve that chat now\.$/);
    assert.equal((await stores.control.query('SELECT count(*)::int AS n FROM telegram_action_requests WHERE source_reference->>\'id\'=$1',[unserved.event_id])).rows[0].n,0);
    // Its next time does not run either, as before, and its retries go on. The owner is told once for that fire, though the
    // epoch moves between retries, as a reaction in any served group moves it.
    notices.length=0;
    const trigger=storageWorkflowOperations(s,runtime).schedules!,fire='schedule:'+unserved.schedule+':'+digest(unserved.job);
    for(let tick=0;tick<3;tick++) {
      if(tick)await stores.control.query('UPDATE guard_state SET epoch=epoch+1 WHERE singleton');
      await assert.rejects(trigger(fire,await authority()),(error:any)=>[403,404].includes(error.status),'tick '+tick);
    }
    const notRun=digest(canonical(['schedule-not-run-v1',unserved.schedule,'-123',digest(unserved.job)]));
    assert.deepEqual([...new Set(notices.map(notice=>notice.id))],[notRun],'one notice for the fire, whatever the epoch');
    assert.match(notices[0].text,/did not run: Nocheh does not serve that chat now\. It runs again once you select that group/);
    groups=['-123'];notices.length=0;mode='running';
    const epoch=await capture();await s.guards.setMode('off');assert.equal((await run(epoch.event_id)).state,'cancelled');
    assert.equal((await s.scheduled.delivery(delivered)).state,'withheld');
    // A result held back by a settings change is told too, once for the run; one kept in Nocheh never is.
    assert.deepEqual(notices.map(notice=>notice.id),[digest(canonical(['schedule-result-not-sent-v1',delivered.event_id]))]);
    assert.match(notices[0].text,/finished, but its result was not sent: your settings changed while it ran\./);
    mode='done';const off=await capture({prompt:'Explicit guard off'});assert.equal((await run(off.event_id)).state,'completed');
    assert.equal((await storageWorkflowOperations(s,runtime).schedules!('schedule:'+off.schedule+':'+digest(off.job),await authority())).state,'waiting');
    assert.equal((await storageWorkflowOperations(s,runtime).schedules!('schedule:'+off.schedule+':'+digest('obsolete'),await authority())).state,'skipped');
    assert.equal((await stores.archive.query("SELECT count(*)::int AS n FROM events WHERE channel='scheduler'")).rows[0].n,0);
    const receipts=(await stores.control.query("SELECT state FROM workflow_receipts WHERE step='scheduler' AND workflow_id IN (SELECT id FROM workflow_registry WHERE family='schedules' AND job_id=$1)",['run:'+recovered.event_id])).rows;
    assert.deepEqual(receipts.map(r=>r.state),['done']);
    const queued=await capture({prompt:'Owner cancellation'}),workflow=(await stores.control.query("SELECT * FROM workflow_registry WHERE family='schedules' AND job_id=$1",['run:'+queued.event_id])).rows[0];
    const detail=await workflowDetail(stores.control,workflow.id);assert.equal(detail.can_cancel,true);assert.equal(detail.source_event_id,null);
    await controlStorageWorkflow(stores.control,owner,workflow.id,'cancel',{revision:workflow.revision});
    assert.equal((await run(queued.event_id)).state,'cancelled');

  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

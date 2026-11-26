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
import {githubRunRefusal} from '../src/stores/github-lookups.js';
import {gmailRunRefusal} from '../src/stores/gmail-lookups.js';
import {notionRunRefusal} from '../src/stores/notion.js';
import {issueClockGrant,issueScheduleGrant,recordScheduleDefinition} from '../src/stores/schedules.js';

test('scheduled execution uses guarded operation roots and stages exact delivery without reopening a closed turn',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-scheduled-runs-')),base=Date.now(),token=digest('scheduled-'+base);
  let failCompletion=false,mode='done',serial=0,answer='Scheduled answer fixture-secret';const calls:any[]=[],native=new Map<string,any>(),contexts=new Map<string,any>(),claims=new Map<string,any>(),tasksRead:string[]=[],lookups:{state:string;id:string}[]=[],refusals:(string|null)[]=[];
  // The groups the owner serves, which a test turns off as the owner would; `deselect` turns them off as a run finishes.
  // Notices to the owner are kept apart: the bot sends each id once.
  let groups=['-123'],deselect=false,advanceTimeout=false;const notices:any[]=[];const clocks:any[][]=[],cards:any[]=[];
  const control=new Proxy(stores.control,{get(target,key){if(key==='connect')return async()=>{
    const db=await target.connect();return new Proxy(db,{get(client,name){if(name==='query')return (sql:any,...args:any[])=>{
      if(failCompletion&&String(sql).startsWith('UPDATE managed_runs SET state=$2,result_reference')){failCompletion=false;return Promise.reject(Error('lost control completion'));}
      return (client.query as any)(sql,...args);};const value=Reflect.get(client,name);return typeof value==='function'?value.bind(client):value;}});
  };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const runtime:FakeCall=async(op,body)=>{
    if(op==='guard.detect')return {literals:String(body.text).includes('fixture-secret')?['fixture-secret']:[]};
    if(op==='telegram.notice'){notices.push(body);return {state:'done'};}
    if(op==='telegram.approval'){cards.push(body);return {state:'done'};}
    calls.push({op,body});
    // Hermes may capture a timed fire only while Nocheh's advance runs: its clock grant is there then, for that cursor.
    if(op==='schedule.advance'){clocks.push((await stores.control.query("SELECT cursor,owner_epoch FROM schedule_grants WHERE kind='clock' AND used_by IS NULL")).rows);
      if(advanceTimeout){advanceTimeout=false;throw Error('advance timed out');}
      return {state:'waiting',next_attempt:Date.now()+60000};}
    assert.ok(op.startsWith('run.'),'no external delivery while staging a proposal');const id=String(body.event_id);
    if(op==='run.resume'){assert.equal(body.observe_only,true);return native.get(id)??{state:'not_found'};}
    if(op==='run.cancel'){native.set(id,{state:'cancelled'});return {state:'cancelled'};}
    assert.equal(op,'run.start');assert.equal(body.channel,'scheduler');
    const context:any=await s.scheduled.context(body);contexts.set(id,context);assert.ok(!('prompt' in context.definition));
    const claim=await s.scheduled.claim(context);claims.set(id,claim);assert.equal(claim.claimed,true);assert.ok(!claim.text!.includes('fixture-secret'));
    const principal=reader({headers:{authorization:'Bearer '+claim.archive_credential}} as any,token);
    // The run is made for the schedule's creator and the agent plugged in now, and its key names both (ADR-0305).
    assert.deepEqual((await stores.control.query('SELECT person,agent FROM managed_runs WHERE event_id=$1',[id])).rows[0],{person:'owner',agent:'hermes'});
    assert.deepEqual([principal.person,principal.keyKind],['owner','scheduled']);
    const binding=await s.turns.binding(principal);assert.equal(binding.reference!.store,'control');assert.equal(binding.job,context.job_id);
    // A run whose person or agent no longer fits its key is refused (ADR-0305).
    for(const [column,value] of [['person','a'.repeat(64)],['agent','other-agent']] as const) {
      const before=(await stores.control.query(`SELECT ${column} AS value FROM managed_runs WHERE event_id=$1`,[id])).rows[0].value;
      await stores.control.query(`UPDATE managed_runs SET ${column}=$2 WHERE event_id=$1`,[id,value]);
      try{await assert.rejects(s.turns.binding(principal),{status:409,code:'one_time_key_person_changed'},column);}
      finally{await stores.control.query(`UPDATE managed_runs SET ${column}=$2 WHERE event_id=$1`,[id,before]);}
    }
    // A schedule's run in the owner's private chat, such as a morning brief, reads the task lists and the owner's views and
    // changes none; a group's schedule run gets none (ADR-0266).
    if(claim.scope==='123') {
      assert.ok(await s.tasks.chatList(principal,{}));tasksRead.push(id);
      await assert.rejects(s.tasks.chatCreate(principal,{title:'From a schedule'}),{code:'task_read_only'});
      assert.equal(await s.knowledge.ownerReader(principal),id);
      await assert.rejects(s.knowledge.ownerTurn(principal),{code:'owner_private_turn_required'},'a run is not the owner\'s live message');
      // It reads the owner's GitHub, Notion and Gmail with no card; a change still asks (ADR-0278, ADR-0272).
      if(!lookups.length) {
        const ask=async(args:Record<string,unknown>)=>s.controlledActions.propose(principal,{kind:'mcp',arguments:args}) as Promise<{state:string;id:string}>;
        lookups.push(await ask(github),await ask({connection:'notion',tool:'notion-search',input:{query:'reading list'}}),
          await ask({connection:'notion',tool:'notion-create-pages',input:{pages:[{properties:{title:'Plan'}}]}}),await ask(gmail));
        const row=(await stores.control.query('SELECT * FROM controlled_actions WHERE id=$1',[lookups[0]!.id])).rows[0];
        refusals.push(await githubRunRefusal(stores.control,row,'123',github),
          await notionRunRefusal(stores.control,{...(await stores.control.query('SELECT * FROM controlled_actions WHERE id=$1',[lookups[1]!.id])).rows[0]},'123',{}),
          await gmailRunRefusal(stores.control,(await stores.control.query('SELECT * FROM controlled_actions WHERE id=$1',[lookups[3]!.id])).rows[0],'123'));
        // Each operation keeps the person and agent of the key that asked (ADR-0305); the owner's own connectors refuse a
        // row made for anyone else.
        assert.deepEqual([row.person,row.agent],['owner','hermes']);
        const member='a'.repeat(64),mail=(await stores.control.query('SELECT * FROM controlled_actions WHERE id=$1',[lookups[3]!.id])).rows[0];
        assert.equal(await githubRunRefusal(stores.control,{...row,person:member},'123',github),'github_not_here');
        assert.equal(await gmailRunRefusal(stores.control,{...mail,person:member},'123'),'gmail_not_here');
        assert.equal(await notionRunRefusal(stores.control,{...(await stores.control.query('SELECT * FROM controlled_actions WHERE id=$1',[lookups[1]!.id])).rows[0],person:member},'123',{}),
          'notion_owner_private_only');
      }
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
  const github={connection:'github',tool:'search_code',input:{repo:'example-org/mine',query:'made up'}},gmail={connection:'gmail',tool:'search_mail',input:{query:'invoice'}};
  const capture=async(options:Record<string,unknown>={})=>{
    const scope=String(options.scope??'123'),profile='nocheh-'+digest(scope).slice(0,24),job='execution-'+base+'-'+(++serial);
    const definition={profile,name:'Fixture',prompt:'Prompt fixture-secret',schedule:{kind:'interval',minutes:60},deliver:'local',repeat:null,enabled:true,removed:false,
      preferences:{'agent.reasoning_effort':'high'},execution_version:'v1',...options};delete (definition as any).scope;delete (definition as any).fire_reason;
    // Set by asking (the turn route's own record), then fired by a press's Run now grant or the clock grant of an advance.
    const saved=await recordScheduleDefinition(s.schedules,{scope,profile,job_id:job,definition,workflow_cursor:digest(job),workflow_sequence:1});
    const reason=String(options.fire_reason??'manual'),epoch=(await authority()).epoch;
    if(reason==='manual')await issueScheduleGrant(stores.control,{profile,job_id:job,operation:'run',person:'owner',request_id:'run-'+job});
    else await issueClockGrant(stores.control,saved.id,digest(job),epoch);
    const fire=await s.schedules.capture(owner,{scope,space:scope,profile,job_id:job,id:'first',text:definition.prompt,files:[],definition,
      job_revision:digest(canonical(definition)),scheduled_for:new Date(Date.now()-1000).toISOString(),fire_reason:reason,owner_epoch:epoch,
      ...(reason==='manual'?{request_id:'run-'+job}:{})});
    return {...fire,scope,profile,job,definition,schedule:saved.id};
  };
  const run=async(id:string)=>{const result=await storageWorkflowOperations(s,runtime).schedules!('run:'+id,await authority());safeMetadata(result);return result;};
  const saved=async(id:string)=>(await stores.control.query('SELECT * FROM managed_runs WHERE event_id=$1',[id])).rows[0];
  try{
    await s.guards.reconcile();await s.guards.setMode('on');await s.notion.save(owner,{enabled:true,expected_revision:0});
    const local=await capture();mode='ack_lost';assert.equal((await run(local.event_id)).state,'waiting');assert.equal((await run(local.event_id)).state,'completed');
    assert.deepEqual(lookups.map(item=>item.state),['approved','approved','proposed','approved'],'reads run with no card, a change asks');
    assert.deepEqual(refusals,[null,null,null],'while the run goes on');
    const looked=(await stores.control.query('SELECT * FROM controlled_actions WHERE id=$1',[lookups[0]!.id])).rows[0];
    assert.equal(await githubRunRefusal(stores.control,looked,'123',github),'github_not_here','once the run ended');
    assert.equal(await gmailRunRefusal(stores.control,(await stores.control.query('SELECT * FROM controlled_actions WHERE id=$1',[lookups[3]!.id])).rows[0],'123'),'gmail_not_here');
    assert.equal((await s.scheduled.delivery(local)).state,'local');
    assert.equal(calls.filter(call=>call.op==='run.start'&&call.body.event_id===local.event_id).length,1);
    // The run ended: its one-time key closed with it, so its pass reaches nothing (ADR-0305).
    const ended=reader({headers:{authorization:'Bearer '+claims.get(local.event_id).archive_credential}} as any,token);
    assert.deepEqual([ended.person,ended.keyKind,ended.agent],['owner','scheduled','hermes'],'the run\'s key names the schedule\'s creator');
    assert.deepEqual((await stores.control.query('SELECT kind,person,closed_reason FROM one_time_keys WHERE jti=$1',[ended.jti])).rows,
      [{kind:'scheduled',person:'owner',closed_reason:'run_finished'}]);
    await assert.rejects(s.turns.assertKey(ended),{code:'one_time_key_closed'});
    await assert.rejects(s.turns.binding(ended),{code:'one_time_key_closed'});
    assert.ok(tasksRead.includes(local.event_id),'the owner chat\'s run read its tasks');
    await assert.rejects(s.tasks.chatList(ended,{}),{code:'one_time_key_closed'},'a finished run reads nothing');
    await assert.rejects(s.knowledge.ownerReader(ended),{code:'one_time_key_closed'});
    // Without its key check (a reader Nocheh built itself), the closed runtime turn still refuses it.
    const {jti:_jti,...unkeyed}=ended;
    await assert.rejects(s.turns.binding(unkeyed),{code:'runtime_turn_changed'});
    const delivered=await capture({scope:'-123',deliver:'telegram'});await run(delivered.event_id);
    const proposal=await s.scheduled.delivery(delivered);assert.equal(proposal.state,'proposed');assert.ok('id' in proposal);
    // Nocheh offers the owner's card itself once the run completes; Hermes no longer asks (ADR-0290).
    assert.deepEqual(cards.filter(card=>card.id===proposal.id).map(card=>card.kind),['card']);
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
    assert.equal((await stores.control.query("SELECT count(*)::int AS n FROM security_events WHERE effect_id=$1 AND state='awaiting_approval'",[sent.id])).rows[0].n,0,
      'delivering again logs no wait for approval');
    answer='[SILENT]';const quiet=await capture({scope:'123',deliver:'telegram',fire_reason:'scheduled'});await run(quiet.event_id);
    assert.deepEqual(await s.scheduled.delivery(quiet),{state:'local'});
    const pressed=await capture({scope:'123',deliver:'telegram'});await run(pressed.event_id);
    const told=await s.scheduled.delivery(pressed);assert.equal(told.state,'approved');assert.ok('id' in told);
    assert.equal((await stores.control.query('SELECT text_hash FROM telegram_action_requests WHERE id=$1',[told.id])).rows[0].text_hash,
      digest('✅ Fixture: ran now, nothing new right now.'),'a Run now with nothing new says so');
    const group=await capture({scope:'-123',deliver:'telegram'});await run(group.event_id);
    assert.deepEqual(await s.scheduled.delivery(group),{state:'local'},'a group\'s Run now with nothing new sends nothing');
    answer='Scheduled answer fixture-secret';
    await assert.rejects(capture({timezone:'../../etc'}),{code:'invalid_schedule_definition'});
    const recovered=await capture();failCompletion=true;assert.equal((await run(recovered.event_id)).state,'waiting');
    const before=calls.length;assert.equal((await run(recovered.event_id)).state,'completed');assert.equal(calls.length,before,'durable derivative receipt repairs control without new native execution');
    const uncertain=await capture();mode='running';await run(uncertain.event_id);native.delete(uncertain.event_id);
    assert.equal((await run(uncertain.event_id)).state,'ambiguous');assert.equal((await s.scheduled.delivery(uncertain)).state,'withheld');
    // A run that stopped partway sent nothing: the owner is told, naming the schedule, instead of silence (ADR-0266).
    const stopped=digest(canonical(['schedule-run-failed-v1',uncertain.event_id]));
    assert.equal((await run(uncertain.event_id)).state,'ambiguous');
    assert.deepEqual([...new Set(notices.map(notice=>notice.id))],[stopped],'told once for the run, as the bot sends each id once');
    assert.equal(notices[0].chat_id,'123');
    assert.equal(notices[0].text,'⚠\ufe0f The scheduled task \u2068\u201cFixture\u201d\u2069 in your private chat stopped before it finished, so it sent nothing. Its runs are on the dashboard Schedules page.');
    notices.length=0;
    const cancelled=await capture();await s.scheduled.cancel(cancelled);assert.equal((await run(cancelled.event_id)).state,'cancelled');
    assert.equal(notices.length,0,'a cancelled run is not a failure');
    // Each schedule's runs for the Schedules page: when, timed or Run now, and how each ended, never what it said (ADR-0266).
    const log=async(item:{scope:string;job:string})=>(await s.scheduled.runLog(item.scope,item.job)).runs;
    assert.deepEqual((await log(own)).map(item=>[item.trigger,item.result]),[['run_now','sending']]);
    await stores.control.query("UPDATE telegram_action_requests SET state='done' WHERE id=$1",[sent.id]);
    assert.deepEqual((await log(own)).map(item=>item.result),['sent']);
    assert.deepEqual((await log(quiet)).map(item=>[item.trigger,item.result]),[['timed','nothing_new']]);
    assert.deepEqual((await log(pressed)).map(item=>item.result),['nothing_new']);
    assert.deepEqual((await log(delivered)).map(item=>item.result),['waiting']);
    assert.deepEqual((await log(local)).map(item=>item.result),['kept']);
    assert.deepEqual((await log(cancelled)).map(item=>item.result),['stopped']);
    assert.deepEqual((await log(uncertain)).map(item=>item.result),['failed']);
    assert.ok(!JSON.stringify(await log(own)).includes('fixture-secret'),'a run log never carries what a run said');
    assert.deepEqual(await log({scope:'-123',job:own.job}),[],'a job is listed only in its own chat');
    await assert.rejects(s.scheduled.runLog('123','../x'),{code:'invalid_run_identity'});
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
    assert.deepEqual(clocks,[[{cursor:digest(off.job),owner_epoch:String((await authority()).epoch)}]]);
    assert.equal((await stores.control.query("SELECT count(*)::int AS n FROM schedule_grants WHERE kind='clock' AND used_by IS NULL")).rows[0].n,0,'gone once advance answered');
    // An advance this side gave up on (its call timed out) may still be capturing in Hermes: its grant stays, past the
    // call's 20 s, until it expires.
    advanceTimeout=true;
    await assert.rejects(storageWorkflowOperations(s,runtime).schedules!('schedule:'+off.schedule+':'+digest(off.job),await authority()),/advance timed out/);
    assert.deepEqual((await stores.control.query(`SELECT cursor,expires_at>now()+interval '60 seconds' AS lasts FROM schedule_grants
      WHERE kind='clock' AND used_by IS NULL`)).rows,[{cursor:digest(off.job),lasts:true}]);
    await stores.control.query("DELETE FROM schedule_grants WHERE kind='clock'");
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

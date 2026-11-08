import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {jobDeadlines,ownerApprovedJob} from '../src/stores/background-jobs.js';
import {storageServices} from '../src/stores/services.js';
import {claimHostWorkflow} from '../src/workflows/host-coordinator.js';

test('a job is one run priced from its progress, stopped at its cost or time limit with a note, relaunched at most twice, and a relaunch asks for every change',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-job-runs-')),key='job-runs:'+Date.now(),group='-100555',other='-100777';
  const cards:Record<string,any>[]=[],owner:Reader={admin:true,scope:null};let granted=['9'];
  const policy=()=>({enabled:true,owner_id:'123',group_ids:[group,other],group_access:{[group]:{granted,denied:[]}},topic_memory:'group' as const});
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='usage.price')return {rates:{input:2,output:10,cache_read:0.2,cache_write:2.5}};
      if(operation==='run.resume')return {state:'not_found'};
      if(operation==='run.start'||operation==='run.cancel')return {state:'queued'};
      assert.equal(operation,'telegram.approval');cards.push(input);return {state:'done',chat_id:input.chat_id,message_id:'5'};
    },honcho:async()=>{throw Error('no memory provider');}});
  let updates=0,sent=100,reactions=0,noted=0;
  const capture=async(chat:string,payload:Record<string,any>)=>{
    const update=++updates,event:Envelope={version:1,key:key+':'+update,origin:'live',kind:'telegram_update',bot_id:key,scope:chat,
      source_id:String(payload.message?.message_id??payload.message_reaction?.message_id),revision:String(update),occurred_at:null,text:payload.message?.text??null,payload:{update_id:update,...payload}};
    return (await s.capture.capture(event)).source.reference;
  };
  const message=async(chat:string,text:string,from=9)=>{
    const source=await capture(chat,{message:{message_id:++sent,date:1700000000+sent,chat:{id:Number(chat),type:chat==='123'?'private':'supergroup'},from:{id:from,first_name:'Person'},text}});
    await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  /** A reaction in the other group only starts a quiet epoch. */
  const react=async()=>{
    const before=(await s.guards.state()).epoch,emoji=++reactions%2?'👍':'❤️';
    await capture(other,{message_reaction:{chat:{id:Number(other),type:'supergroup'},message_id:noted,date:1700000500+reactions,user:{id:7},
      old_reaction:reactions===1?[]:[{type:'emoji',emoji:emoji==='👍'?'❤️':'👍'}],new_reaction:[{type:'emoji',emoji}]}});
    assert.equal((await s.guards.state()).epoch,before+1,'the reaction moves the epoch');
  };
  const actor=async(source:string,scope:string|null,space:string):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope,space,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const authority=async()=>({owner:'inngest' as const,epoch:Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='background'")).rows[0].epoch)});
  const tick=async(id:string)=>s.jobs.operation('job:'+id,await authority());
  const job=async(id:string)=>(await stores.control.query('SELECT * FROM background_jobs WHERE id=$1',[id])).rows[0];
  const latest=async(id:string)=>(await stores.control.query(`SELECT b.*,r.state AS run_state,r.cancel_requested AS run_cancel FROM background_runs b
    JOIN managed_runs r ON r.event_id=b.event_id WHERE b.job_id=$1 ORDER BY b.attempt DESC LIMIT 1`,[id])).rows[0];
  const reports=async(id:string)=>(await stores.control.query('SELECT a.* FROM background_reports b JOIN telegram_action_requests a ON a.id=b.action_id WHERE b.job_id=$1 ORDER BY b.part',[id])).rows;
  /** A member's job in the group, or the owner's in their private chat, approved and with its first run recorded. */
  const approved=async(title:string,mine=false)=>{
    const chat=mine?'123':group,from=mine?123:9;
    const proposed=await s.jobs.start(await actor((await message(chat,'Please check the made-up task list',from)).id,mine?null:group,chat),
      {title,instruction:'Compare the made-up task list with the group chat.',chat:group});
    await s.jobs.decide(String(from),{id:proposed.id,fingerprint:proposed.fingerprint,decision:'approve'},await message(chat,'Approve it',from));
    await tick(proposed.id);return proposed.id;
  };
  /** What Hermes does with a job's latest run: read its context and claim it. */
  const claim=async(id:string)=>{
    const event=(await latest(id)).event_id as string;
    await s.jobs.runs.run(event,await authority());
    const context:any=await s.jobs.runs.context({event_id:event,owner_epoch:(await authority()).epoch});
    const claimed:any=await s.jobs.runs.claim({...context,actor:context.actor});await s.jobs.runs.prepare({...context,actor:context.actor});
    return {event,context,claimed,text:String(claimed.text)};
  };
  const beat=(run:{context:any},progress?:unknown)=>s.jobs.runs.heartbeat({...run.context,actor:run.context.actor,...(progress===undefined?{}:{progress})});
  const finish=(run:{event:string;context:any},state:string,extra:Record<string,unknown>={})=>s.jobs.runs.finish({event_id:run.event,actor:run.context.actor,state,
    session:run.context.conversation,error_code:state==='failed'?'model_unavailable':null,text:'',...extra});
  const counts=(input_tokens:number,calls=1,more:Partial<Record<'output_tokens'|'cache_read_tokens'|'cache_write_tokens',number>>={})=>
    ({input_tokens,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,calls,...more});
  /** Deliver every part a job staged, until it ends. */
  const deliver=async(id:string)=>{
    for(let round=0;round<5;round++) {
      await stores.control.query("UPDATE telegram_action_requests SET state='done' WHERE id IN (SELECT action_id FROM background_reports WHERE job_id=$1)",[id]);
      const seen=await tick(id);if(seen.state!=='waiting')return seen;
    }
    throw Error('the job did not end');
  };
  const back=(id:string,minutes:number)=>stores.control.query("UPDATE background_jobs SET started_at=now()-$2::integer*interval '1 minute' WHERE id=$1",[id,minutes]);
  const todo=[{content:'Check the made-up invoice',status:'pending'}];
  const resumed=(title:string)=>`[Background job: ${title}] The job was interrupted and restarted. Your to-do list and the work so far are above; the last tool call may not have finished. Continue, and write the final report as your answer when done.`;
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    await s.jobs.saveSettings(owner,{cost_limit_usd:5,minutes_limit:45,member_daily_jobs:20,revision:(await s.jobs.settings()).revision});
    await message(other,'A made-up note in the other group');noted=sent;
    const note=await message(group,'A made-up task: send the invoice');

    // One run, watched every 15 seconds; its context carries what the turn needs to warn and stop on its own.
    const priced=await approved('Cost check');
    const waiting=await tick(priced);assert.equal(waiting.state,'waiting');assert.ok(waiting.next_attempt-Date.now()>=14000,'the job is watched every 15 seconds');
    assert.ok((await s.jobs.runs.run((await latest(priced)).event_id,await authority())).next_attempt-Date.now()>=14000,'so is its run');
    const one=await claim(priced),started=await job(priced),{soft,hard,credential}=jobDeadlines(started);
    assert.equal(hard-soft,180000);assert.equal(soft-new Date(started.started_at).getTime(),45*60000);
    assert.deepEqual(one.context.background,{job_id:priced,attempt:1,max_iterations:300,box:false,soft_deadline:Math.floor(soft/1000),hard_deadline:Math.floor(hard/1000),
      rates:{input:2,output:10,cache_read:0.2,cache_write:2.5,request:null},cost_limit_usd:5,prior_cost_usd:0});
    const claims=JSON.parse(Buffer.from(String(one.claimed.archive_credential).split('.')[1]!,'base64url').toString());
    assert.ok(Math.abs(claims.expires-credential)<1000&&credential===hard+120000,'the credential lasts until 2 minutes after the hard deadline');
    // The run's cost is priced at the job's frozen rates from its heartbeats, and never goes down.
    assert.deepEqual(await beat(one,{tokens:{input_tokens:100000,output_tokens:10000,cache_read_tokens:500000,cache_write_tokens:40000,calls:3},unknown_calls:0,todo}),
      {event_id:one.event,state:'running',cancel_requested:false});
    assert.deepEqual([Number((await latest(priced)).cost_usd),Number((await job(priced)).cost_usd)],[0.5,0.5]);
    const listed=(await s.jobs.list(owner)).jobs.find(item=>item.id===priced)!;
    assert.deepEqual([listed.cost_usd,listed.todo,listed.attempts,listed.ended],[0.5,todo,1,null],'the dashboard shows the live cost and to-do list');
    await beat(one,{tokens:counts(1000),unknown_calls:0});
    assert.deepEqual([(await latest(priced)).tokens.input_tokens,Number((await job(priced)).cost_usd)],[100000,0.5],'a lower count changes nothing');
    await assert.rejects(beat(one,{tokens:counts(1000),unknown_calls:0,extra:1}),{status:400,code:'invalid_run_progress'});
    // The receipt's larger counts raise the cost.
    await finish(one,'failed',{tokens:{input_tokens:200000,output_tokens:10000,cache_read_tokens:500000,cache_write_tokens:40000,calls:4},unknown_calls:0});
    assert.equal(Number((await job(priced)).cost_usd),0.7);
    // A run that did not finish is relaunched in the same epoch: Hermes has its work so far, so it is told to go on.
    assert.equal((await tick(priced)).state,'waiting');
    const two=await claim(priced);
    assert.equal(two.text,resumed('Cost check'));
    assert.deepEqual([two.context.background.attempt,two.context.background.prior_cost_usd,(await job(priced)).attempts],[2,0.7,2]);
    // At the cost limit the heartbeat ends the run and closes its turn, so the broker refuses its next call.
    assert.equal((await beat(two,{tokens:counts(2000000),unknown_calls:0})).cancel_requested,false);
    assert.equal(Number((await job(priced)).cost_usd),4.7,'the job costs what its runs cost');
    assert.equal((await beat(two,{tokens:counts(2200000),unknown_calls:0})).cancel_requested,true);
    const ended=await latest(priced);assert.deepEqual([ended.ended,ended.run_cancel,Number(ended.cost_usd)],['cost',true,4.4]);
    assert.equal((await stores.control.query('SELECT state FROM runtime_turns WHERE id=$1',[two.event])).rows[0].state,'closed');
    const runReader={...await actor(two.event,group,group),logical_profile:'job-'+priced.slice(0,24)};
    await assert.rejects(s.turns.binding(runReader),{status:409,code:'runtime_turn_changed'});
    // A smaller receipt leaves the counts kept.
    await finish(two,'done',{text:'A report too late.',tokens:counts(100),unknown_calls:0});
    assert.deepEqual([(await latest(priced)).run_state,Number((await latest(priced)).cost_usd)],['cancelled',4.4]);
    // No model writes a report at the limit: a short note of the last to-do list goes out instead.
    assert.equal((await tick(priced)).stage,'delivery');
    const [limitNote]=await reports(priced);
    assert.equal(limitNote.destination,group);
    assert.equal(limitNote.text_hash,digest('⏱ Cost check: the job stopped at its cost limit before it wrote a report.\n✅ Done: nothing yet\n⏳ Left: Check the made-up invoice'));
    assert.equal((await deliver(priced)).state,'completed');
    assert.deepEqual([(await job(priced)).state,(await job(priced)).ended,(await job(priced)).attempts],['done','cost',2]);

    // At the time limit: a running run is ended by its heartbeat, one that ended after it gets the note, and one still waiting is cancelled.
    const timed=await approved('Time check'),late=await claim(timed);
    await back(timed,49);
    assert.equal((await beat(late)).cancel_requested,true);assert.equal((await latest(timed)).ended,'time');
    await finish(late,'interrupted');
    assert.equal((await tick(timed)).stage,'delivery');
    assert.equal((await reports(timed))[0].text_hash,digest('⏱ Time check: the job stopped at its time limit before it wrote a report.\nNo to-do list was kept.'));
    await deliver(timed);assert.deepEqual([(await job(timed)).state,(await job(timed)).ended],['done','time']);
    const crashed=await approved('Crash check'),lost=await claim(crashed);
    await back(crashed,49);await finish(lost,'interrupted');
    assert.equal((await tick(crashed)).stage,'delivery','a run that ended past the hard deadline ends at the time limit');
    await deliver(crashed);assert.deepEqual([(await job(crashed)).ended,(await latest(crashed)).ended],['time',null]);
    const queued=await approved('Queue check');
    await back(queued,49);
    assert.equal((await tick(queued)).state,'waiting');
    assert.deepEqual([(await latest(queued)).run_state,(await latest(queued)).ended],['cancelled','time'],'a run still waiting past the hard deadline is cancelled');
    assert.equal((await tick(queued)).stage,'delivery');await deliver(queued);assert.equal((await job(queued)).ended,'time');

    // A member removed from the chat: the heartbeat refuses, the job fails, and nothing is sent.
    const revoked=await approved('Revoked check'),cut=await claim(revoked),requests=Number((await stores.control.query('SELECT count(*) FROM telegram_action_requests')).rows[0].count);
    granted=[];
    await assert.rejects(beat(cut),{status:403,code:'job_not_permitted'});
    await finish(cut,'interrupted');
    assert.equal((await tick(revoked)).state,'failed');
    assert.deepEqual([(await job(revoked)).state,(await job(revoked)).error_code],['failed','job_not_permitted']);
    assert.equal(Number((await stores.control.query('SELECT count(*) FROM telegram_action_requests')).rows[0].count),requests,'nothing is sent');
    // A relaunch of a removed member's job is cancelled before it starts, and the job fails.
    granted=['9'];
    const relaunched=await approved('Relaunch check');await finish(await claim(relaunched),'failed');
    assert.equal((await tick(relaunched)).state,'waiting');assert.equal((await latest(relaunched)).attempt,2);
    granted=[];
    await s.jobs.runs.run((await latest(relaunched)).event_id,await authority());
    assert.equal((await latest(relaunched)).run_state,'cancelled');
    assert.equal((await tick(relaunched)).state,'failed');assert.equal((await job(relaunched)).error_code,'job_not_permitted');
    // A report is not sent for a member removed after the run.
    granted=['9'];
    const reported=await approved('Report check'),done=await claim(reported);
    await finish(done,'done',{text:'Report: made-up task 12 is open.'});
    granted=[];
    assert.equal((await tick(reported)).state,'failed');
    assert.deepEqual([(await job(reported)).error_code,(await reports(reported)).length],['job_not_permitted',0]);
    granted=['9'];
    assert.equal(Number((await stores.control.query("SELECT count(*) FROM background_jobs WHERE state IN ('running','reporting')")).rows[0].count),0,'the slots are free');

    // After a change that is not quiet, a relaunch starts over with the first message and no to-do list; after quiet epochs
    // only, it keeps the earlier run's binding, so Hermes reloads its history, and gets the resume line (ADR-0208). A job is
    // relaunched at most twice.
    const restarted=await approved('Restart check'),first=await claim(restarted);
    await beat(first,{tokens:counts(1000),unknown_calls:0,todo});await finish(first,'failed');
    const copy=await s.guards.read('events:'+note.id,await s.guards.state());
    await s.guards.edit('events:'+note.id,copy.revision,{...copy.value as any,text:'An edited made-up note'},key+':edit');
    await tick(restarted);
    const second=await claim(restarted);
    assert.match(second.text,/^\[Background job: Restart check\]\nYou are running a background job[^]*\n\nThis job restarted and its earlier work could not be kept\.$/);
    assert.doesNotMatch(second.text,/Your last to-do list/);
    await beat(second,{tokens:counts(1000),unknown_calls:0,todo});await finish(second,'failed');
    await react();
    await tick(restarted);
    const third=await claim(restarted);
    assert.equal(third.text,resumed('Restart check'));
    assert.deepEqual([third.context.revision,third.context.generation],[second.context.revision,second.context.generation],'the binding of the run before');
    await finish(third,'failed');
    assert.equal((await tick(restarted)).state,'failed');
    assert.deepEqual([(await job(restarted)).error_code,(await job(restarted)).attempts],['model_unavailable',3]);

    // No relaunch with less than 3 minutes to the time limit, or once the job's cost reached its limit.
    const near=await approved('Near check');await back(near,43);await finish(await claim(near),'failed');
    assert.equal((await tick(near)).state,'failed');assert.equal((await job(near)).attempts,1);
    const spent=await approved('Spent check');await finish(await claim(spent),'failed');
    await stores.control.query('UPDATE background_jobs SET cost_usd=5 WHERE id=$1',[spent]);
    assert.equal((await tick(spent)).state,'failed');assert.equal((await job(spent)).attempts,1);

    // The owner's own job: both its runs run as the owner approved it, but a relaunched run asks for every change.
    await s.notion.save(owner,{enabled:true,approval:'changes',expected_revision:(await s.notion.get(owner)).revision});
    const mine=await approved('Notion check',true),own=await claim(mine);
    const turn=(run:{event:string})=>({owner:true,job:mine,logical_profile:'job-'+mine.slice(0,24),event:run.event});
    const ownReader=async(run:{event:string})=>({...await actor(run.event,null,'123'),logical_profile:'job-'+mine.slice(0,24)});
    const fetch={kind:'mcp',arguments:{connection:'notion',tool:'notion-fetch',input:{id:'0123456789abcdef0123456789abcdef'}}};
    assert.equal(await ownerApprovedJob(stores.control,'123',{store:'control',id:own.event},turn(own)),true);
    assert.equal((await s.controlledActions.propose(await ownReader(own),fetch)).state,'approved','a first run reads Notion under the owner\'s setting');
    const shell={kind:'shell',arguments:{command:'printf made-up-check'}},asked=await s.controlledActions.propose(await ownReader(own),shell);
    const permission=await s.controlledActions.grant(owner,{action_id:asked.id,fingerprint:asked.fingerprint,uses:3,minutes:30});
    assert.equal((await s.controlledActions.grants((await stores.control.query('SELECT * FROM controlled_actions WHERE id=$1',[asked.id])).rows[0])).length,1);
    await beat(own,{tokens:counts(1000),unknown_calls:0});await finish(own,'failed');await tick(mine);
    const again=await claim(mine);
    assert.equal(again.text,resumed('Notion check'));
    assert.equal(await ownerApprovedJob(stores.control,'123',{store:'control',id:again.event},turn(again)),true);
    assert.equal((await s.controlledActions.propose(await ownReader(again),fetch)).state,'proposed','a relaunched run gets no autonomy');
    const repeated=await s.controlledActions.propose(await ownReader(again),shell);
    assert.equal(repeated.fingerprint,asked.fingerprint);assert.notEqual(repeated.id,asked.id);
    assert.deepEqual(await s.controlledActions.grants((await stores.control.query('SELECT * FROM controlled_actions WHERE id=$1',[repeated.id])).rows[0]),[],
      'nor does a standing permission apply to it');
    const workflow=(await stores.control.query("SELECT * FROM workflow_registry WHERE family='tools' AND job_id=$1",[repeated.id])).rows[0];
    const lease=await claimHostWorkflow(stores.control,{workflow_id:workflow.id,dispatch:workflow.dispatch,family:'tools',run_id:'fixture-'+workflow.id});
    assert.deepEqual(await s.controlledExecution.claim({id:repeated.id,actor:'wf-'+workflow.id,workflow_id:workflow.id,workflow_token:lease.token}),{claimed:false});
    assert.equal((await stores.control.query('SELECT remaining FROM action_permissions WHERE id=$1',[permission.id])).rows[0].remaining,3);
    await s.jobs.halt(mine);await finish(again,'cancelled');
    assert.equal((await tick(mine)).state,'cancelled');assert.equal((await latest(mine)).ended,'stopped');

    // A run that failed before its first model call (no box, a busy profile) left Hermes nothing: its relaunch is a first run.
    const unreached=await approved('Unreached check');await finish(await claim(unreached),'failed');
    assert.equal((await tick(unreached)).state,'waiting');
    const fresh=await claim(unreached);
    assert.match(fresh.text,/^\[Background job: Unreached check\]\nYou are running a background job[^]*made-up task list/);
    assert.doesNotMatch(fresh.text,/interrupted|restarted/);
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});

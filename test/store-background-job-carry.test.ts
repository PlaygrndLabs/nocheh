import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import type {IncomingMessage} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {canonical,digest,type Envelope} from '../src/archive.js';
import {reader,type Reader} from '../src/access.js';
import type {Interpretation} from '../src/interpretations.js';
import {brokerServer} from '../src/security/broker.js';
import {foregroundReplyActive} from '../src/stores/automatic-publication.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageGuardService} from '../src/stores/guard-service.js';
import {afterEpoch,afterPending} from '../src/stores/guards.js';
import {HttpError} from '../src/http.js';
import {assertGuardConfiguration} from '../src/stores/lifecycle.js';
import {OwnerCommands} from '../src/stores/owner-commands.js';
import {storageServer} from '../src/stores/server.js';
import {storageServices} from '../src/stores/services.js';
import type {Settings} from '../src/config.js';

test('a running job run carries across reaction and learning epochs, any other change still ends it, and a relaunch keeps a binding that carries',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-job-carry-')),key='job-carry:'+Date.now(),group='-100555',other='-100777';
  const owner:Reader={admin:true,scope:null},token=digest(key);
  const policy=()=>({enabled:true,owner_id:'123',group_ids:[group,other],group_access:{[group]:{granted:['9'],denied:[]}},topic_memory:'group' as const});
  // The runs Hermes is running: claimed and not yet finished.
  const native=new Set<string>();
  /** Work that runs once, inside the next secret check, as if it committed while a request was being checked. */
  let during:(()=>Promise<unknown>)|null=null;
  /** Made-up secrets the secret check finds wherever it sees them. */
  const flagged:string[]=[];
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect'){const work=during;during=null;if(work)await work();return {literals:flagged.filter(literal=>String(input.text).includes(literal))};}
      if(operation==='usage.price')return {rates:{input:2,output:10,cache_read:0.2,cache_write:2.5}};
      if(operation==='run.resume')return {state:native.has(String(input.event_id))?'running':'not_found'};
      if(operation==='run.start'||operation==='run.cancel')return {state:'queued'};
      assert.equal(operation,'telegram.approval');return {state:'done',chat_id:input.chat_id,message_id:'5'};
    },honcho:async()=>{throw Error('no memory provider');}});
  let updates=0,sent=100,reactions=0,noted=0,learned=0,revision=0;
  const capture=async(chat:string,payload:Record<string,any>)=>{
    const update=++updates,event:Envelope={version:1,key:key+':'+update,origin:'live',kind:'telegram_update',bot_id:key,scope:chat,
      source_id:String(payload.message?.message_id??payload.message_reaction?.message_id),revision:String(update),occurred_at:null,text:payload.message?.text??null,payload:{update_id:update,...payload}};
    return (await s.capture.capture(event)).source.reference;
  };
  const message=async(chat:string,text:string,from=9)=>{
    const source=await capture(chat,{message:{message_id:++sent,date:1700000000+sent,chat:{id:Number(chat),type:'supergroup'},from:{id:from,first_name:'Person'},text}});
    await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const epoch=async()=>(await s.guards.state()).epoch;
  /** A reaction change in the other group, which starts a quiet epoch unless a reply, browser or scheduled run holds it. */
  const react=async()=>{
    const emoji=++reactions%2?'👍':'❤️';
    await capture(other,{message_reaction:{chat:{id:Number(other),type:'supergroup'},message_id:noted,date:1700000500+reactions,user:{id:7},
      old_reaction:reactions===1?[]:[{type:'emoji',emoji:emoji==='👍'?'❤️':'👍'}],new_reaction:[{type:'emoji',emoji}]}});
  };
  const quiet=async()=>{const before=await epoch();await react();assert.equal(await epoch(),before+1,'the reaction publishes at once');};
  const actor=async(source:string,scope:string|null,space:string):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope,space,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const authority=async()=>({owner:'inngest' as const,epoch:Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='background'")).rows[0].epoch)});
  const tick=async(id:string)=>s.jobs.operation('job:'+id,await authority());
  const job=async(id:string)=>(await stores.control.query('SELECT * FROM background_jobs WHERE id=$1',[id])).rows[0];
  const latest=async(id:string)=>(await stores.control.query(`SELECT b.*,r.state AS run_state,r.cancel_requested AS run_cancel,r.binding AS run_binding FROM background_runs b
    JOIN managed_runs r ON r.event_id=b.event_id WHERE b.job_id=$1 ORDER BY b.attempt DESC LIMIT 1`,[id])).rows[0];
  const reports=async(id:string)=>(await stores.control.query('SELECT a.* FROM background_reports b JOIN telegram_action_requests a ON a.id=b.action_id WHERE b.job_id=$1 ORDER BY b.part',[id])).rows;
  /** A member's job in the group, approved and with its first run recorded. */
  const approved=async(title:string)=>{
    const proposed=await s.jobs.start(await actor((await message(group,'Please check the made-up task list')).id,group,group),
      {title,instruction:'Compare the made-up task list with the group chat.',chat:group});
    await s.jobs.decide('9',{id:proposed.id,fingerprint:proposed.fingerprint,decision:'approve'},await message(group,'Approve it'));
    await tick(proposed.id);return proposed.id;
  };
  /** What Hermes does with a job's latest run: read its context and claim it; and the physical profile the launcher gets for its credential. */
  const claim=async(id:string)=>{
    const event=(await latest(id)).event_id as string;
    await s.jobs.runs.run(event,await authority());
    const context:any=await s.jobs.runs.context({event_id:event,owner_epoch:(await authority()).epoch});
    const claimed:any=await s.jobs.runs.claim({...context,actor:context.actor});await s.jobs.runs.prepare({...context,actor:context.actor});native.add(event);
    const principal=reader({headers:{authorization:'Bearer '+claimed.archive_credential}} as IncomingMessage,token);
    return {event,context,claimed,principal,text:String(claimed.text),profile:(await s.turns.binding(principal)).profile};
  };
  const beat=(run:{context:any},progress?:unknown)=>s.jobs.runs.heartbeat({...run.context,actor:run.context.actor,...(progress===undefined?{}:{progress})});
  const finish=(run:{event:string;context:any},state:string,extra:Record<string,unknown>={})=>(native.delete(run.event),s.jobs.runs.finish({event_id:run.event,actor:run.context.actor,state,
    session:run.context.conversation,error_code:state==='failed'?'model_unavailable':null,text:'',...extra}));
  const counts=(input_tokens:number)=>({tokens:{input_tokens,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,calls:1},unknown_calls:0});
  const deliver=async(id:string)=>{
    for(let round=0;round<5;round++) {
      await stores.control.query("UPDATE telegram_action_requests SET state='done' WHERE id IN (SELECT action_id FROM background_reports WHERE job_id=$1)",[id]);
      const seen=await tick(id);if(seen.state!=='waiting')return seen;
    }
    throw Error('the job did not end');
  };
  const resumed=(title:string)=>`[Background job: ${title}] The job was interrupted and restarted. Your to-do list and the work so far are above; the last tool call may not have finished. Continue, and write the final report as your answer when done.`;
  const previousRoute=process.env.NOCHEH_REPLY_ROUTE_URL;process.env.NOCHEH_REPLY_ROUTE_URL='https://gateway.example.test/v1';
  const broker=brokerServer({pool:stores.control,storage:s.turns,token,archive:'http://archive',hermes:'http://hermes',model:'fixture-model',prepare:storageGuardService(s),
    assertReady:async()=>{await assertGuardConfiguration(s.guards,'on');await s.configuration.assert(policy());},
    fetch:async url=>String(url).endsWith('/internal/security/transport')?Response.json({base_url:'https://gateway.example.test/v1',api_mode:'chat_completions',
      api_key:'synthetic-credential',model_context_length:100000}):Response.json({ok:true})});
  await new Promise<void>(resolve=>broker.listen(0,'127.0.0.1',resolve));
  const base=()=>'http://127.0.0.1:'+(broker.address() as {port:number}).port;
  const app=storageServer(s,{token,dataDir:root,guardMode:'on',assistant:policy()} as unknown as Settings,async()=>({}));
  await new Promise<void>(resolve=>app.listen(0,'127.0.0.1',resolve));
  /** A turn's delivery check through the app server, as check_delivery_policy sends it. */
  const delivery=async(credential:string)=>{
    const response=await fetch('http://127.0.0.1:'+(app.address() as {port:number}).port+'/v1/memory/check',{headers:{authorization:'Bearer '+credential}});
    return [response.status,await response.json()];
  };
  /** One model request of a run through the broker. */
  const model=async(run:{claimed:any},content='Made-up words to read.')=>{
    const response=await fetch(base()+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+run.claimed.archive_credential,'content-type':'application/json'},
      body:JSON.stringify({model:'fixture-model',input:[{role:'user',content}]})});
    return [response.status,await response.json()];
  };
  /** The binding the launcher reads for a run's credential. */
  const launcher=async(run:{claimed:any})=>(await fetch(base()+'/v1/security/binding',{headers:{authorization:'Bearer '+run.claimed.archive_credential}})).json() as Promise<any>;
  /** A held change asks this inside its own transaction: knowledge changes and memory grants as it is, reactions and learning `quiet`. */
  const active=async(quietChange:boolean)=>{
    const db=await stores.control.connect();
    try{await db.query('BEGIN');try{return await foregroundReplyActive(db,await s.guards.state(),quietChange);}finally{await db.query('ROLLBACK');}}finally{db.release();}
  };
  const commands=new OwnerCommands(stores.control);
  /** A deferred owner command: it carries the binding it was asked under. */
  const deferred=async(label:string)=>{
    const current=await s.guards.state();
    return commands.run({admin:true,scope:null,generation:current.generation,guard_epoch:current.epoch},key+':'+label,{kind:'fixture',label},async()=>({label}));
  };
  try {
    await s.guards.reconcile();await s.guards.setMode('on');await s.configuration.configure(policy(),'on');
    await s.jobs.saveSettings(owner,{cost_limit_usd:5,minutes_limit:45,member_daily_jobs:20,revision:(await s.jobs.settings()).revision});
    const note=await message(other,'A made-up note in the other group');noted=sent;
    /** What the learning engine does with one learned entry: stage a version under the current binding, then publish it. A
     *  revision of the entry starts a quiet epoch; its publication stays pending until it is finished. */
    const learn=async(finished=true)=>{
      const binding=await s.guards.state(),prepared=await s.guards.read('events:'+note.id,binding),id=key+':learning-'+(++learned),entry=digest(key+':entry');
      const dependencies=[{source_id:'events:'+note.id,revision:prepared.revision,value_hash:digest(canonical(prepared.value))}];
      await stores.control.query(`INSERT INTO interpretation_jobs(id,source_reference,workspace,audience,input_reference,binding,context_hash,state)
        VALUES($1,$2,'fixture','fixture',$2,$3,$4,'running')`,[id,note,binding,digest(id)]);
      const value:Interpretation={kind:'meaning',subject:'blue mark',text:'A blue mark means made-up step '+learned+' is done.',scope:{kind:'conversation',id:other},
        uncertainty:'supported',evidence:[note],conflicts:[]};
      const version=await s.learned.stageAutomatic(entry,value,revision||null,id+':0',dependencies,binding,'fixture',s.detect);revision=version.revision;
      await s.learned.activateBatch([version],binding,id,digest(id+':result'),[entry]);
      if(finished)await s.learned.finish(version.operation_id);return version;
    };
    await learn();

    // A running run goes on across a reaction epoch and an automatic learning epoch, which both publish while it runs: the
    // broker, the heartbeat, the delivery check, the supervisor and the receipt still take it, and its report is sent.
    const carried=await approved('Carry check'),run=await claim(carried),asked=await s.guards.state();
    assert.deepEqual(await model(run),[200,{ok:true}]);
    await quiet();
    await learn();
    const now=await s.guards.state();
    assert.equal(now.epoch,asked.epoch+2,'the reaction and the learning revision published while the run ran');
    assert.deepEqual((await stores.control.query('SELECT reason FROM guard_quiet_epochs WHERE generation=$1 AND epoch>$2 ORDER BY epoch',[asked.generation,asked.epoch])).rows,
      [{reason:'reaction'},{reason:'learning'}]);
    assert.deepEqual(await model(run),[200,{ok:true}],'its model requests pass');
    const bound=await launcher(run);
    assert.deepEqual([bound.profile,bound.guard_epoch],[run.profile,asked.epoch],'it keeps its binding and physical profile, the one Hermes derives from its credential');
    assert.deepEqual(await beat(run,counts(1000)),{event_id:run.event,state:'running',cancel_requested:false},'its heartbeat keeps it running');
    assert.equal(await s.jobs.runs.deliveryAllowed(run.principal),true);
    await s.jobs.runs.run(run.event,await authority());
    assert.deepEqual([(await latest(carried)).run_state,(await latest(carried)).run_cancel],['running',false],'the supervisor leaves it running');
    // What it reads now is checked under the current epoch, in that epoch's prepared values.
    await s.prepared.prepare(run.principal,{text:'A made-up value read after the reaction'},s.detect);
    assert.deepEqual((await stores.derived.query("SELECT epoch FROM runtime_prepared_values WHERE content=convert_to('A made-up value read after the reaction','UTF8')")).rows
      .map(row=>Number(row.epoch)),[now.epoch]);
    // A change it asks for is bound to its own binding, which carries, under its own profile, so it reads the change back.
    const change=await s.controlledActions.propose(run.principal,{kind:'shell',arguments:{command:'printf made-up-check'}});
    const saved=(await stores.control.query('SELECT binding,profile FROM controlled_actions WHERE id=$1',[change.id])).rows[0];
    assert.deepEqual([saved.binding.epoch,saved.profile],[asked.epoch,run.profile]);
    assert.equal((await s.controlledActions.inspect(run.principal,change.id) as any).arguments.command,'printf made-up-check');
    assert.deepEqual((await s.controlledActions.recent(run.principal)).map(item=>item.id),[change.id]);
    // Changes that are not quiet still wait for it, though its binding is older than the current one.
    assert.deepEqual([await active(false),await active(true)],[true,false],'knowledge changes and memory grants wait; reactions and learning do not');
    await assert.rejects(deferred('held'),{code:'foreground_reply_active'},'a deferred owner command with a binding waits');
    assert.equal(await epoch(),now.epoch);
    await finish(run,'done',{text:'Report: made-up task 12 is still open.',...counts(2000)});
    assert.equal((await latest(carried)).run_state,'done','its receipt counts');
    await assert.rejects(s.prepared.audience.assert(run.principal),{code:'audience_context_changed'},'a run that ended carries no more');
    assert.equal((await tick(carried)).stage,'delivery');
    assert.equal((await deliver(carried)).state,'completed');
    assert.deepEqual([(await job(carried)).state,(await job(carried)).attempts,(await reports(carried)).length],['done',1,1]);
    assert.equal(await active(false),false);
    await deferred('after');assert.equal(await epoch(),now.epoch+1,'once it ended, the command runs');

    // A learning publication is pending for a moment: a run's checks wait it out and check again in full, while anything
    // else is refused at once; the heartbeat's refusal is tolerated in the turn, and the supervisor leaves the run alone.
    const waited=await approved('Pending check'),pending=await claim(waited);
    const reply=await s.prepared.audience.turn(token,{scope:group,space:group,purpose:'assistant'},(await message(group,'A made-up question in the group')).id,Date.now()+600000);
    const publication=await learn(false);
    await assert.rejects(afterPending(false,()=>s.guards.state()),{code:'guard_transition_pending'});
    await assert.rejects(beat(pending),{code:'guard_transition_pending'});
    await s.jobs.runs.run(pending.event,await authority());
    assert.deepEqual([(await latest(waited)).run_state,(await latest(waited)).run_cancel],['running',false]);
    const released=new Promise<void>((resolve,reject)=>setTimeout(()=>s.learned.finish(publication.operation_id).then(resolve,reject),500));
    const [allowed,requested,state,checked,refused]=await Promise.all([s.jobs.runs.deliveryAllowed(pending.principal),model(pending),afterPending(true,()=>s.guards.state()),
      delivery(pending.claimed.archive_credential),delivery(reply)]);
    await released;
    assert.deepEqual([allowed,requested,state.epoch],[true,[200,{ok:true}],await epoch()]);
    assert.deepEqual(checked,[200,{valid:true}],'its delivery check through the app server waits too');
    assert.deepEqual(refused,[409,{error:'guard_transition_pending'}],'a reply\'s is refused at once');
    await finish(pending,'done',{text:'Report: made-up task 13 is done.',...counts(1000)});
    assert.equal((await tick(waited)).stage,'delivery');await deliver(waited);
    assert.deepEqual([(await job(waited)).state,(await job(waited)).attempts],['done',1]);

    // An epoch it carries across that commits while one of its requests is being checked, here inside the secret check, makes
    // the request run again in full under the new epoch, so it passes; anyone else's request is refused, as before.
    let calls=0;const changed=()=>{calls++;throw new HttpError(409,'guard_context_changed');};
    await assert.rejects(afterEpoch(false,async()=>changed()),{code:'guard_context_changed'});assert.equal(calls,1,'anyone else is not asked again');
    await assert.rejects(afterEpoch(true,async()=>changed()),{code:'guard_context_changed'});assert.equal(calls,4,'a job run is asked at most 3 times');
    const busy=await approved('Busy check'),racing=await claim(busy),raced=await epoch();
    during=react;
    assert.deepEqual(await model(racing,'Made-up words first read while a reaction publishes.'),[200,{ok:true}],'a reaction during its model request');
    assert.deepEqual([during,await epoch()],[null,raced+1]);
    during=()=>learn();
    const racedChange=await s.controlledActions.propose(racing.principal,{kind:'shell',arguments:{command:'printf made-up-race'}});
    assert.deepEqual([during,await epoch()],[null,raced+2],'a learning revision during a change it asks for');
    assert.equal(Number((await stores.control.query('SELECT binding FROM controlled_actions WHERE id=$1',[racedChange.id])).rows[0].binding.epoch),raced);
    assert.equal((await s.controlledActions.inspect(racing.principal,racedChange.id) as any).arguments.command,'printf made-up-race');
    // So does a page of its chat that a reaction interrupts after its first guarded read.
    const read=s.guards.read;let interrupted=false;
    s.guards.read=async function(this:typeof s.guards,...args:Parameters<typeof read>){if(!interrupted&&args[0].startsWith('events:')){interrupted=true;await react();}return read.apply(this,args);};
    try {
      const page=await s.sources.page(racing.principal,{chat:group,from:'',to:'',after:'',count:30});
      assert.deepEqual([interrupted,await epoch()],[true,raced+3]);
      assert.ok(page.items.some(item=>JSON.stringify(item).includes('made-up question in the group')),'the page reads whole');
    }finally{s.guards.read=read;}
    // A request whose check runs longer than the wait, here a slow secret check, still waits out a learning publication that
    // is pending when the check ends: the wait counts from that refusal, and the check then runs again in full.
    let slow:Awaited<ReturnType<typeof learn>>|undefined,slowDone:Promise<void>|undefined;
    during=async()=>{
      await new Promise(resolve=>setTimeout(resolve,4300));slow=await learn(false);
      slowDone=new Promise<void>((resolve,reject)=>setTimeout(()=>s.learned.finish(slow!.operation_id).then(resolve,reject),500));
    };
    assert.deepEqual(await model(racing,'Made-up words first read by a slow secret check.'),[200,{ok:true}],'a slow request meets a pending learning publication');
    await slowDone;
    assert.deepEqual([during,await epoch()],[null,raced+4]);
    // A change whose arguments hold a value prepared only in its first epoch, where an epoch commits before the change is
    // published: it runs again under the new epoch, where that value is checked again, and its own copy is published.
    const secret='made-up-key-4471';
    await s.prepared.allow(racing.principal,{text:secret});flagged.push(secret);
    const begin=s.guards.beginPublication;let begun=false;
    s.guards.beginPublication=async function(this:typeof s.guards,...args:Parameters<typeof begin>){if(!begun&&args[1]){begun=true;await react();}return begin.apply(this,args);};
    try {
      const rechecked=await s.controlledActions.propose(racing.principal,{kind:'shell',arguments:{command:'printf '+secret}});
      assert.deepEqual([begun,await epoch()],[true,raced+5]);
      assert.equal((await s.controlledActions.inspect(racing.principal,rechecked.id) as any).arguments.command,'printf ***','checked again in the new epoch');
    }finally{s.guards.beginPublication=begin;}
    await finish(racing,'done',{text:'Report: made-up task 16 is done.',...counts(1000)});
    assert.equal((await tick(busy)).stage,'delivery');await deliver(busy);
    assert.deepEqual([(await job(busy)).state,(await job(busy)).attempts],['done',1]);

    // A learning publication pending while a report part is checked leaves the part to the job's next tick, which checks it
    // again in the new epoch and sends it once; the job's workflow does not close while the job still reports.
    const reporting=await approved('Report check'),writer=await claim(reporting);
    await finish(writer,'done',{text:'Report: made-up task 17 is done.',...counts(1000)});
    let partLearned:Awaited<ReturnType<typeof learn>>|undefined,partDone:Promise<void>|undefined;
    during=async()=>{
      partLearned=await learn(false);
      partDone=new Promise<void>((resolve,reject)=>setTimeout(()=>s.learned.finish(partLearned!.operation_id).then(resolve,reject),500));
    };
    const paused=await tick(reporting);await partDone;
    assert.deepEqual([during,paused.state,paused.stage,paused.waiting_reason,(await reports(reporting)).length],[null,'waiting','delivery','guard_pending',0]);
    assert.equal((await deliver(reporting)).state,'completed');
    assert.deepEqual([(await job(reporting)).state,(await reports(reporting)).length],['done',1]);

    // Any other change after its binding ends a run at its next check, here a hidden message after a reaction; the relaunch
    // is bound to the current epoch: a new profile, the first message again and the restart text, without the to-do list.
    const hidden=await message(other,'A made-up message to hide');
    const ended=await approved('Hide check'),first=await claim(ended);
    await beat(first,{...counts(1000),todo:[{content:'Check the made-up invoice',status:'pending'}]});
    await quiet();
    assert.deepEqual(await model(first),[200,{ok:true}]);
    // The hide commits while its request is being checked: the request checks again and is refused, and so is the next one.
    during=()=>s.retirements.set(owner,hidden.id,{retired:true,expected_revision:0,operation_id:key+':hide'});
    assert.deepEqual(await model(first,'Made-up words first read while a message is hidden.'),[409,{error:'audience_context_changed'}],'the broker refuses the request');
    assert.equal(during,null);
    assert.deepEqual(await model(first),[409,{error:'audience_context_changed'}],'the broker refuses its next request');
    await assert.rejects(beat(first),{code:'guard_context_changed'},'its heartbeat stops it');
    assert.equal(await s.jobs.runs.deliveryAllowed(first.principal),false);
    await s.jobs.runs.run(first.event,await authority());
    assert.equal((await latest(ended)).run_cancel,true,'the supervisor cancels it');
    assert.equal(await active(false),false,'nothing waits for it');
    await finish(first,'cancelled');
    assert.equal((await tick(ended)).state,'waiting');
    const second=await claim(ended),hiddenAt=await s.guards.state();
    assert.match(second.text,/^\[Background job: Hide check\]\nYou are running a background job[^]*\n\nThis job restarted and its earlier work could not be kept\.$/);
    assert.notEqual(second.profile,first.profile,'a new physical profile, so Hermes has none of its history');
    assert.equal(second.context.revision,hiddenAt.epoch);
    await finish(second,'done',{text:'Report: made-up task 14 is done.',...counts(1000)});
    assert.equal((await tick(ended)).stage,'delivery');await deliver(ended);assert.equal((await job(ended)).state,'done');

    // A relaunch after only quiet epochs keeps the run's binding: the same physical profile, so Hermes reloads its history,
    // and the resume line. Its credential and runtime turn hold that binding.
    const kept=await approved('Keep check'),one=await claim(kept);
    await beat(one,counts(1000));await finish(one,'failed');
    await quiet();await learn();
    assert.equal((await tick(kept)).state,'waiting');
    const two=await claim(kept);
    assert.equal(two.text,resumed('Keep check'));
    assert.equal(two.profile,one.profile,'the same physical profile');
    assert.deepEqual([two.context.revision,two.principal.guard_epoch,(await latest(kept)).run_binding.epoch],[one.context.revision,one.context.revision,one.context.revision]);
    assert.equal(Number((await stores.control.query('SELECT guard_epoch FROM runtime_turns WHERE id=$1',[two.event])).rows[0].guard_epoch),one.context.revision);
    assert.deepEqual(await model(two),[200,{ok:true}]);
    await finish(two,'done',{text:'Report: made-up task 15 is done.',...counts(1000)});
    assert.equal((await tick(kept)).stage,'delivery');await deliver(kept);
    assert.deepEqual([(await job(kept)).state,(await job(kept)).attempts,(await reports(kept)).length],['done',2,1]);

    // A reply, a browser run and a scheduled run still hold a reaction until they end, and a credential from before a
    // quiet epoch is refused to everything but a job's live run.
    const asking=await message(group,'A made-up question for a reply'),before=await s.guards.state();
    await stores.control.query("INSERT INTO dispatches(event_id,source_reference,binding,state) VALUES($1,$2,$3,'running')",[asking.id,asking,before]);
    await react();assert.equal(await epoch(),before.epoch,'a reaction waits for a running reply');
    await stores.control.query("UPDATE dispatches SET state='done' WHERE event_id=$1",[asking.id]);
    for(const channel of ['browser','scheduler']) {
      const id=digest(key+':'+channel),current=await s.guards.state();
      await stores.control.query(`INSERT INTO managed_runs(event_id,channel,source_reference,scope,space_id,logical_profile,conversation_id,binding,state,lease_until)
        VALUES($1,$2,$3,$4,$4,'fixture-profile',$5,$6,'running',now()+interval '60 seconds')`,[id,channel,asking,group,'conversation_'+channel,current]);
      await react();assert.equal(await epoch(),current.epoch,'a reaction waits for a running '+channel+' run');
      await stores.control.query("UPDATE managed_runs SET state='done',lease_until=NULL WHERE event_id=$1",[id]);
    }
    await quiet();
    await assert.rejects(s.prepared.audience.assert({admin:false,scope:group,space:group,turnEvent:asking.id,generation:before.generation,guard_epoch:before.epoch,revision:before.epoch}),
      {code:'audience_context_changed'},'a reply\'s credential');
    await assert.rejects(s.prepared.audience.assert(two.principal),{code:'audience_context_changed'},'nor a job run\'s once it ended');
  } finally {
    if(previousRoute===undefined)delete process.env.NOCHEH_REPLY_ROUTE_URL;else process.env.NOCHEH_REPLY_ROUTE_URL=previousRoute;
    broker.closeAllConnections();await new Promise<void>(resolve=>broker.close(()=>resolve()));
    app.closeAllConnections();await new Promise<void>(resolve=>app.close(()=>resolve()));
    await stores.close();await rm(root,{recursive:true,force:true});
  }
});

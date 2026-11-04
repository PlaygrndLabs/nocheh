import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {byteBudget,jobDeadlines,jobTokens,reportParts} from '../src/stores/background-jobs.js';
import {brokerServer} from '../src/security/broker.js';
import {storageGuardService} from '../src/stores/guard-service.js';

test('a background job is started with one call, approved on its card, runs as one run in its own session and reports to its chat',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:240000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-background-jobs-')),key='background-jobs:'+Date.now(),group='-'+Date.now(),other='-1'+Date.now();
  // The reply model's rates in USD per million tokens, as the runtime prices it; null where it has no price.
  const sonnet={input:2,output:10,cache_read:0.2,cache_write:2.5,request:0};
  const cards:Record<string,any>[]=[],runs:string[]=[];let rates:Record<string,number|null>=sonnet,updates=0;
  const policy=()=>({enabled:true,owner_id:'123',group_ids:[group,other],group_access:{[group]:{granted:['9','8'],denied:[]},[other]:{granted:['9'],denied:[]}},topic_memory:'group' as const});
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='usage.price'){assert.deepEqual(input,{rates:'reply'});return {rates};}
      if(operation==='run.resume')return {state:'not_found'};
      if(operation==='run.start'||operation==='run.cancel'){runs.push(operation+':'+input.event_id);return {state:'queued'};}
      assert.equal(operation,'telegram.approval');cards.push(input);
      return input.kind==='card'?{state:'done',chat_id:input.chat_id,message_id:'5'}:{state:'done'};
    },honcho:async()=>{throw Error('no memory provider');}});
  const bot=String(Date.now()).slice(-9);
  const capture=async(label:string,payload:Record<string,unknown>,scope=group)=>{
    const event:Envelope={version:1,key:payload.update_id?`telegram:${bot}:update:${payload.update_id}`:key+':'+label,origin:'live',kind:'telegram_update',bot_id:payload.update_id?bot:key,scope,source_id:payload.update_id?String(payload.update_id):label,revision:'1',occurred_at:null,text:String((payload.message as any)?.text??''),payload};
    const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  let sent=100;
  const message=(label:string,from=9,text='Please find what is still open')=>capture(label,{message:{message_id:++sent,date:1700000000,
    chat:{id:Number(group),type:'supergroup'},from:{id:from,first_name:'Member'},text}});
  const press=(label:string,data:string,from:number)=>capture(label,{update_id:++updates,callback_query:{id:'query-'+label,from:{id:from},chat_instance:'1',data,
    message:{message_id:5,date:1700000000,chat:{id:Number(group),type:'supergroup'}}}});
  const actor=async(source:string,scope:string|null=group,space=scope??'123'):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope,space,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const privately=(label:string,text:string)=>capture(label,{message:{message_id:++sent,date:1700000000,chat:{id:123,type:'private'},from:{id:123},text}},'123');
  const last=(kind:string)=>cards.filter(card=>card.kind===kind).at(-1)!;
  const authority=async()=>({owner:'inngest' as const,epoch:Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='background'")).rows[0].epoch)});
  const job=async(id:string)=>(await stores.control.query('SELECT * FROM background_jobs WHERE id=$1',[id])).rows[0];
  const step=async(id:string)=>(await stores.control.query('SELECT b.*,r.state AS run FROM background_runs b JOIN managed_runs r ON r.event_id=b.event_id WHERE b.job_id=$1 ORDER BY b.attempt DESC LIMIT 1',[id])).rows[0];
  /** What Hermes does with a run: read its context and claim it. */
  const claimRun=async(id:string)=>{
    const current=await step(id),epoch=(await authority()).epoch;
    await s.jobs.runs.run(current.event_id,await authority());
    const context:any=await s.jobs.runs.context({event_id:current.event_id,owner_epoch:epoch});
    const claim:any=await s.jobs.runs.claim({...context,actor:context.actor});
    await s.jobs.runs.prepare({...context,actor:context.actor});
    return {event_id:current.event_id as string,context,claim};
  };
  /** ...then report what the run left. */
  const runStep=async(id:string,result:Record<string,unknown>,state='done')=>{
    const run=await claimRun(id);
    await s.jobs.runs.finish({event_id:run.event_id,actor:run.context.actor,state,session:run.context.conversation,error_code:null,...result});
    return run;
  };
  const beat=(run:{context:any},progress?:unknown)=>s.jobs.runs.heartbeat({...run.context,actor:run.context.actor,...(progress===undefined?{}:{progress})});
  const counts=(input_tokens:number,calls=1,output_tokens=0)=>({input_tokens,output_tokens,cache_read_tokens:0,cache_write_tokens:0,calls});
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    for(let index=0;index<5;index++)await message('history-'+index,8,'Earlier message '+index);
    const ask=await message('ask');
    await assert.rejects(s.jobs.start(await actor(ask.id),{title:'Elsewhere',instruction:'Read it.',chat:'123'}),{status:403},'a member reads only their own group');
    // A member starts a job with one call: Nocheh counts and prices it, and the card answers the request in the group, for that person or the owner.
    const proposed=await s.jobs.start(await actor(ask.id),{title:'Open tasks',instruction:'Find every task that is still open and who owns it.'});
    assert.equal(proposed.state,'proposed');assert.equal(proposed.approver,'requester');assert.equal(proposed.message,'Nothing runs until it is approved.');
    const estimate=proposed.estimate as any,read=jobTokens(estimate),priced=Math.round((read.input*2+read.output*10)/1e6*100)/100;
    assert.equal(estimate.chat,group);assert.equal(estimate.messages,6);assert.ok(estimate.minutes>=2);
    // The rates are frozen on the card, and the estimate is priced at them.
    assert.deepEqual(estimate.rates,sonnet);assert.equal(estimate.cost_usd,priced);assert.ok(priced>0);
    assert.deepEqual(proposed.limits,{cost_usd:5,minutes:45});
    const frozen=await job(proposed.id);assert.deepEqual(frozen.rates,sonnet);
    assert.equal(Number(frozen.byte_budget),Math.floor(5/(0.2/1e6)*12),'the cost limit at the cheapest prompt rate, 12 bytes a token');
    assert.equal(Number(frozen.model_bytes),0);
    // Rates and the byte budget are in the fingerprint: the same request at another price is a changed job.
    rates={...sonnet,cache_read:0.1};
    await assert.rejects(s.jobs.start(await actor(ask.id),{title:'Open tasks',instruction:'Find every task that is still open and who owns it.'}),{status:409,code:'job_changed'});
    const offered=await s.actionCommands.offer('background',proposed);
    assert.match(offered.message,/posted here as the reply to the request/);
    const card=last('card');
    assert.equal(card.chat_id,group);assert.equal(card.reply_to,String(sent));
    assert.match(card.text,/Background job: Open tasks/);assert.match(card.text,/6 messages/);assert.ok(card.text.includes('about $'+priced.toFixed(2)),card.text);
    assert.match(card.text,/🛑 Stops at \$5\.0 or 45 min, not counting the secret check\n/);assert.doesNotMatch(card.text,/can't be measured/);
    assert.match(card.text,/Find every task that is still open and who owns it\./);
    assert.match(card.text,/🔎 Starting it already used one secret check\. It counts toward the daily limit of the person who asked, unless it is rejected\./);
    const approve='na'+proposed.id.slice(0,40)+proposed.fingerprint.slice(0,16);
    assert.deepEqual(card.buttons,[['✅ Approve',approve],['❌ Reject','nd'+proposed.id.slice(0,40)+proposed.fingerprint.slice(0,16)]]);
    await s.actionCommands.callback(await press('other',approve,8));
    assert.equal(last('answer').text,'Only the person who asked or the owner can approve or reject this.');
    assert.equal((await job(proposed.id)).state,'proposed','another member decides nothing');
    await s.actionCommands.callback(await press('requester',approve,9));
    assert.equal((await job(proposed.id)).state,'approved');
    assert.match(last('settle').text,/⏳ Approved\. It runs now and reports here when done\./,'a free slot starts the job right away');
    const stop='ns'+proposed.id.slice(0,40)+proposed.fingerprint.slice(0,16);
    assert.deepEqual(last('settle').buttons,[['🛑 Stop',stop]],'a running job\'s card has one Stop button');
    assert.ok((await stores.control.query("SELECT 1 FROM workflow_registry WHERE family='background' AND job_id=$1",['job:'+proposed.id])).rowCount);
    // The job is one managed run of its own profile, so the group's replies never wait for it.
    assert.equal((await s.jobs.operation('job:'+proposed.id,await authority())).state,'waiting');
    const first=await step(proposed.id);
    assert.deepEqual([first.attempt,first.run],[1,'captured']);
    const started=await job(proposed.id);assert.deepEqual([started.state,started.attempts],['running',1]);assert.ok(started.started_at);
    // The run reports its tokens, which Nocheh prices at the job's frozen rates: $0.20 + $0.10 + $0.10 + $0.10.
    const one=await runStep(proposed.id,{text:'Report: 2 tasks are open.',todo:[{content:'Check who owns the invoice',status:'pending'}],
      tokens:{input_tokens:100000,output_tokens:10000,cache_read_tokens:500000,cache_write_tokens:40000,calls:3},unknown_calls:0});
    assert.ok(runs.includes('run.start:'+first.event_id));
    assert.equal(one.context.profile,'job-'+proposed.id.slice(0,24));assert.equal(one.context.background.max_iterations,300);
    assert.match(String(one.claim.text),/Find every task that is still open and who owns it\./,'the run carries the instruction');
    assert.match(String(one.claim.text),/Take as many steps as you need\. You get a notice when time or cost is nearly used up: then write the report\./);
    assert.doesNotMatch(String(one.claim.text),/new step/);
    const claims=JSON.parse(Buffer.from(String(one.claim.archive_credential).split('.')[1]!,'base64url').toString());
    assert.equal(claims.logical_profile,'job-'+proposed.id.slice(0,24));
    assert.ok(Math.abs(claims.expires-jobDeadlines(started).credential)<1000,'the credential lasts until 2 minutes after the hard deadline');
    assert.equal((await s.jobs.operation('job:'+proposed.id,await authority())).stage,'delivery');
    const reported=await job(proposed.id);
    assert.deepEqual([reported.state,reported.attempts,Number(reported.cost_usd),reported.todo],['reporting',1,0.5,[{content:'Check who owns the invoice',status:'pending'}]]);
    const kept=(await stores.control.query('SELECT tokens,cost_usd FROM background_runs WHERE event_id=$1',[first.event_id])).rows[0];
    assert.deepEqual([kept.tokens,Number(kept.cost_usd)],[{input_tokens:100000,output_tokens:10000,cache_read_tokens:500000,cache_write_tokens:40000,calls:3},0.5]);
    // The answer that ends on its own is the report, sent to the group by the job's approval.
    const action=(await stores.control.query('SELECT a.* FROM background_reports b JOIN telegram_action_requests a ON a.id=b.action_id WHERE b.job_id=$1',[proposed.id])).rows[0];
    assert.deepEqual([action.destination,action.state],[group,'approved']);
    assert.equal((await s.jobs.operation('job:'+proposed.id,await authority())).state,'waiting','the report waits for Telegram');
    await stores.control.query("UPDATE telegram_action_requests SET state='done' WHERE id=$1",[action.id]);
    assert.equal((await s.jobs.operation('job:'+proposed.id,await authority())).state,'completed');
    assert.equal((await job(proposed.id)).state,'done');
    assert.match(last('settle').text,/✅ Done\. The report is in the chat\./,'the card shows the job ended');
    assert.equal(last('settle').buttons,undefined,'and loses its Stop button');
    const listed=(await s.jobs.list(await actor(ask.id))).jobs.find(item=>item.id===proposed.id)!;
    assert.deepEqual([listed.title,listed.state,listed.attempts,listed.ended],['Open tasks','done',1,null]);
    await s.actionCommands.callback(await press('stop-done',stop,123));
    assert.equal(last('answer').text,'This job has already ended.');
    // A job at its cost limit is stopped by its heartbeat, and a short note of its to-do list goes out instead of a report.
    const capped=await s.jobs.start(await actor((await message('capped')).id),{title:'Long read',instruction:'Read everything.'});
    await s.jobs.decide('9',{id:capped.id,fingerprint:capped.fingerprint,decision:'approve'},(await message('approve-capped')));
    await s.jobs.operation('job:'+capped.id,await authority());
    const reading=await claimRun(capped.id);
    assert.deepEqual(await beat(reading,{tokens:counts(1000000),unknown_calls:0,todo:[{content:'Read the made-up notes',status:'completed'},
      {content:'Read the made-up invoices',status:'in_progress'},{content:'Write the report',status:'pending'}]}),{event_id:reading.event_id,state:'running',cancel_requested:false});
    assert.equal(Number((await job(capped.id)).cost_usd),2);
    assert.deepEqual(await beat(reading,{tokens:counts(3000000),unknown_calls:0}),{event_id:reading.event_id,state:'running',cancel_requested:true});
    assert.deepEqual([(await step(capped.id)).ended,Number((await job(capped.id)).cost_usd)],['cost',6]);
    await s.jobs.runs.finish({event_id:reading.event_id,actor:reading.context.actor,state:'done',session:reading.context.conversation,error_code:null,text:'A report too late.'});
    assert.equal((await step(capped.id)).run,'cancelled');
    assert.equal((await s.jobs.operation('job:'+capped.id,await authority())).stage,'delivery');
    const note=(await stores.control.query('SELECT a.* FROM background_reports b JOIN telegram_action_requests a ON a.id=b.action_id WHERE b.job_id=$1',[capped.id])).rows[0];
    assert.equal(note.destination,group);
    assert.equal(note.text_hash,digest('⏱ Long read: the job stopped at its cost limit before it wrote a report.\n✅ Done: Read the made-up notes\n⏳ Left: Read the made-up invoices; Write the report'));
    await stores.control.query("UPDATE telegram_action_requests SET state='done' WHERE id=$1",[note.id]);
    assert.equal((await s.jobs.operation('job:'+capped.id,await authority())).state,'completed');
    assert.deepEqual([(await job(capped.id)).state,(await job(capped.id)).ended,(await job(capped.id)).error_code],['done','cost',null]);
    assert.match(last('settle').text,/⏱ Stopped at its limit\. A short note of what is done and left is in the chat\./);assert.equal(last('settle').buttons,undefined);
    // Stopping a running job cancels its run and sends no report.
    const stopped=await s.jobs.start(await actor((await message('stopped')).id),{title:'Stop me',instruction:'Read it all.'});
    await s.jobs.decide('123',{id:stopped.id,fingerprint:stopped.fingerprint,decision:'approve'},(await message('approve-stopped',123)));
    await s.jobs.operation('job:'+stopped.id,await authority());
    const begun=(await step(stopped.id)).event_id,context=await s.jobs.runs.context({event_id:begun,owner_epoch:(await authority()).epoch});
    await s.jobs.runs.claim({...context,actor:context.actor});assert.equal((await step(stopped.id)).run,'running');
    const stepReader:Reader={admin:false,scope:group,space:group,turnEvent:begun,logical_profile:'job-'+stopped.id.slice(0,24)};
    assert.equal(await s.jobs.runs.deliveryAllowed(stepReader),true,'a running run passes the turn policy check');
    // An operation a run asks for waits for the job's end with no card of its own, and the run goes on without it (ADR-0204).
    const now=await s.guards.state(),stepActor:Reader={...stepReader,generation:now.generation,guard_epoch:now.epoch,revision:now.epoch},shown=cards.length;
    const asked=await s.actionCommands.offer('controlled',await s.controlledActions.propose(stepActor,{kind:'shell',arguments:{command:'printf made-up-check'}}));
    assert.equal(asked.state,'proposed');assert.match(asked.message,/Kept with this job's other changes[^]*Do not wait for it/);
    const long=await s.actionCommands.offer('controlled',await s.controlledActions.propose(stepActor,{kind:'shell',arguments:{command:'printf '+'x'.repeat(2300)}}));
    assert.equal(cards.length,shown,'no card while the job runs');assert.match(long.message,/Kept with this job's other changes/);
    // Stop follows the card's rule. A job's own run stops nothing; another member may not; another chat does not see the job.
    await assert.rejects(s.jobs.stop(stepActor,{id:stopped.id}),{status:403,code:'job_in_a_job'});
    await assert.rejects(s.jobs.stop(await actor((await message('not-mine',8)).id),{id:stopped.id}),{status:403,code:'job_not_permitted'});
    const elsewhere=await capture('elsewhere',{message:{message_id:++sent,date:1700000000,chat:{id:Number(other),type:'supergroup'},from:{id:9,first_name:'Member'},text:'Stop it'}},other);
    await assert.rejects(s.jobs.stop(await actor(elsewhere.id,other),{id:stopped.id}),{status:404,code:'job_not_found'},'the person who asked, but in another chat');
    // The Stop button follows the same rule: another member's press stops nothing, a press with Stop's data on any other card decides nothing.
    const stopButton='ns'+stopped.id.slice(0,40)+stopped.fingerprint.slice(0,16);
    await s.actionCommands.callback(await press('stop-other',stopButton,8));
    assert.equal(last('answer').text,'Only the person who asked or the owner can stop this job.');
    await s.actionCommands.callback(await press('stop-action','ns'+asked.id.slice(0,40)+asked.fingerprint.slice(0,16),123));
    assert.equal(last('answer').text,'This request changed or no longer exists. Review it in the dashboard Inbox.');
    assert.deepEqual((await stores.control.query('SELECT state FROM controlled_actions WHERE id=$1',[asked.id])).rows[0].state,'proposed');
    assert.equal((await job(stopped.id)).cancel_requested,false);
    // The person who asked stops their own job on its card in its chat.
    await s.actionCommands.callback(await press('stop-mine',stopButton,9));
    assert.equal(last('answer').text,'🛑 Stopping the job. Nothing more runs.');
    assert.match(last('settle').text,/⏳ Stopping\. Nothing more runs\./);assert.equal(last('settle').buttons,undefined,'a stopping job has no Stop button');
    assert.deepEqual([(await job(stopped.id)).cancel_requested,(await step(stopped.id)).ended],[true,'stopped']);
    assert.equal((await stores.control.query('SELECT cancel_requested FROM managed_runs WHERE event_id=$1',[(await step(stopped.id)).event_id])).rows[0].cancel_requested,true);
    assert.equal(await s.jobs.runs.deliveryAllowed(stepReader),false,'a stopped run may not go on');
    assert.equal((await s.jobs.operation('job:'+stopped.id,await authority())).state,'waiting');
    await stores.control.query("UPDATE managed_runs SET state='cancelled' WHERE event_id=$1",[(await step(stopped.id)).event_id]);
    assert.equal((await s.jobs.operation('job:'+stopped.id,await authority())).state,'cancelled');
    assert.equal((await job(stopped.id)).state,'stopped');
    assert.match(last('settle').text,/🚫 Stopped\./);
    assert.deepEqual((await stores.control.query('SELECT state,error_code FROM controlled_actions WHERE id=ANY($1)',[[asked.id,long.id]])).rows,
      [{state:'rejected',error_code:'job_stopped'},{state:'rejected',error_code:'job_stopped'}],'Stop ends what the job asked for');
    // A member's job over the owner's limit waits for the owner in their private chat.
    rates={input:1000,output:1000,cache_read:100,cache_write:1000};
    const big=await s.actionCommands.offer('background',await s.jobs.start(await actor((await message('big',8)).id),{title:'Huge',instruction:'Read years.'}));
    assert.equal(big.approver,'owner');assert.equal(last('card').chat_id,'123');assert.match(big.message,/owner was asked privately/);
    const huge=(big.estimate as any).cost_usd;assert.ok(huge>5);
    assert.equal(Number((await job(big.id)).cost_limit_usd),Math.ceil(huge*1.5),'an approved estimate sets the limit at half again');
    // So does a member's job on a model with no input or output price: only its time limits it, and the card says so.
    rates={input:null,output:10,cache_read:0.2,cache_write:2.5};
    const unpriced=await s.actionCommands.offer('background',await s.jobs.start(await actor((await message('unpriced',8)).id),{title:'Unpriced',instruction:'Read the made-up notes.'}));
    assert.equal(unpriced.approver,'owner');assert.equal((unpriced.estimate as any).cost_usd,null);assert.match(last('card').text,/cost unknown/);
    assert.match(last('card').text,/🛑 Cost can't be measured for this model: only the time limit applies \(45 min\)/);assert.doesNotMatch(last('card').text,/Stops at/);
    assert.equal((await job(unpriced.id)).byte_budget,null,'nor a byte budget');
    // A model's price per request is frozen too, and the estimate counts it for each call.
    rates={...sonnet,request:0.01};
    const perCall=(await s.jobs.start(await actor((await privately('per-call','Read it per call')).id,null),{title:'Per call',instruction:'Read it per call.'})).estimate as any,perCallTokens=jobTokens(perCall);
    assert.equal(perCall.cost_usd,Math.round(((perCallTokens.input*2+perCallTokens.output*10)/1e6+perCallTokens.calls*0.01)*100)/100);assert.equal(perCall.rates.request,0.01);
    assert.deepEqual(unpriced.limits,{cost_usd:null,minutes:45},'start names no dollar limit it does not keep');
    // A saved card from before keeps the time limit in its cost line, which has no value here: the added line carries it.
    const savedTexts=(await stores.control.query('SELECT texts FROM owner_prompts WHERE singleton')).rows[0]?.texts??{};
    await stores.control.query('UPDATE owner_prompts SET texts=$1::jsonb WHERE singleton',[JSON.stringify({...savedTexts,'background.card':'{title}\n\n{instruction}\n🛑 Stops at {cost_limit} or {minutes_limit} min'})]);
    try {assert.equal((await s.jobs.card(unpriced.id)).text,"Unpriced\n\nRead the made-up notes.\n\n🛑 Cost can't be measured for this model: only the time limit applies (45 min)");}
    finally {await stores.control.query('UPDATE owner_prompts SET texts=$1::jsonb WHERE singleton',[JSON.stringify(savedTexts)]);}
    rates=sonnet;
    // A job whose time limit would pass the longest one is refused before anything is recorded or checked.
    const sources=s.jobs.sources,size=sources.size.bind(sources),before=Number((await stores.control.query('SELECT count(*) FROM background_jobs')).rows[0].count);
    sources.size=async(...args:Parameters<typeof size>)=>({...await size(...args),characters:200000000});
    try {
      await assert.rejects(s.jobs.start(await actor((await message('too-long',8)).id),{title:'Every year',instruction:'Read every message ever sent.'}),{status:409,code:'job_too_long'});
      await assert.rejects(s.jobs.start(await actor((await privately('too-long-owner','Read it all')).id,null),{title:'Every year',instruction:'Read it all.'}),{code:'job_too_long'},'the owner too');
    } finally {sources.size=size;}
    assert.equal(Number((await stores.control.query('SELECT count(*) FROM background_jobs')).rows[0].count),before);
    // Members start a few jobs a day per group; the owner sets how many.
    const settings=await s.jobs.settings();
    for(const minutes of [4,51,60])await assert.rejects(s.jobs.saveSettings({admin:true,scope:null},{cost_limit_usd:5,minutes_limit:minutes,member_daily_jobs:1,revision:settings.revision}),
      {status:400,code:'invalid_settings'},'a job runs 5 to 50 minutes');
    await s.jobs.saveSettings({admin:true,scope:null},{cost_limit_usd:5,minutes_limit:45,member_daily_jobs:1,revision:settings.revision});
    await assert.rejects(s.jobs.start(await actor((await message('more')).id),{title:'More',instruction:'Again.'}),{code:'job_limit_reached'});
    const ownerJob=await s.jobs.start(await actor((await message('owner-more',123)).id),{title:'Owner',instruction:'Again.'});
    assert.equal(ownerJob.state,'proposed','the owner has no daily limit');
    // A member may not stop the owner's job in their group; the owner stops any job, from any of their chats.
    await assert.rejects(s.jobs.stop(await actor((await message('stop-owner',9)).id),{id:ownerJob.id}),{status:403,code:'job_not_permitted'});
    assert.equal((await s.jobs.stop(await actor((await privately('owner-stops','Stop that one')).id,null),{id:ownerJob.id})).state,'stopped');
    assert.equal((await s.jobs.stop(await actor((await message('owner-stops-big',123)).id),{id:big.id})).state,'stopped');
    assert.deepEqual([(await job(ownerJob.id)).state,(await job(big.id)).state],['stopped','stopped']);
    // A job without a price has no cost limit: a run of any size goes on, and only its time stops it.
    await s.jobs.decide('123',{id:unpriced.id,fingerprint:unpriced.fingerprint,decision:'approve'},await message('approve-unpriced',123));
    await s.jobs.operation('job:'+unpriced.id,await authority());
    const unpricedRun=await claimRun(unpriced.id),unpricedText=String(unpricedRun.claim.text);
    assert.match(unpricedText,/The job stops at 45 minutes\.$/);assert.doesNotMatch(unpricedText,/\$/,'the job is told of no dollar limit');
    assert.equal(unpricedRun.context.background.cost_limit_usd,null);
    assert.equal((await beat(unpricedRun,{tokens:counts(900000000,20,9000000),unknown_calls:50})).cancel_requested,false);
    assert.deepEqual([(await step(unpriced.id)).ended,Number((await job(unpriced.id)).cost_usd)],[null,0]);
    assert.equal((await s.jobs.list({admin:true,scope:null})).jobs.find(item=>item.id===unpriced.id)!.priced,false,'the dashboard says the cost can\'t be measured');
    // The owner stops any job with its card's Stop, wherever it is pressed.
    await s.actionCommands.callback(await press('stop-owner',('ns'+unpriced.id.slice(0,40)+unpriced.fingerprint.slice(0,16)),123));
    assert.equal(last('answer').text,'🛑 Stopping the job. Nothing more runs.');
    assert.equal((await beat(unpricedRun,{tokens:counts(900000001,21,9000000),unknown_calls:50})).cancel_requested,true);
    assert.equal((await step(unpriced.id)).tokens.input_tokens,900000001,'progress is kept while the run is stopped');
    await s.jobs.runs.finish({event_id:unpricedRun.event_id,actor:unpricedRun.context.actor,state:'cancelled',session:unpricedRun.context.conversation,error_code:null,text:''});
    await s.jobs.operation('job:'+unpriced.id,await authority());
    assert.equal((await job(unpriced.id)).state,'stopped');
    // The broker counts a job's model request bytes in one statement and refuses past the byte budget, which holds
    // without the run's own counts; the job then ends at its cost limit with a short note, with no relaunch.
    const bytesAsk=await privately('bytes','Read it with care'),bytes=await s.jobs.start(await actor(bytesAsk.id,null),{title:'Bytes',instruction:'Read it with care.'});
    await s.jobs.decide('123',{id:bytes.id,fingerprint:bytes.fingerprint,decision:'approve'},bytesAsk);
    await s.jobs.operation('job:'+bytes.id,await authority());
    const bytesStep=await step(bytes.id),bytesContext:any=await s.jobs.runs.context({event_id:bytesStep.event_id,owner_epoch:(await authority()).epoch});
    const bytesClaim:any=await s.jobs.runs.claim({...bytesContext,actor:bytesContext.actor});await s.jobs.runs.prepare({...bytesContext,actor:bytesContext.actor});
    const previousRoute=process.env.NOCHEH_REPLY_ROUTE_URL;process.env.NOCHEH_REPLY_ROUTE_URL='https://gateway.example.test/v1';
    const sentTo:string[]=[],broker=brokerServer({pool:stores.control,storage:s.turns,token:digest(key),archive:'http://archive',hermes:'http://hermes',model:'fixture-model',
      prepare:storageGuardService(s),fetch:async url=>{
        if(String(url).endsWith('/internal/security/transport'))return Response.json({base_url:'https://gateway.example.test/v1',api_mode:'chat_completions',api_key:'synthetic-credential',model_context_length:100000});
        sentTo.push(String(url));return Response.json({ok:true});}});
    await new Promise<void>(resolve=>broker.listen(0,'127.0.0.1',resolve));
    try {
      const model=()=>fetch('http://127.0.0.1:'+(broker.address() as {port:number}).port+'/v1/chat/completions',{method:'POST',
        headers:{authorization:'Bearer '+bytesClaim.archive_credential,'content-type':'application/json'},body:JSON.stringify({model:'fixture-model',input:[{role:'user',content:'Made-up words to read.'}]})});
      assert.equal((await model()).status,200);
      const once=Number((await job(bytes.id)).model_bytes);assert.ok(once>0,'the request bytes are counted');assert.equal(sentTo.length,1);
      await stores.control.query('UPDATE background_jobs SET byte_budget=$2 WHERE id=$1',[bytes.id,once]);
      const refused=await model();assert.deepEqual([refused.status,await refused.json()],[409,{error:'job_cost_limit'}],'not a 401 or 403, which Hermes reads as a rejected key');
      assert.equal(sentTo.length,1,'nothing goes out past the budget');assert.equal(Number((await job(bytes.id)).model_bytes),2*once);
    } finally {if(previousRoute===undefined)delete process.env.NOCHEH_REPLY_ROUTE_URL;else process.env.NOCHEH_REPLY_ROUTE_URL=previousRoute;
      broker.closeAllConnections();await new Promise<void>(resolve=>broker.close(()=>resolve()));}
    await s.jobs.runs.finish({event_id:bytesStep.event_id,actor:bytesContext.actor,state:'failed',session:bytesContext.conversation,error_code:'model_unavailable'});
    assert.equal((await s.jobs.operation('job:'+bytes.id,await authority())).stage,'delivery');
    const spent=await job(bytes.id);assert.deepEqual([spent.state,spent.ended,spent.error_code],['reporting','cost',null]);
    assert.equal((await step(bytes.id)).event_id,bytesStep.event_id,'no relaunch once the budget is spent');
    // The owner's own job, asked in their private chat, reports there.
    const myAsk=await privately('mine','Read my chat'),me=await actor(myAsk.id,null);
    const mine=await s.jobs.start(me,{title:'Mine',instruction:'Read my chat.'});
    assert.doesNotMatch((await s.jobs.card(mine.id)).text,/daily limit/,'the owner has none');
    await s.jobs.decide('123',{id:mine.id,fingerprint:mine.fingerprint,decision:'approve'},myAsk);
    await s.jobs.operation('job:'+mine.id,await authority());
    // Receipt counts that are not plain whole numbers are ignored: the run keeps the counts its heartbeats sent.
    const myRun=await claimRun(mine.id);await beat(myRun,{tokens:counts(50000),unknown_calls:1});
    await s.jobs.runs.finish({event_id:myRun.event_id,actor:myRun.context.actor,state:'done',session:myRun.context.conversation,error_code:null,text:'My report.',
      todo:'none',unknown_calls:-1,tokens:{input_tokens:-5000000,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,calls:1}});
    await s.jobs.operation('job:'+mine.id,await authority());
    const myCounts=(await stores.control.query('SELECT tokens,unknown_calls,todo FROM background_runs WHERE job_id=$1',[mine.id])).rows[0];
    assert.deepEqual([myCounts.tokens,myCounts.unknown_calls,myCounts.todo],[counts(50000),1,null]);
    assert.equal(Number((await job(mine.id)).cost_usd),0.1+0.28);
    const report=(await stores.control.query('SELECT a.* FROM background_reports b JOIN telegram_action_requests a ON a.id=b.action_id WHERE b.job_id=$1',[mine.id])).rows[0];
    assert.deepEqual([report?.destination,report?.scope,report?.state],['123','123','approved'],'the report goes to the owner\'s private chat');
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});

test('the byte budget follows the cheapest prompt rate',()=>{
  const rates={input:2,output:10,cache_read:0.2,cache_write:null,request:null};
  assert.equal(byteBudget(5,rates),Math.floor(5/(0.2/1e6)*12));
  assert.equal(byteBudget(5,{input:1,output:2,cache_read:0,cache_write:null,request:null}),Math.floor(5/(1/1e6)*12),'a free cache read is not the cheapest rate');
  assert.equal(byteBudget(5,{input:0,output:2,cache_read:0,cache_write:0,request:null}),null);
  assert.equal(byteBudget(5,{input:null,output:2,cache_read:0.1,cache_write:1,request:null}),null);
});

test('a job estimate counts text, records and files, and a long report is split at line ends',()=>{
  const tokens=jobTokens({records:40000,characters:4000000,files:100,images:200,voice_notes:50});
  assert.equal(tokens.read,1000000+2000000+80000+30000+15000);assert.equal(tokens.pages,Math.ceil(tokens.read/7500));
  assert.ok(tokens.minutes>60&&tokens.input>tokens.read);
  const report=['a'.repeat(7000),'b'.repeat(7000),'c'.repeat(100)].join('\n\n');
  assert.deepEqual(reportParts(report).map(part=>part.length),[7000,7102]);
  assert.deepEqual(reportParts('x'.repeat(25000)).map(part=>part.length),[12000,12000,1000]);
});

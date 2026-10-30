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
import {jobTokens,reportParts} from '../src/stores/background-jobs.js';

test('a background job is sized, approved on its card, runs step after step in its own session and reports to its chat',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:240000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-background-jobs-')),key='background-jobs:'+Date.now(),group='-'+Date.now();
  const cards:Record<string,any>[]=[],runs:string[]=[];let price=1.2,updates=0;
  const policy=()=>({enabled:true,owner_id:'123',group_ids:[group],group_access:{[group]:{granted:['9','8'],denied:[]}},topic_memory:'group' as const});
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='usage.price')return {costs:[price]};
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
  const actor=async(source:string):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope:group,space:group,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const last=(kind:string)=>cards.filter(card=>card.kind===kind).at(-1)!;
  const authority=async()=>({owner:'inngest' as const,epoch:Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='background'")).rows[0].epoch)});
  const job=async(id:string)=>(await stores.control.query('SELECT * FROM background_jobs WHERE id=$1',[id])).rows[0];
  const step=async(id:string)=>(await stores.control.query('SELECT s.*,r.state AS run FROM background_steps s JOIN managed_runs r ON r.event_id=s.event_id WHERE s.job_id=$1 ORDER BY s.step DESC,s.attempt DESC LIMIT 1',[id])).rows[0];
  /** What Hermes does with a step: read its context, claim it, then report what the step left. */
  const runStep=async(id:string,result:Record<string,unknown>)=>{
    const current=await step(id),epoch=(await authority()).epoch;
    await s.jobs.steps.run(current.event_id,await authority());
    const context=await s.jobs.steps.context({event_id:current.event_id,owner_epoch:epoch});
    const claim=await s.jobs.steps.claim({...context,actor:context.actor});
    await s.jobs.steps.prepare({...context,actor:context.actor});
    await s.jobs.steps.finish({event_id:current.event_id,actor:context.actor,state:'done',session:context.conversation,error_code:null,...result});
    return {context:context as any,claim};
  };
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    for(let index=0;index<5;index++)await message('history-'+index,8,'Earlier message '+index);
    const ask=await message('ask');
    const size=await s.jobs.size(await actor(ask.id),{});
    assert.equal(size.chat,group);assert.equal(size.messages,6);assert.equal(size.cost_usd,1.2);assert.ok(size.minutes>=2);
    await assert.rejects(s.jobs.size(await actor(ask.id),{chat:'123'}),{status:403},'a member sizes only their own group');
    // A member proposes a job; the card answers the request in the group, for that person or the owner.
    const proposed=await s.jobs.propose(await actor(ask.id),{title:'Open tasks',instruction:'Find every task that is still open and who owns it.'});
    assert.equal(proposed.state,'proposed');assert.equal(proposed.approver,'requester');
    assert.deepEqual(proposed.limits,{cost_usd:5,minutes:60});
    const offered=await s.actionCommands.offer('background',proposed);
    assert.match(offered.message,/posted here as the reply to the request/);
    const card=last('card');
    assert.equal(card.chat_id,group);assert.equal(card.reply_to,String(sent));
    assert.match(card.text,/Background job: Open tasks/);assert.match(card.text,/6 messages/);assert.match(card.text,/about \$1\.2/);
    assert.match(card.text,/Find every task that is still open and who owns it\./);
    const approve='na'+proposed.id.slice(0,40)+proposed.fingerprint.slice(0,16);
    assert.deepEqual(card.buttons,[['✅ Approve',approve],['❌ Reject','nd'+proposed.id.slice(0,40)+proposed.fingerprint.slice(0,16)]]);
    await s.actionCommands.callback(await press('other',approve,8));
    assert.equal(last('answer').text,'Only the person who asked or the owner can approve or reject this.');
    assert.equal((await job(proposed.id)).state,'proposed','another member decides nothing');
    await s.actionCommands.callback(await press('requester',approve,9));
    assert.equal((await job(proposed.id)).state,'approved');
    assert.match(last('settle').text,/⏳ Approved\. It runs now and reports here when done\./,'a free slot starts the job right away');
    assert.ok((await stores.control.query("SELECT 1 FROM workflow_registry WHERE family='background' AND job_id=$1",['job:'+proposed.id])).rowCount);
    // Each step is a managed run of the job's own profile, so the group's replies never wait for it.
    assert.equal((await s.jobs.operation('job:'+proposed.id,await authority())).state,'waiting');
    const first=await step(proposed.id);
    assert.deepEqual([first.step,first.kind,first.run],[1,'work','captured']);
    const one=await runStep(proposed.id,{text:'Read 6 of 6 records.',continue:true,todo:[{content:'Check who owns the invoice',status:'pending'}],cost_usd:0.5});
    assert.ok(runs.includes('run.start:'+first.event_id));
    assert.equal(one.context.profile,'job-'+proposed.id.slice(0,24));assert.equal(one.context.background.max_iterations,20);
    assert.match(String(one.claim.text),/Find every task that is still open and who owns it\./,'the first step carries the instruction');
    const claims=JSON.parse(Buffer.from(String(one.claim.archive_credential).split('.')[1]!,'base64url').toString());
    assert.equal(claims.logical_profile,'job-'+proposed.id.slice(0,24));assert.ok(claims.expires-Date.now()>800000,'a step credential outlives a long step');
    await s.jobs.operation('job:'+proposed.id,await authority());
    const counted=await job(proposed.id);
    assert.deepEqual([counted.state,counted.steps,Number(counted.cost_usd),counted.todo],['running',1,0.5,[{content:'Check who owns the invoice',status:'pending'}]]);
    const second=await step(proposed.id);assert.deepEqual([second.step,second.kind],[2,'work']);
    const two=await runStep(proposed.id,{text:'Report: 2 tasks are open.',continue:false,todo:[],cost_usd:0.25});
    assert.match(String(two.claim.text),/Continue the job where you stopped/);
    // The answer that ends on its own is the report, sent to the group by the job's approval.
    assert.equal((await s.jobs.operation('job:'+proposed.id,await authority())).stage,'delivery');
    const reported=await job(proposed.id);
    assert.deepEqual([reported.state,reported.steps,Number(reported.cost_usd)],['reporting',2,0.75]);
    assert.deepEqual(reported.todo,[{content:'Check who owns the invoice',status:'pending'}],'a step without a list keeps the last one');
    const action=(await stores.control.query('SELECT a.* FROM background_reports b JOIN telegram_action_requests a ON a.id=b.action_id WHERE b.job_id=$1',[proposed.id])).rows[0];
    assert.deepEqual([action.destination,action.state],[group,'approved']);
    assert.equal((await s.jobs.operation('job:'+proposed.id,await authority())).state,'waiting','the report waits for Telegram');
    await stores.control.query("UPDATE telegram_action_requests SET state='done' WHERE id=$1",[action.id]);
    assert.equal((await s.jobs.operation('job:'+proposed.id,await authority())).state,'completed');
    assert.equal((await job(proposed.id)).state,'done');
    assert.match(last('settle').text,/✅ Done\. The report is in the chat\./,'the card shows the job ended');
    const listed=(await s.jobs.list(await actor(ask.id))).jobs.find(item=>item.id===proposed.id)!;
    assert.deepEqual([listed.title,listed.state,listed.steps],['Open tasks','done',2]);
    // A job at its cost limit gets one short step that writes the report from what it has.
    const capped=await s.jobs.propose(await actor((await message('capped')).id),{title:'Long read',instruction:'Read everything.'});
    await s.jobs.decide('9',{id:capped.id,fingerprint:capped.fingerprint,decision:'approve'},(await message('approve-capped')));
    await s.jobs.operation('job:'+capped.id,await authority());
    await runStep(capped.id,{text:'Read half.',continue:true,todo:[],cost_usd:9});
    await s.jobs.operation('job:'+capped.id,await authority());
    const wrap=await step(capped.id);assert.equal(wrap.kind,'wrap_up');
    const last_step=await runStep(capped.id,{text:'Partial report.',continue:false,todo:[],cost_usd:0.1});
    assert.match(String(last_step.claim.text),/reached its limit of \$5/);assert.equal(last_step.context.background.max_iterations,4);
    // Stopping a running job cancels its step and sends no report.
    const stopped=await s.jobs.propose(await actor((await message('stopped')).id),{title:'Stop me',instruction:'Read it all.'});
    await s.jobs.decide('123',{id:stopped.id,fingerprint:stopped.fingerprint,decision:'approve'},(await message('approve-stopped',123)));
    await s.jobs.operation('job:'+stopped.id,await authority());
    const started=(await step(stopped.id)).event_id,context=await s.jobs.steps.context({event_id:started,owner_epoch:(await authority()).epoch});
    await s.jobs.steps.claim({...context,actor:context.actor});assert.equal((await step(stopped.id)).run,'running');
    await assert.rejects(s.jobs.stop(await actor((await capture('elsewhere',{message:{message_id:900,date:1700000000,chat:{id:123,type:'private'},from:{id:123},text:'x'}},'123')).id),{id:stopped.id}),
      (error:any)=>error.status>=400,'a chat stops only its own jobs unless it is the owner');
    assert.equal((await s.jobs.stop(await actor((await message('stop-it')).id),{id:stopped.id})).state,'stopping');
    assert.equal((await stores.control.query('SELECT cancel_requested FROM managed_runs WHERE event_id=$1',[(await step(stopped.id)).event_id])).rows[0].cancel_requested,true);
    assert.equal((await s.jobs.operation('job:'+stopped.id,await authority())).state,'waiting');
    await stores.control.query("UPDATE managed_runs SET state='cancelled' WHERE event_id=$1",[(await step(stopped.id)).event_id]);
    assert.equal((await s.jobs.operation('job:'+stopped.id,await authority())).state,'cancelled');
    assert.equal((await job(stopped.id)).state,'stopped');
    assert.match(last('settle').text,/🚫 Stopped\./);
    // A member's job over the owner's limit waits for the owner in their private chat.
    price=40;
    const big=await s.actionCommands.offer('background',await s.jobs.propose(await actor((await message('big',8)).id),{title:'Huge',instruction:'Read years.'}));
    assert.equal(big.approver,'owner');assert.equal(last('card').chat_id,'123');assert.match(big.message,/owner was asked privately/);
    assert.equal(Number((await job(big.id)).cost_limit_usd),60,'an approved estimate sets the limit at half again');
    // Members start a few jobs a day per group; the owner sets how many.
    const settings=await s.jobs.settings();
    await s.jobs.saveSettings({admin:true,scope:null},{cost_limit_usd:5,minutes_limit:60,member_daily_jobs:1,revision:settings.revision});
    await assert.rejects(s.jobs.propose(await actor((await message('more')).id),{title:'More',instruction:'Again.'}),{code:'job_limit_reached'});
    await assert.rejects(s.jobs.propose(await actor((await message('owner-more',123)).id),{title:'Owner',instruction:'Again.'}).then(value=>{throw Object.assign(Error('ok'),{code:value.state});}),
      {code:'proposed'},'the owner has no daily limit');
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});

test('a job estimate counts text, records and files, and a long report is split at line ends',()=>{
  const tokens=jobTokens({records:40000,characters:4000000,files:100,images:200,voice_notes:50});
  assert.equal(tokens.read,1000000+2000000+80000+30000+15000);assert.equal(tokens.pages,Math.ceil(tokens.read/7500));
  assert.ok(tokens.minutes>60&&tokens.input>tokens.read);
  const report=['a'.repeat(7000),'b'.repeat(7000),'c'.repeat(100)].join('\n\n');
  assert.deepEqual(reportParts(report).map(part=>part.length),[7000,7102]);
  assert.deepEqual(reportParts('x'.repeat(25000)).map(part=>part.length),[12000,12000,1000]);
});

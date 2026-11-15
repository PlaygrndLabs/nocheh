import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {HttpError} from '../src/http.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {fixtureServices} from './fixture-brain.js';
import {honchoEngine} from '../src/memory/honcho.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {chatDirectory,chatIdFor,installChatsForTest} from '../src/chats.js';
import {NG2,NG2_OLD_TG,NG2_TG,NG_GROUP_IDS,OWNER,fixtureChats} from './fixture-groups.js';

test('a member\'s job cap is to the cent; members\' daily job spend gets one notice, pauses at the high mark, and a pause only holds jobs members approved',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:240000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-member-spend-')),key='member-spend:'+Date.now(),group='-'+Date.now();
  // The reply model's made-up rates in USD per million tokens.
  const rates={input:2,output:10,cache_read:0.2,cache_write:2.5,request:0};
  const cards:Record<string,any>[]=[],notices:Record<string,any>[]=[];let updates=0,oldGateway=false,offline=false;
  const policy=()=>({enabled:true,owner_id:'123',group_ids:[group],group_access:{[group]:{granted:['9','8'],denied:[]}},topic_memory:'group' as const});
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='usage.price')return {rates};
      if(operation==='run.resume')return {state:'not_found'};
      if(operation==='run.start'||operation==='run.cancel')return {state:'queued'};
      if(operation==='telegram.notice') {
        // A Telegram service older than the Pause and Resume buttons refuses them before it sends anything.
        if(oldGateway&&input.buttons)throw new HttpError(400,'telegram_rejected_request');
        // The Telegram service is reconnecting: nothing is sent.
        if(offline)return {state:'not_started',error_code:'telegram_not_connected'};
        notices.push(input);return {state:'done'};
      }
      assert.equal(operation,'telegram.approval');cards.push(input);
      return input.kind==='card'?{state:'done',chat_id:input.chat_id,message_id:'5'}:{state:'done'};
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  const bot=String(Date.now()).slice(-9),owner:Reader={admin:true,scope:null};
  const capture=async(label:string,payload:Record<string,unknown>,scope=group)=>{
    const event:Envelope={version:1,key:payload.update_id?`telegram:${bot}:update:${payload.update_id}`:key+':'+label,origin:'live',kind:'telegram_update',bot_id:payload.update_id?bot:key,scope,source_id:payload.update_id?String(payload.update_id):label,revision:'1',occurred_at:null,text:String((payload.message as any)?.text??''),payload};
    const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  let sent=100;
  const message=(label:string,from=9,text='Please find what is still open')=>capture(label,{message:{message_id:++sent,date:1700000000,
    chat:{id:Number(group),type:'supergroup'},from:{id:from,first_name:from===9?'Member':'Helper'},text}});
  const privately=(label:string,text:string)=>capture(label,{message:{message_id:++sent,date:1700000000,chat:{id:123,type:'private'},from:{id:123},text}},'123');
  const press=(label:string,data:string,from:number,chat=group)=>capture(label,{update_id:++updates,callback_query:{id:'query-'+label,from:{id:from},chat_instance:'1',data,
    message:{message_id:5,date:1700000000,chat:{id:Number(chat),type:chat===group?'supergroup':'private'}}}},chat);
  const actor=async(source:string,scope:string|null=group,space=scope??'123'):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope,space,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const last=(kind:string)=>cards.filter(card=>card.kind===kind).at(-1)!;
  const authority=async()=>({owner:'inngest' as const,epoch:Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='background'")).rows[0].epoch)});
  const job=async(id:string)=>(await stores.control.query('SELECT * FROM background_jobs WHERE id=$1',[id])).rows[0];
  const step=async(id:string)=>(await stores.control.query('SELECT b.*,r.state AS run FROM background_runs b JOIN managed_runs r ON r.event_id=b.event_id WHERE b.job_id=$1 ORDER BY b.attempt DESC LIMIT 1',[id])).rows[0];
  const tick=async(id:string)=>s.jobs.operation('job:'+id,await authority());
  const claimRun=async(id:string)=>{
    const current=await step(id),epoch=(await authority()).epoch;
    await s.jobs.runs.run(current.event_id,await authority());
    const context:any=await s.jobs.runs.context({event_id:current.event_id,owner_epoch:epoch});
    await s.jobs.runs.claim({...context,actor:context.actor});
    await s.jobs.runs.prepare({...context,actor:context.actor});
    return {event_id:current.event_id as string,context};
  };
  const beat=(run:{context:any},progress:unknown)=>s.jobs.runs.heartbeat({...run.context,actor:run.context.actor,progress});
  const counts=(input_tokens:number)=>({tokens:{input_tokens,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,calls:1},unknown_calls:0});
  const button=(id:string,fingerprint:string,choice='a')=>'n'+choice+id.slice(0,40)+fingerprint.slice(0,16);
  const paused=async()=>(await stores.control.query('SELECT * FROM member_job_pause WHERE singleton')).rows[0];
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    for(let index=0;index<3;index++)await message('history-'+index,8,'Earlier message '+index);
    // A member's cap is half again over the estimate to the cent: a $0.50 limit gives a small job $0.50, not a whole dollar.
    let settings=await s.jobs.settings();
    assert.deepEqual([settings.member_notice_usd,settings.member_pause_usd],[20,100]);
    settings=await s.jobs.saveSettings(owner,{cost_limit_usd:0.5,minutes_limit:45,member_daily_jobs:20,revision:settings.revision});
    assert.deepEqual([settings.member_notice_usd,settings.member_pause_usd],[20,100],'a save without the marks keeps them');
    const small=await s.jobs.start(await actor((await message('small')).id),{title:'Small',instruction:'Read the made-up notes.'});
    const estimate=(small.estimate as any).cost_usd as number;
    assert.equal(small.approver,'requester');assert.ok(estimate>0&&estimate*1.5<=0.5,String(estimate));
    assert.deepEqual(small.limits,{cost_usd:0.5,minutes:45});
    assert.match((await s.jobs.card(small.id)).text,/🛑 Stops at \$0\.50 or 45 min/);
    // The owner's own job keeps the whole-dollar room it always had.
    const mine=await s.jobs.start(await actor((await privately('mine','Read my notes')).id,null),{title:'Mine',instruction:'Read my made-up notes.'});
    assert.equal(Number((await job(mine.id)).cost_limit_usd),Math.max(0.5,Math.ceil(((mine.estimate as any).cost_usd)*1.5)));
    assert.match((await s.jobs.card(mine.id)).text,/🛑 Stops at \$1\.00 or 45 min/,'the card shows the cap to the cent');
    // Near the limit, a member's job keeps half again over its estimate, rounded up to the cent, and is told that cap.
    const limit=Math.round((estimate+0.01)*100)/100;
    settings=await s.jobs.saveSettings(owner,{...settings,cost_limit_usd:limit});
    const near=await s.jobs.start(await actor((await message('near')).id),{title:'Near',instruction:'Read the made-up invoices.'});
    const nearEstimate=(near.estimate as any).cost_usd as number,cap=Math.max(Math.round(limit*100),Math.ceil(Math.round(nearEstimate*100)*3/2))/100;
    assert.equal(near.approver,'requester');assert.ok(cap>limit,`${cap} over ${limit}`);
    assert.equal(Number((await job(near.id)).cost_limit_usd),cap);
    assert.ok((await s.jobs.card(near.id)).text.includes('🛑 Stops at $'+cap.toFixed(2)+' or 45 min'));
    await s.jobs.halt(small.id);await s.jobs.halt(mine.id);await s.jobs.halt(near.id);

    // The marks: one notice at the first, a pause past the second, in a UTC day. The high mark is never below the notice mark.
    for(const marks of [{member_notice_usd:5,member_pause_usd:4},{member_pause_usd:19},{member_notice_usd:'1'},{member_notice_usd:0},{member_notice_usd:10001,member_pause_usd:10001}])
      await assert.rejects(s.jobs.saveSettings(owner,{...settings,cost_limit_usd:5,...marks}),{status:400,code:'invalid_settings'},JSON.stringify(marks));
    assert.equal((await s.jobs.settings()).revision,settings.revision,'a refused save changes nothing');
    settings=await s.jobs.saveSettings(owner,{...settings,cost_limit_usd:5,member_notice_usd:1,member_pause_usd:3});
    assert.deepEqual([settings.member_notice_usd,settings.member_pause_usd,settings.cost_limit_usd],[1,3,5]);

    // A member's job the owner approves with Approve in the group neither counts nor waits.
    const asked=await s.jobs.start(await actor((await message('owner-approves',8)).id),{title:'Helper read',instruction:'Read the made-up plans.'});
    await s.actionCommands.offer('background',asked);
    await s.actionCommands.callback(await press('owner-approves',button(asked.id,asked.fingerprint),123));
    assert.equal((await job(asked.id)).decided_by,'123');
    await tick(asked.id);
    const helper=await claimRun(asked.id);
    await beat(helper,counts(2000000));
    assert.equal(Number((await job(asked.id)).cost_usd),4);
    await tick(asked.id);
    assert.deepEqual([notices.length,(await s.jobs.members.today('123')).spent],[0,0],'four dollars the owner approved count for nothing');
    await s.jobs.runs.finish({event_id:helper.event_id,actor:helper.context.actor,state:'done',session:helper.context.conversation,error_code:null,text:'Report: the plans are read.'});
    assert.equal((await tick(asked.id)).stage,'delivery');
    await stores.control.query("UPDATE telegram_action_requests SET state='done' WHERE id IN (SELECT action_id FROM background_reports WHERE job_id=$1)",[asked.id]);
    assert.equal((await tick(asked.id)).state,'completed');

    // A member approves their own job: its spend counts, and the owner gets one notice with a Pause button at the first mark.
    const own=await s.jobs.start(await actor((await message('own')).id),{title:'Own read',instruction:'Read the made-up receipts.'});
    await s.actionCommands.offer('background',own);
    assert.equal(last('card').chat_id,group,'the card stays in the group');
    await s.actionCommands.callback(await press('own',button(own.id,own.fingerprint),9));
    await tick(own.id);
    const reading=await claimRun(own.id);
    await beat(reading,counts(400000));await tick(own.id);
    assert.equal(notices.length,0,'below the mark, no notice');
    await beat(reading,counts(600000));await tick(own.id);
    assert.equal(notices.length,1);
    const spend=notices[0]!;
    assert.equal(spend.chat_id,'123');assert.deepEqual(spend.buttons,[{text:'⏸ Pause member jobs',callback:'njp'}]);
    assert.ok(spend.text.startsWith('💸 Jobs that members approved themselves spent $1.20 today (UTC), past your notice mark of $1.00.\n• Member in a group: $1.20\n'),spend.text);
    assert.match(spend.text,/At \$3\.00 today, member jobs pause by themselves until 00:00 UTC\.$/);
    await tick(own.id);assert.equal(notices.length,1,'one notice a day at that mark');
    assert.equal(await s.jobs.members.pause(),null,'nothing changes unless the owner taps');

    // Past the high mark member jobs pause by themselves until 00:00 UTC, with one notice that has Resume.
    await beat(reading,counts(1600000));await tick(own.id);
    assert.equal(notices.length,2);
    const pause=notices[1]!;
    assert.ok(pause.text.startsWith('⏸ Member jobs are paused until 00:00 UTC: jobs that members approved themselves spent $3.20 today, past your high mark of $3.00.'),pause.text);
    assert.deepEqual(pause.buttons,[{text:'▶\ufe0f Resume member jobs',callback:'nju'}]);
    const held=await s.jobs.members.pause(),midnight=new Date();midnight.setUTCHours(24,0,0,0);
    assert.deepEqual([held?.by,held?.until],['auto',midnight.toISOString()]);
    await tick(own.id);assert.equal(notices.length,2,'it pauses once');
    // A running member job goes on to its own cap.
    assert.equal((await beat(reading,counts(1700000)) as any).cancel_requested,false);

    // While paused a member still asks and approves, nothing goes to the owner, and the approved job waits to start.
    const shown=cards.length;
    const later=await s.jobs.start(await actor((await message('later')).id),{title:'Later read',instruction:'Read the made-up orders.'});
    assert.equal(later.approver,'requester','nothing is refused or sent to the owner');
    await s.actionCommands.offer('background',later);
    assert.equal(cards.slice(shown).filter(card=>card.chat_id==='123').length,0);
    await s.actionCommands.callback(await press('later',button(later.id,later.fingerprint),9));
    assert.equal((await job(later.id)).state,'approved');
    assert.match(last('settle').text,/⏸ Approved\. Member jobs are paused for now; it starts when they resume\./);
    assert.deepEqual(last('settle').buttons,[['🛑 Stop',button(later.id,later.fingerprint,'s')]],'the member can still stop it');
    assert.equal((await tick(later.id)).state,'waiting');
    assert.deepEqual([(await job(later.id)).held,await step(later.id)],[true,undefined],'held: no run starts');
    assert.equal((await s.jobs.list(owner)).jobs.find(item=>item.id===later.id)!.held,true);
    // The owner's own job never waits.
    const ownerJob=await s.jobs.start(await actor((await privately('owner-job','Read it')).id,null),{title:'Owner read',instruction:'Read my made-up drafts.'});
    await s.jobs.decide('123',{id:ownerJob.id,fingerprint:ownerJob.fingerprint,decision:'approve'},await privately('owner-approves-own','Approve'));
    await tick(ownerJob.id);
    assert.ok(await step(ownerJob.id),'the owner\'s job starts');
    await s.jobs.halt(ownerJob.id);
    await stores.control.query("UPDATE managed_runs SET state='cancelled' WHERE event_id=$1",[(await step(ownerJob.id)).event_id]);
    assert.equal((await tick(ownerJob.id)).state,'cancelled');
    assert.equal(await s.jobs.members.holds({requester:'8',decided_by:'123'}),false,'nor a member\'s job the owner approved');
    // The pause ends at 00:00 UTC.
    await stores.control.query("UPDATE member_job_pause SET paused_until=now()-interval '1 second'");
    assert.equal(await s.jobs.members.holds(await job(later.id)),false);
    await stores.control.query('UPDATE member_job_pause SET paused_until=$1',[midnight]);

    // Only the owner's own press in their private chat resumes; anyone else changes nothing.
    await s.actionCommands.callback(await press('member-resumes','nju',9));
    assert.equal(last('answer').text,'Only the owner can do this.');
    await s.actionCommands.callback(await press('owner-resumes-in-group','nju',123));
    assert.equal(last('answer').text,'Only the owner can do this.');
    assert.ok(await s.jobs.members.pause(),'still paused');
    await s.actionCommands.callback(await press('owner-resumes','nju',123,'123'));
    assert.equal(last('answer').text,'▶\ufe0f Member jobs resumed. Approved ones start shortly.');
    assert.equal(await s.jobs.members.pause(),null);
    const edited=notices.at(-1)!;
    assert.deepEqual([edited.id,edited.edit,edited.buttons],[pause.id,true,[{text:'⏸ Pause member jobs',callback:'njp'}]],'the notice offers Pause again');
    assert.equal(edited.text,pause.text+'\n\n▶\ufe0f Member jobs resumed. Approved ones start shortly.');
    // The held job starts now, and its card says it runs.
    await tick(later.id);
    assert.ok(await step(later.id));assert.equal((await job(later.id)).held,false);
    assert.match(last('settle').text,/⏳ Approved\. It runs now and reports here when done\./);
    // After a Resume there is no new automatic pause that day.
    await beat(reading,counts(2000000));await tick(own.id);
    assert.deepEqual([await s.jobs.members.pause(),notices.filter(notice=>!notice.edit).length],[null,2]);

    // The owner pauses from the dashboard until they resume; the notice then offers Resume.
    await assert.rejects(s.jobs.pauseMembers(owner,{paused:'yes'}),{status:400,code:'invalid_member_pause'});
    await assert.rejects(s.jobs.pauseMembers(await actor((await message('not-owner')).id),{paused:true}),{status:403});
    const summary=await s.jobs.pauseMembers(owner,{paused:true});
    assert.deepEqual([summary.paused?.by,summary.paused?.until,summary.spent_usd,summary.notice_usd,summary.pause_usd],['owner',null,4,1,3]);
    assert.deepEqual(notices.at(-1)!.buttons,[{text:'▶\ufe0f Resume member jobs',callback:'nju'}]);
    assert.deepEqual((await s.jobs.list(owner)).members?.paused?.by,'owner');
    assert.equal((await paused()).paused_until,null,'a pause the owner makes holds past midnight');
    await s.jobs.pauseMembers(owner,{paused:false});

    // A new notice mark gets its own notice. A Telegram service older than the buttons gets the text alone.
    oldGateway=true;
    settings=await s.jobs.saveSettings(owner,{...(await s.jobs.settings()),member_notice_usd:3.5,member_pause_usd:1000});
    await tick(own.id);
    assert.equal(notices.at(-1)!.buttons,undefined);assert.match(notices.at(-1)!.text,/spent \$4\.00 today \(UTC\), past your notice mark of \$3\.50\./);
    oldGateway=false;

    // A pause notice that did not go is sent on the tick of a member job it holds, when no member job runs any more.
    offline=true;
    settings=await s.jobs.saveSettings(owner,{...settings,member_pause_usd:3.9});
    await tick(own.id);
    assert.deepEqual([(await s.jobs.members.pause())?.by,(await paused()).pause_sent],['auto',false],'paused, and the owner not told yet');
    for(const id of [own.id,later.id]) {
      await s.jobs.halt(id);
      await stores.control.query("UPDATE managed_runs SET state='cancelled' WHERE event_id=$1",[(await step(id)).event_id]);
      assert.equal((await tick(id)).state,'cancelled');
    }
    const waits=await s.jobs.start(await actor((await message('waits')).id),{title:'Waiting read',instruction:'Read the made-up lists.'});
    await s.actionCommands.offer('background',waits);
    await s.actionCommands.callback(await press('waits',button(waits.id,waits.fingerprint),9));
    assert.equal((await tick(waits.id)).state,'waiting');
    assert.equal((await paused()).pause_sent,false,'still not told while Telegram is away');
    offline=false;
    const told=notices.length;
    assert.equal((await tick(waits.id)).state,'waiting');
    assert.deepEqual([(await job(waits.id)).held,await step(waits.id)],[true,undefined],'held: no run starts');
    assert.equal(notices.length,told+1,'the held job\'s tick sends the pause notice');
    assert.ok(notices.at(-1)!.text.startsWith('⏸ Member jobs are paused until 00:00 UTC: jobs that members approved themselves spent $4.00 today, past your high mark of $3.90.'),notices.at(-1)!.text);
    assert.deepEqual(notices.at(-1)!.buttons,[{text:'▶\ufe0f Resume member jobs',callback:'nju'}]);
    assert.equal((await paused()).pause_sent,true);
    await tick(waits.id);assert.equal(notices.length,told+1,'it is sent once');
    await s.jobs.halt(waits.id);assert.equal((await tick(waits.id)).state,'cancelled');

    // A notice that fails on the last member job's own check goes from the storage worker, with no member job left.
    offline=true;
    settings=await s.jobs.saveSettings(owner,{...(await s.jobs.settings()),member_notice_usd:3.6,member_pause_usd:1000});
    await s.jobs.members.check();
    assert.equal((await paused()).notice_sent,false,'not told while Telegram is away');
    offline=false;
    const before=notices.length;
    await s.jobs.members.retryUnsent();
    assert.equal(notices.length,before+1,'the retry sends it');
    assert.match(notices.at(-1)!.text,/past your notice mark of \$3\.60\./);
    assert.equal((await paused()).notice_sent,true);
    await s.jobs.members.retryUnsent();assert.equal(notices.length,before+1,'nothing more while every notice went');
  } finally {
    await s.jobs.members.setPaused(false).catch(()=>{});
    await stores.close();await rm(root,{recursive:true,force:true});
  }
});

// Members' job spend on chats first seen after step 2b (ADR-0252): the owner's private chat has a digest id apart from
// the owner's account, and the member asks in NG2, a group Telegram upgraded that TELEGRAM_GROUP_IDS names by its old id.
test('a member spend notice names a digest group by its chat, goes to the owner\'s private chat where it is in Telegram, and only the owner\'s press there resumes',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:240000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-member-spend-chats-')),key='member-spend-chats:'+Date.now();
  // The owner's private chat as capture names it after step 2b: a digest, not the owner's account id.
  const own=chatIdFor('telegram',OWNER),fixture=fixtureChats([...NG_GROUP_IDS]);
  const full=chatDirectory({...fixture,owner_chat:own,chats:fixture.chats.map(chat=>chat.id===OWNER?{...chat,id:own}:chat),
    ids:fixture.ids.map(id=>id.chat_id===OWNER?{...id,chat_id:own}:id)});
  // The same chats before the owner's private chat has a row.
  const ownerless=chatDirectory({...fixture,owner_chat:null,chats:fixture.chats.filter(chat=>chat.id!==OWNER),ids:fixture.ids.filter(id=>id.chat_id!==OWNER)});
  installChatsForTest(full);
  const rates={input:2,output:10,cache_read:0.2,cache_write:2.5,request:0},ALICE=9;
  const cards:Record<string,any>[]=[],notices:Record<string,any>[]=[];let updates=0;
  const policy=():AssistantPolicy=>({enabled:true,owner_id:OWNER,owner_chat:own,group_ids:[...NG_GROUP_IDS],group_access:{[NG2_OLD_TG]:{granted:[String(ALICE)],denied:[]}},topic_memory:'group'});
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='usage.price')return {rates};
      if(operation==='run.resume')return {state:'not_found'};
      if(operation==='run.start'||operation==='run.cancel')return {state:'queued'};
      if(operation==='telegram.notice'){notices.push(input);return {state:'done'};}
      assert.equal(operation,'telegram.approval');cards.push(input);
      return input.kind==='card'?{state:'done',chat_id:input.chat_id,message_id:'5'}:{state:'done'};
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  const bot=String(Date.now()).slice(-9),owner:Reader={admin:true,scope:null};
  const capture=async(label:string,payload:Record<string,unknown>,scope:string)=>{
    const event:Envelope={version:1,key:payload.update_id?`telegram:${bot}:update:${payload.update_id}`:key+':'+label,origin:'live',kind:'telegram_update',bot_id:payload.update_id?bot:key,scope,source_id:payload.update_id?String(payload.update_id):label,revision:'1',occurred_at:null,text:String((payload.message as any)?.text??''),payload};
    const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  let sent=100;
  // Alice asks in NG2 under its Telegram id now; the job's chat is NG2's Nocheh id.
  const message=(label:string)=>capture(label,{message:{message_id:++sent,date:1700000000,chat:{id:Number(NG2_TG),type:'supergroup',title:'NG2 team'},
    from:{id:ALICE,first_name:'Alice'},text:'Please find what is still open'}},NG2_TG);
  const press=(label:string,data:string,from:number,chat:string)=>capture(label,{update_id:++updates,callback_query:{id:'query-'+label,from:{id:from},chat_instance:'1',data,
    message:{message_id:5,date:1700000000,chat:{id:Number(chat),type:chat===OWNER?'private':'supergroup'}}}},chat);
  const actor=async(source:string):Promise<Reader>=>{
    const binding=await s.guards.state();return {admin:false,scope:NG2,space:NG2,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const last=(kind:string)=>cards.filter(card=>card.kind===kind).at(-1)!;
  const authority=async()=>({owner:'inngest' as const,epoch:Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='background'")).rows[0].epoch)});
  const step=async(id:string)=>(await stores.control.query('SELECT b.*,r.state AS run FROM background_runs b JOIN managed_runs r ON r.event_id=b.event_id WHERE b.job_id=$1 ORDER BY b.attempt DESC LIMIT 1',[id])).rows[0];
  const tick=async(id:string)=>s.jobs.operation('job:'+id,await authority());
  const button=(id:string,fingerprint:string,choice='a')=>'n'+choice+id.slice(0,40)+fingerprint.slice(0,16);
  const paused=async()=>(await stores.control.query('SELECT * FROM member_job_pause WHERE singleton')).rows[0];
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    // An earlier test's pause and notice are put away first: the resume edits its notice, which is not this test's.
    await s.jobs.members.setPaused(false);notices.length=0;
    let settings=await s.jobs.settings();
    settings=await s.jobs.saveSettings(owner,{...settings,cost_limit_usd:5,minutes_limit:45,member_daily_jobs:20,member_notice_usd:1,member_pause_usd:1000});
    const job=await s.jobs.start(await actor((await message('own')).id),{title:'Own read',instruction:'Read the made-up receipts.'});
    await s.actionCommands.offer('background',job);
    assert.equal(last('card').chat_id,NG2_TG,'the card goes where the group is in Telegram now');
    await s.actionCommands.callback(await press('own',button(job.id,job.fingerprint),ALICE,NG2_TG));
    // Members' spend today (the test above left some) passes the notice mark while the owner's private chat has no row:
    // each tick of the job checks, and nothing is sent anywhere, not to the owner's account id either; the notice waits.
    installChatsForTest(ownerless);
    await tick(job.id);
    const current=await step(job.id),epoch=(await authority()).epoch;
    await s.jobs.runs.run(current.event_id,await authority());
    const context:any=await s.jobs.runs.context({event_id:current.event_id,owner_epoch:epoch});
    await s.jobs.runs.claim({...context,actor:context.actor});await s.jobs.runs.prepare({...context,actor:context.actor});
    await s.jobs.runs.heartbeat({...context,actor:context.actor,progress:{tokens:{input_tokens:600000,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,calls:1},unknown_calls:0}});
    await tick(job.id);
    assert.equal(notices.length,0,'an owner chat the directory does not know is not sent to');
    assert.equal((await paused()).notice_sent,false);
    // Once the directory has the owner's private chat, the retry sends it there, by its Telegram id.
    installChatsForTest(full);
    await s.jobs.members.retryUnsent();
    assert.equal(notices.length,1);
    const spend=notices[0]!;
    assert.equal(spend.chat_id,OWNER,'the owner\'s private chat where it is in Telegram');assert.equal(spend.topic,undefined);
    assert.ok(spend.text.includes('\n• Alice in “NG2 team”: $1.20\n'),spend.text);
    assert.ok(![NG2,NG2_TG,NG2_OLD_TG,own].some(id=>spend.text.includes(id)),'no chat id in the notice');
    // The pause button: Alice's press in the group, and the owner's own press in the group, change nothing; the owner's
    // press in their private chat pauses, and the notice there says so.
    for(const [label,from,chat] of [['alice',ALICE,NG2_TG],['owner-in-group',Number(OWNER),NG2_TG]] as const) {
      await s.actionCommands.callback(await press(label,'njp',from,chat));
      assert.equal(last('answer').text,'Only the owner can do this.',label);assert.equal(await s.jobs.members.pause(),null,label);
    }
    await s.actionCommands.callback(await press('owner-pauses','njp',Number(OWNER),OWNER));
    assert.equal(last('answer').chat_id,OWNER);
    assert.equal((await s.jobs.members.pause())?.by,'owner');
    assert.deepEqual([notices.at(-1)!.chat_id,notices.at(-1)!.edit,notices.at(-1)!.id],[OWNER,true,spend.id]);
    await s.actionCommands.callback(await press('owner-resumes','nju',Number(OWNER),OWNER));
    assert.equal(await s.jobs.members.pause(),null);
    await s.jobs.halt(job.id);
    await stores.control.query("UPDATE managed_runs SET state='cancelled' WHERE event_id=$1",[current.event_id]);
    assert.equal((await tick(job.id)).state,'cancelled');
  } finally {
    await s.jobs.members.setPaused(false).catch(()=>{});
    await stores.close();await rm(root,{recursive:true,force:true});
  }
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest} from '../src/archive.js';
import {assistantPolicy} from '../src/assistant-policy.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {chatTitle,clipText,lateSettleMs} from '../src/stores/late-messages.js';
import {storageServices} from '../src/stores/services.js';
import {arrivedLate} from '../src/stores/telegram-dispatch.js';

test('a message is late only when it reached Nocheh more than the limit after Telegram says it was sent',()=>{
  const received=new Date('2026-11-10T08:00:00Z'),sent=(minutes:number)=>String(received.getTime()/1000-minutes*60);
  assert.equal(arrivedLate(sent(31),received,30),true);
  assert.equal(arrivedLate(sent(30),received,30),false,'exactly at the limit is still answered');
  assert.equal(arrivedLate(sent(600),received,0),false,'0 always answers');
  assert.equal(arrivedLate(sent(600),received,undefined),false,'a policy without the setting always answers');
  for(const value of [null,undefined,'','2026-11-10T00:00:00Z','-5','1.5'])assert.equal(arrivedLate(value as any,received,30),false,String(value));
});

test('the late limit reads TELEGRAM_LATE_MINUTES: 30 by default, 0 always answers, anything else stops startup',()=>{
  const saved=process.env.TELEGRAM_LATE_MINUTES;
  try {
    delete process.env.TELEGRAM_LATE_MINUTES;assert.equal(assistantPolicy().late_minutes,30);
    process.env.TELEGRAM_LATE_MINUTES='0';assert.equal(assistantPolicy().late_minutes,0);
    process.env.TELEGRAM_LATE_MINUTES='1440';assert.equal(assistantPolicy().late_minutes,1440);
    for(const value of ['1441','-1','30m',' ','1e3']) {
      process.env.TELEGRAM_LATE_MINUTES=value;assert.throws(()=>assistantPolicy(),/Invalid assistant policy/,value);
    }
  }finally{if(saved===undefined)delete process.env.TELEGRAM_LATE_MINUTES;else process.env.TELEGRAM_LATE_MINUTES=saved;}
});

test('the summary never splits a character and keeps how chat titles are written',()=>{
  assert.equal(clipText('short',10),'short');
  const clipped=clipText('ab'+'😀'.repeat(10),8);
  assert.ok(clipped.length<=8);assert.ok(clipped.endsWith('…'));
  assert.doesNotThrow(()=>Buffer.from(clipped,'utf16le').toString('utf16le'));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clipped),'no lone surrogate is left');
  assert.equal(chatTitle('تیم\u200cما\nدوم'),'تیم\u200cما دوم','a Persian non-joiner stays; a line break does not');
  assert.equal(chatTitle('\u{1F468}\u200d\u{1F469}\u200d\u{1F467} Family'),'\u{1F468}\u200d\u{1F469}\u200d\u{1F467} Family');
  assert.equal(chatTitle(' \n\t'),null);assert.equal(chatTitle(42),null);
});

test('messages Telegram delivers late are saved without a reply, still inform the next group reply, and reach the owner as one summary',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-late-')),base=Date.now(),group='-'+base,token=digest('late:'+base);
  const archiveAdmin=new pg.Pool({...config,database:'nocheh_archive'});
  const policy={enabled:true,owner_id:'123',group_ids:[group],group_access:{[group]:{granted:['9'],denied:[]}},late_minutes:30};
  const started:any[]=[],refusals:any[]=[],notices:any[]=[];let serial=base,telegram='connected',hold:string|null=null,silent:string|null=null;
  // Like the gateway: an unaddressed group message is not_addressed before it can be too_old.
  const runtime:Parameters<typeof storageServices>[1]['runtime']=async(operation,input)=>{
    if(operation==='guard.detect')return {literals:[]};
    if(operation==='telegram.refusal'){refusals.push(input);return {state:'done'};}
    if(operation==='telegram.notice'){notices.push(input);return telegram==='connected'?{state:'done'}:{state:'not_started',error_code:'telegram_not_connected'};}
    if(operation==='run.resume')return {state:'running'};
    assert.equal(operation,'run.start');started.push(input);
    if(input.event_id===hold)return {state:'running'};
    if(input.event_id===silent)return {state:'suppressed',error_code:'intentional_silence'};
    if(String(input.scope)!=='123'&&!String(input.text).startsWith('Nocheh'))return {state:'suppressed',error_code:'not_addressed'};
    if(input.late===true)return {state:'suppressed',error_code:'too_old'};
    return {state:'done',stage:'delivery'};
  };
  const services=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,runtime,honcho:async()=>{throw Error('no memory providers');}});
  const authority=(family:string)=>stores.control.query('SELECT epoch FROM workflow_owners WHERE family=$1',[family]).then(r=>({owner:'inngest' as const,epoch:Number(r.rows[0].epoch)}));
  const hours=(value:number)=>Math.floor(Date.now()/1000)-value*3600;
  const capture=async(scope:string,text:string,sent:number,from:any={id:123,is_bot:false,first_name:'Owner'},update=++serial)=>{
    const message={message_id:update,date:sent,chat:scope==='123'||!scope.startsWith('-')?{id:Number(scope),type:'private'}:{id:Number(scope),type:'supergroup',title:'Synthetic Team'},from,text};
    return (await services.capture.capture({version:1,key:`telegram:123456:update:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope,
      source_id:String(update),revision:'1',occurred_at:String(sent),text,payload:{update_id:update,message}})).source.reference.id;
  };
  const prepare=async(id:string)=>services.preparation.run(id,async()=>{throw Error('unexpected download');},'fixture',services.detect,await authority('preparation'));
  const run=async(id:string)=>services.telegram.run(id,await authority('telegram'));
  const say=async(scope:string,text:string,sent:number,from?:any)=>{const id=await capture(scope,text,sent,from);await prepare(id);await run(id);return id;};
  const row=(id:string)=>stores.control.query('SELECT state,error_code FROM dispatches WHERE event_id=$1',[id]).then(r=>r.rows[0]);
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    // The owner wrote while Nocheh was offline; Telegram delivers it six hours later.
    const old=await say('123','/actions',hours(6));
    assert.deepEqual(await row(old),{state:'suppressed',error_code:'too_old'});
    const oldStart=started.find(input=>input.event_id===old);
    assert.equal(oldStart.late,true,'the runtime is told the message is late');
    assert.equal(oldStart.control_reply,null,'an owner command in a late message never runs');
    // A message that arrived on time and is only retried late is still answered.
    const retried=await capture('123','Answer me when the model is back',hours(6));
    await archiveAdmin.query("UPDATE events SET received_at=now()-interval '6 hours' WHERE id=$1",[retried]);
    await prepare(retried);await run(retried);
    assert.deepEqual(await row(retried),{state:'done',error_code:null});
    assert.equal(started.at(-1).late,undefined);
    const fresh=await say('123','And now?',hours(0));
    assert.deepEqual(await row(fresh),{state:'done',error_code:null});assert.equal(started.at(-1).late,undefined);
    // The same owner command sent on time runs.
    await say('123','/actions',hours(0));
    assert.notEqual(started.at(-1).control_reply,null,'an owner command sent on time runs');

    // A stranger's late private message gets no fixed refusal; a fresh one does.
    await say('555','hello from earlier',hours(5),{id:555,is_bot:false,first_name:'Someone'});
    assert.equal(refusals.length,0);
    await say('556','hello now',hours(0),{id:556,is_bot:false,first_name:'Someone else'});
    assert.equal(refusals.length,1);

    // A group backlog, saved in reverse order: an addressed message, chatter, and one still open.
    serial+=4;
    const chatter=await capture(group,'Lunch at noon?',hours(3),{id:9,is_bot:false,first_name:'Sara'},serial-1);
    const asked=await capture(group,'Nocheh, book the room',hours(4),{id:9,is_bot:false,first_name:'Sara'},serial-2);
    const open=await capture(group,'Running late, start without me',hours(2),{id:9,is_bot:false,first_name:'Sara'},serial);
    for(const id of [chatter,asked,open])await prepare(id);
    await run(asked);await run(chatter);hold=open;await run(open);hold=null;
    assert.deepEqual(await row(asked),{state:'suppressed',error_code:'too_old'});
    assert.deepEqual(await row(chatter),{state:'suppressed',error_code:'not_addressed'},'chatter Nocheh would not answer anyway is not counted as skipped');
    assert.equal((await row(open)).state,'running');
    await say(group,'Nocheh, what did I miss?',hours(0),{id:9,is_bot:false,first_name:'Sara'});
    assert.deepEqual(started.at(-1).recent_group?.map((item:any)=>item.text),['Nocheh, book the room','Lunch at noon?','Running late, start without me'],
      'the next reply sees the late messages in the order they were sent, even one whose dispatch is still open');

    // One summary, after the backlog settles, and never twice.
    assert.equal(await services.lateMessages.notify(),0,'Telegram may still be delivering the backlog');assert.equal(notices.length,0);
    const later=Date.now()+lateSettleMs+1000;
    telegram='offline';
    assert.equal(await services.lateMessages.notify(later),0,'not connected: try again later');
    telegram='connected';
    assert.equal(await services.lateMessages.notify(later),2);
    assert.equal(notices.length,2);assert.equal(notices[0].id,notices[1].id,'a retry keeps the same notice ID');
    assert.equal(notices[1].chat_id,'123');
    assert.equal(notices[1].text,['Nocheh got these messages late, for example while it was offline, and saved them without answering:',
      '• Your private chat: 1','• Synthetic Team: 1','It answers only messages it gets within 30 minutes of sending.','Ask again if one still needs an answer.'].join('\n'));
    assert.equal(await services.lateMessages.notify(later),0);assert.equal(notices.length,2,'a sent summary is not repeated');

    // The owner's own wording; a new backlog gets its own summary.
    await stores.control.query(`UPDATE owner_prompts SET texts='{"telegram.late_messages":"Missed ({count}):\\n{chats}"}'::jsonb WHERE singleton`);
    await say('123','Another one from the night',hours(8));
    assert.equal(await services.lateMessages.notify(Date.now()+lateSettleMs+1000),1);
    assert.equal(notices.at(-1).text,'Missed (1):\n• Your private chat: 1');assert.notEqual(notices.at(-1).id,notices[0].id);

    // Late messages that keep coming still reach the owner once the oldest has waited long enough.
    const waited=await say('123','Still catching up',hours(7));
    await stores.control.query("UPDATE dispatches SET updated_at=now()-interval '11 minutes' WHERE event_id=$1",[waited]);
    await say('123','And more',hours(7));
    assert.equal(await services.lateMessages.notify(),2);assert.equal(notices.at(-1).text,'Missed (2):\n• Your private chat: 2');

    // Only chats Nocheh still serves are listed; with none left, nothing is sent then or later.
    await say(group,'Nocheh, one more from the night',hours(6),{id:9,is_bot:false,first_name:'Sara'});
    const sent=notices.length;policy.group_ids=[];
    assert.equal(await services.lateMessages.notify(Date.now()+lateSettleMs+1000),0);
    policy.group_ids=[group];
    assert.equal(await services.lateMessages.notify(Date.now()+lateSettleMs+1000),0);assert.equal(notices.length,sent);

    // With the limit at 0, every message is answered whenever it arrives.
    policy.late_minutes=0;
    const always=await say('123','Answer even this',hours(10));
    assert.deepEqual(await row(always),{state:'done',error_code:null});
    // A late message that had a turn then still ends the list of earlier messages after the limit is back.
    const sara={id:9,is_bot:false,first_name:'Sara'},quiet=await capture(group,'Nocheh, anything to add?',hours(5),sara);
    await prepare(quiet);silent=quiet;await run(quiet);silent=null;
    assert.deepEqual(await row(quiet),{state:'suppressed',error_code:'intentional_silence'});
    policy.late_minutes=30;
    await say(group,'Nocheh, and now?',hours(0),sara);
    assert.equal(started.at(-1).recent_group,undefined,'the turn that ran is already in the conversation');
  }finally{await archiveAdmin.end();await stores.close();await rm(root,{recursive:true,force:true});}
});

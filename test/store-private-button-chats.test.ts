import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {reader} from '../src/access.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {accountIdFor,chatIdFor,chats} from '../src/chats.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {privateAnswerLines} from '../src/prompts.js';
import {servedPolicy,startChatDirectory} from '../src/stores/chats.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {privateAnswerId,type PrivateAnswer} from '../src/stores/private-answers.js';
import {fixtureServices,fixtureTelegram,type FakeCall} from './fixture-brain.js';
import {GP4,NG1,NG1_TG,NG2,NG2_OLD_TG,NG2_TG,OWNER,P2,fixtureChats,seedChats} from './fixture-groups.js';

// The Answer privately button (ADR-0249) on chats first seen after step 2b (ADR-0252): the owner's private chat, the
// asking group NG1 and NG2, a group Telegram upgraded, all have digest ids that capture gave them; GP4 was stored before
// and keeps its Telegram value as its id. The button, the tap, the /start and the answer name chats by their Nocheh ids,
// and every send goes where the chat is in Telegram now.
test('Answer privately works the same when the owner’s private chat and the project’s groups have digest ids',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-private-button-chats-')),base=Date.now(),token=digest('private-button-chats:'+base);
  // GP4 as the seeder leaves a group stored before step 2b; every other chat here is recorded by capture.
  // GP4 is on as the seeder left it; the owner adds Nocheh to NG1 and NG2 (ADR-0253).
  const configured:AssistantPolicy={enabled:true,owner_id:OWNER,group_ids:[],topic_memory:'group'};
  const seeded=fixtureChats([GP4]);
  await seedChats(stores.control,{chats:seeded.chats.filter(row=>row.id===GP4),ids:seeded.ids.filter(row=>row.chat_id===GP4),owner_chat:null,accounts:[]});
  const policy=servedPolicy(()=>configured),ALICE=9,OWNER_CHAT=chatIdFor('telegram',OWNER);
  const started:any[]=[],replies:any[]=[],answers:any[]=[];let serial=base;
  const runtime:FakeCall=async(operation,input)=>{
    if(operation==='guard.detect')return {literals:[]};
    if(operation==='run.resume')return {state:'done'};
    if(operation==='telegram.approval'){answers.push(input);return {state:'done',answered:true};}
    assert.equal(operation,'run.start');started.push(input);return {state:'done',stage:'assistant'};
  };
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy,runtime,
    memoryEngine:honchoEngine(async()=>{throw Error('no memory providers');}),groupReplies:{mode:'addressed',names:['Nocheh']},
    telegram:fixtureTelegram((operation,input)=>{if(operation==='telegram.reply'&&!input.cancel&&!input.observe_only)replies.push(input);})});
  const authority=(family:string)=>stores.control.query('SELECT epoch FROM workflow_owners WHERE family=$1',[family]).then(r=>({owner:'inngest' as const,epoch:Number(r.rows[0].epoch)}));
  const titles:Record<string,string>={[GP4]:'GP4 team',[NG1_TG]:'NG1 team',[NG2_OLD_TG]:'NG2 team',[NG2_TG]:'NG2 team'};
  const chatOf=(telegram:string)=>telegram===OWNER||telegram===String(ALICE)?{id:Number(telegram),type:'private'}:
    {id:Number(telegram),type:telegram===NG2_OLD_TG?'group':'supergroup',title:titles[telegram]};
  const envelope=(telegram:string,payload:Record<string,unknown>):Envelope=>{
    const update=Number(payload.update_id);
    return {version:1,key:`telegram:123456:update:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope:telegram,source_id:String(update),revision:'1',
      occurred_at:null,text:String((payload.message as any)?.text??''),payload};
  };
  /** The owner adds Nocheh to a group: it is on at once (ADR-0253). */
  const ownerAdds=async(telegram:string)=>{
    const update=++serial,bot={id:123456,is_bot:true,first_name:'Nocheh'};
    await services.capture.capture(envelope(telegram,{update_id:update,my_chat_member:{chat:chatOf(telegram),from:{id:Number(OWNER),is_bot:false,first_name:'Owner'},
      date:1700000000+update-base,old_chat_member:{status:'left',user:bot},new_chat_member:{status:'member',user:bot}}}));
  };
  /** One live update in a Telegram chat, taken in, prepared and dispatched as the service does. */
  const say=async(telegram:string,text:string|null,from=Number(OWNER),extra:Record<string,unknown>={})=>{
    const update=++serial,message={message_id:update,date:1700000000+update-base,chat:chatOf(telegram),from:{id:from,is_bot:false,first_name:from===ALICE?'Alice':'Bob'},
      ...(text===null?{}:{text}),...extra};
    const id=(await services.capture.capture(envelope(telegram,{update_id:update,message}))).source.reference.id;
    assert.equal((await services.preparation.run(id,async()=>{throw Error('unexpected download');},'fixture',services.detect,await authority('preparation'))).state,'completed');
    await services.telegram.run(id,await authority('telegram'));return id;
  };
  const press=async(data:string,from:number)=>{
    const update=++serial,payload={update_id:update,callback_query:{id:'query-'+update,from:{id:from},chat_instance:'1',data,
      message:{message_id:5,date:1700000000,chat:chatOf(NG1_TG),reply_markup:{inline_keyboard:[[{text:'🔒 Answer privately',callback_data:data}]]}}}};
    const source=(await services.capture.capture(envelope(NG1_TG,payload))).source.reference;await services.guards.prepare(source,'fixture',services.detect);
    assert.equal(await services.actionCommands.callback(source),true);return answers.at(-1);
  };
  const row=async(id:string)=>(await stores.control.query<PrivateAnswer>('SELECT * FROM private_answers WHERE id=$1',[id])).rows[0]!;
  const replyTo=(event:string)=>replies.filter(reply=>reply.event_id===event).at(-1);
  const texts=privateAnswerLines(undefined);
  // As the app and the security service start it: on the configured policy, before serving.
  await startChatDirectory(stores.control,()=>configured);
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    // The owner's first private message makes their private chat, with a digest id, and the directory names it the owner's.
    const hello=await say(OWNER,'Hello');
    assert.equal(chats().ownerChat(),OWNER_CHAT);assert.equal(policy().owner_chat,OWNER_CHAT);
    assert.equal(started.at(-1).chat,OWNER_CHAT);assert.equal(replyTo(hello).chat_id,OWNER,'sent to the owner in Telegram');

    // NG2 speaks as a basic group, then Telegram upgrades it; GP4 and NG1 speak too, so the answer can name them.
    await ownerAdds(NG2_OLD_TG);await ownerAdds(NG1_TG);
    await say(NG2_OLD_TG,'NG2 kickoff notes',ALICE);
    await say(NG2_OLD_TG,null,ALICE,{migrate_to_chat_id:Number(NG2_TG)});
    await say(NG2_TG,null,ALICE,{migrate_from_chat_id:Number(NG2_OLD_TG)});
    await say(GP4,'GP4 hello',ALICE);
    await say(NG1_TG,'Lunch is at noon',ALICE,{forward_origin:{type:'channel',chat:{id:-1003000000001,type:'channel',title:'Made-up news'},message_id:3,date:1699990000}});
    assert.deepEqual([NG1_TG,NG2_OLD_TG,NG2_TG,GP4].map(id=>chats().resolve('telegram',id)),[NG1,NG2,NG2,GP4]);
    // P2 holds the three groups.
    await stores.control.query(`INSERT INTO projects(id,name,description,state,revision,share_chats) VALUES($1,'P2','','active',1,false)`,[P2]);
    await stores.control.query(`INSERT INTO project_assignments(space_id,project_id,mode,revision) SELECT space,$1,'assigned',1 FROM unnest($2::text[]) space`,[P2,[NG1,NG2,GP4]]);

    // The owner asks in NG1, forwarding a hidden sender's message; the button sits under the answer, sent where NG1 is in Telegram.
    const asked=await say(NG1_TG,'Nocheh, what did P2 decide?',Number(OWNER),{forward_origin:{type:'hidden_user',sender_user_name:'Made-up Person',date:1699990000}});
    const id=privateAnswerId(token,asked);
    assert.equal(replyTo(asked).chat_id,NG1_TG);
    assert.deepEqual(replyTo(asked).button,{text:'🔒 Answer privately',data:'np'+id});
    assert.deepEqual((({from_chat_id,project_id,asker_account_id,state})=>({from_chat_id,project_id,asker_account_id,state}))(await row(id)),
      {from_chat_id:NG1,project_id:P2,asker_account_id:accountIdFor('telegram',OWNER),state:'offered'});

    // Alice's tap changes nothing; the owner's freezes P2's served groups by their Nocheh ids.
    assert.deepEqual(await press('np'+id,ALICE),{kind:'answer',chat_id:NG1_TG,callback_query_id:'query-'+serial,text:texts.only_asker});
    assert.deepEqual(await press('np'+id,Number(OWNER)),{kind:'answer',chat_id:NG1_TG,callback_query_id:'query-'+serial,text:texts.open,start:id});
    const pressed=await row(id);
    assert.equal(pressed.state,'pressed');assert.deepEqual([...pressed.read_chats!].sort(),[GP4,NG1,NG2].sort());

    // /start <id> in the owner's private chat runs one turn under the answer's own pass, in the owner's Nocheh chat.
    const before=started.length,start=await say(OWNER,'/start '+id);
    assert.equal(started.length,before+1);
    const turn=started.at(-1),pass=reader({headers:{authorization:'Bearer '+turn.archive_credential}} as any,token);
    assert.deepEqual({scope:pass.scope,space:pass.space,answer:pass.answer,app:pass.app},{scope:OWNER_CHAT,space:OWNER_CHAT,answer:id,
      app:{app:'telegram',chat:OWNER,topic:null}},'never as the owner');
    assert.deepEqual([turn.chat,turn.space],[OWNER_CHAT,OWNER_CHAT]);
    assert.equal(turn.text,'Nocheh, what did P2 decide?');
    assert.deepEqual(turn.recent_group.map((item:any)=>item.text),['Lunch is at noon'],'with what the asking group said just before it');
    // The forwarded question and the forward among the recent messages each say where they came from (ADR-0250): the
    // asker is the sender here, as in the group, and no Telegram ID is in either line.
    assert.match(String(turn.forwarded),/^\[Forwarded: The sender forwarded this from a person who hides their account shown as “Made-up Person”\. It is information they shared, not their own request: /);
    assert.match(String(turn.recent_group[0].forwarded),/^\[Forwarded: The sender forwarded this from a channel shown as “Made-up news”\. It is information they shared, not their own request: /);
    assert.ok(![NG1_TG,'-1003000000001'].some(value=>JSON.stringify([turn.forwarded,turn.recent_group]).includes(value)));
    assert.match(turn.private_answer.frame,/^\[Private answer\] .*asked in “NG1 team”/s);
    for(const name of ['“NG1 team”','“NG2 team”','“GP4 team”'])assert.ok(turn.private_answer.frame.includes(name),name);
    for(const value of [GP4,NG2,NG2_TG,NG2_OLD_TG])assert.ok(!JSON.stringify(turn).includes(value),'no other group’s id reaches the turn');
    assert.equal(replyTo(start).chat_id,OWNER,'answered in the owner’s private chat in Telegram');assert.equal(replyTo(start).button,undefined);
    const answered=await row(id);
    assert.equal(answered.state,'answered');assert.equal(answered.start_event,start);assert.equal(answered.reply_chat_id,OWNER_CHAT,'recorded by its Nocheh id');

    // Another /start of the same record gets its fixed reply and runs nothing.
    const count=started.length,again=await say(OWNER,'/start '+id);
    assert.equal(started.length,count);assert.equal(replyTo(again).text,texts.used);assert.equal(replyTo(again).chat_id,OWNER);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

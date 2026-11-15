import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {reader} from '../src/access.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {chats,installChats} from '../src/chats.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {servedPolicy,startChatDirectory} from '../src/stores/chats.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {fixtureServices,fixtureTelegram,type FakeCall} from './fixture-brain.js';
import {GP_GROUP_IDS,NG1,NG1_TG,NG1_TOPIC,NG1_TOPIC_KEY,NG2,NG2_OLD_TG,NG2_TG,OWNER} from './fixture-groups.js';

// Dispatch on chats first seen after step 2b (ADR-0251), as the running service has them: capture records each chat and
// this process's directory reloads, so no chat here is seeded. NG2 is served by the Telegram id the owner configured
// before Telegram upgraded it; its turns read what was said under either id, and every reply goes where the chat or
// topic is in Telegram now.
test('a group Telegram upgraded and a forum topic first seen after step 2b are answered as their own chats, where they are now',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-dispatch-chats-')),base=Date.now(),token=digest('dispatch-chats:'+base);
  // TELEGRAM_GROUP_IDS names NG2 by the id it had before the upgrade; the service serves as servedPolicy says.
  const configured:AssistantPolicy={enabled:true,owner_id:OWNER,group_ids:[...GP_GROUP_IDS,NG1_TG,NG2_OLD_TG],group_access:{},topic_memory:'group'};
  const policy=servedPolicy(()=>configured),ALICE=9;
  const started:any[]=[],replies:any[]=[];let serial=base;
  const runtime:FakeCall=async(operation,input)=>{
    if(operation==='guard.detect')return {literals:[]};
    if(operation==='run.resume')return {state:'done'};
    assert.equal(operation,'run.start');started.push(input);return {state:'done',stage:'assistant'};
  };
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy,runtime,
    memoryEngine:honchoEngine(async()=>{throw Error('no memory providers');}),groupReplies:{mode:'addressed',names:['Nocheh']},
    telegram:fixtureTelegram((operation,input)=>{if(operation==='telegram.reply'&&!input.cancel&&!input.observe_only)replies.push(input);})});
  const authority=(family:string)=>stores.control.query('SELECT epoch FROM workflow_owners WHERE family=$1',[family]).then(r=>({owner:'inngest' as const,epoch:Number(r.rows[0].epoch)}));
  const chatOf=(telegram:string)=>telegram===NG2_OLD_TG?{id:Number(telegram),type:'group',title:'NG2 team'}:
    telegram===NG2_TG?{id:Number(telegram),type:'supergroup',title:'NG2 team'}:{id:Number(telegram),type:'supergroup',title:'NG1 team',is_forum:true};
  /** One live update in a Telegram chat, taken in, prepared and dispatched as the service does. */
  const say=async(telegram:string,text:string|null,from=Number(OWNER),extra:Record<string,unknown>={})=>{
    const update=++serial,message={message_id:update,date:1700000000+update-base,chat:chatOf(telegram),from:{id:from,is_bot:false,first_name:from===ALICE?'Alice':'Bob'},
      ...(text===null?{}:{text}),...extra};
    const id=(await services.capture.capture({version:1,key:`telegram:123456:update:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope:telegram,
      source_id:String(update),revision:'1',occurred_at:null,text,payload:{update_id:update,message}} as Envelope)).source.reference.id;
    assert.equal((await services.preparation.run(id,async()=>{throw Error('unexpected download');},'fixture',services.detect,await authority('preparation'))).state,'completed');
    await services.telegram.run(id,await authority('telegram'));return id;
  };
  const turnOf=(event:string)=>started.find(turn=>turn.event_id===event);
  const replyTo=(event:string)=>replies.filter(reply=>reply.event_id===event).at(-1);
  const pass=(turn:any)=>reader({headers:{authorization:'Bearer '+turn.archive_credential}} as any,token);
  // As the app and the security service start it: on the configured policy, before serving.
  await startChatDirectory(stores.control,()=>configured);
  try {
    await services.guards.reconcile();await services.guards.setMode('on');

    // NG2 is a basic group: its first message makes its chat, named from that first Telegram id.
    await say(NG2_OLD_TG,'Lunch is at noon',ALICE);
    assert.equal(chats().resolve('telegram',NG2_OLD_TG),NG2);assert.ok(chats().served(NG2));
    const before=await say(NG2_OLD_TG,'Nocheh, who is coming?');
    assert.deepEqual([turnOf(before).chat,turnOf(before).space,turnOf(before).app],[NG2,NG2,{app:'telegram',chat:NG2_OLD_TG,topic:null}]);
    assert.deepEqual(turnOf(before).recent_group.map((item:any)=>item.text),['Lunch is at noon']);
    assert.equal(replyTo(before).chat_id,NG2_OLD_TG);
    await say(NG2_OLD_TG,'Count me in',ALICE);

    // Telegram upgrades it: the old chat says where it went, the new one where it came from. One chat, two ids.
    const beforeUpgrade=chats();
    await say(NG2_OLD_TG,null,ALICE,{migrate_to_chat_id:Number(NG2_TG)});
    await say(NG2_TG,null,ALICE,{migrate_from_chat_id:Number(NG2_OLD_TG)});
    assert.equal(chats().resolve('telegram',NG2_TG),NG2,'the new id names the same chat');
    assert.deepEqual(chats().appIds(NG2),{app:'telegram',chat:NG2_TG,topic:null,old:[NG2_OLD_TG]});
    assert.ok(chats().served(NG2),'still served, though TELEGRAM_GROUP_IDS names only its old id');
    assert.ok(policy().group_ids.includes(NG2_TG),'the served policy holds every id the group has had');

    // Under its new id, the group's turn sees what was said under the old one, and is answered where the group is now.
    await say(NG2_TG,'Pizza again?',ALICE);
    const after=await say(NG2_TG,'Nocheh, what did we decide?'),turn=turnOf(after);
    assert.ok(turn,'the upgraded group is answered');
    assert.deepEqual([turn.chat,turn.space,turn.app],[NG2,NG2,{app:'telegram',chat:NG2_TG,topic:null}]);
    assert.deepEqual(turn.recent_group.map((item:any)=>item.text).filter((text:string)=>text!=='[A message without text]'),['Count me in','Pizza again?'],
      'the lines since the last turn, under either id');
    assert.ok(!JSON.stringify(turn.recent_group).includes(NG2_OLD_TG)&&!JSON.stringify(turn.recent_group).includes(NG2_TG),'no Telegram ID in them');
    const ng2=pass(turn);
    assert.deepEqual([ng2.scope,ng2.space,ng2.app],[NG2,NG2,{app:'telegram',chat:NG2_TG,topic:null}],'the pass names the Nocheh chat and where it is now');
    // The security service binds this turn with its own directory, which may still be the one from before the upgrade:
    // it reads the turn once that directory has looked again, never refusing it as a chat it does not know.
    // Nothing here looks the new id up first: a lookup that misses would start a reload of its own.
    installChats(beforeUpgrade);
    assert.equal(chats(),beforeUpgrade,'a directory from before the upgrade');
    assert.equal((await services.turns.binding(ng2)).scope,NG2,'the upgraded group\'s turn is bound');
    assert.equal(chats().resolve('telegram',NG2_TG),NG2,'after the directory looked again');
    assert.equal(replyTo(after).chat_id,NG2_TG);assert.equal(replyTo(after).topic,undefined);

    // NG1 is a forum: a topic message makes the group and its topic, and its turn is the topic's.
    const topic=await say(NG1_TG,'Nocheh, plans for this topic?',Number(OWNER),{message_thread_id:Number(NG1_TOPIC_KEY),is_topic_message:true});
    assert.equal(chats().resolve('telegram',NG1_TG),NG1);assert.equal(chats().resolve('telegram',NG1_TG,NG1_TOPIC_KEY),NG1_TOPIC);
    const inTopic=turnOf(topic);
    assert.deepEqual([inTopic.chat,inTopic.space,inTopic.app],[NG1,NG1_TOPIC,{app:'telegram',chat:NG1_TG,topic:NG1_TOPIC_KEY}]);
    const topicPass=pass(inTopic);
    assert.deepEqual([topicPass.scope,topicPass.space,topicPass.app],[NG1,NG1_TOPIC,{app:'telegram',chat:NG1_TG,topic:NG1_TOPIC_KEY}]);
    assert.deepEqual([replyTo(topic).chat_id,replyTo(topic).topic],[NG1_TG,Number(NG1_TOPIC_KEY)],'answered in its topic');
    const general=await say(NG1_TG,'Nocheh, and for the whole group?');
    assert.deepEqual([turnOf(general).chat,turnOf(general).space],[NG1,NG1]);
    assert.deepEqual([replyTo(general).chat_id,replyTo(general).topic],[NG1_TG,undefined]);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

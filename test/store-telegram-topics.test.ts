import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {fixtureServices} from './fixture-brain.js';
import {topicReference} from '../src/stores/telegram-topics.js';
import {chatIdFor} from '../src/chats.js';
import {GP1,GP1_TOPIC,GP1_TOPIC_KEY,NG1,groupsPolicy,seedChats} from './fixture-groups.js';
import {honchoEngine} from '../src/memory/honcho.js';

test('topic links and ids name a group and a topic, and malformed references are rejected',()=>{
  assert.deepEqual(topicReference({link:'https://t.me/c/5550001234/12'}),{chat:'-1005550001234',topic_id:12,link:true});
  assert.deepEqual(topicReference({link:'t.me/c/5550001234/14/250'}),{chat:'-1005550001234',topic_id:14,link:true},'a message link inside a topic names its topic');
  assert.deepEqual(topicReference({chat_id:GP1,topic_id:31}),{chat:GP1,topic_id:31,link:false});
  assert.deepEqual(topicReference({chat_id:NG1,topic_id:31}),{chat:NG1,topic_id:31,link:false},'a group is named by its Nocheh id, whatever its shape');
  for(const bad of [{link:'https://t.me/somepublicgroup/12'},{link:'https://example.com/c/1/2'},{link:'https://t.me/c/5550001234'},{chat_id:'group',topic_id:3},
    {chat_id:GP1,topic_id:1},{chat_id:NG1,topic_id:2147483648}])
    assert.throws(()=>topicReference(bad),/invalid_topic/);
});

test('owner-added topics, topic lifecycle messages and observed names form one topic directory, in both chat id families',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-telegram-topics-')),base=Date.now(),group='-100'+base,owner:Reader={admin:true,scope:null};
  // A group first seen now gets a digest id; GP1 was stored before step 2b and keeps its Telegram id.
  const policy={...groupsPolicy(),group_ids:[GP1,group]};
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>policy,runtime:async()=>({literals:[]}),memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  let serial=0;
  const capture=async(topic:number,extra:Record<string,unknown>)=>{const id=++serial;await s.capture.capture({version:1,key:'topics:'+base+':'+id,origin:'live',kind:'telegram_update',
    bot_id:'topics',scope:group,source_id:String(id),revision:'1',occurred_at:null,text:null,payload:{update_id:base*10+id,message:{message_id:id,date:id,
      chat:{id:Number(group),type:'supergroup',title:'Forum',is_forum:true},from:{id:123},message_thread_id:topic,is_topic_message:true,...extra}}} as Envelope);};
  const topics=async(parent:string)=>{
    const items=[];let after='';
    for(;;){const page=await s.supervision.conversations(owner,{limit:100,after});items.push(...page.items);if(!page.next_cursor)break;after=page.next_cursor;}
    return Object.fromEntries(items.filter(item=>item.kind==='topic'&&item.parent_space===parent).map(item=>[item.topic_key!,item]));
  };
  try {
    await seedChats(stores.control);
    await s.guards.reconcile();await s.configuration.configure(policy,'on');
    await capture(5,{forum_topic_created:{name:'Created with no messages',icon_color:7322096}});
    await capture(6,{forum_topic_created:{name:'Closed later',icon_color:7322096}});await capture(6,{forum_topic_closed:{}});
    await capture(7,{forum_topic_created:{name:'Reopened',icon_color:7322096}});await capture(7,{forum_topic_closed:{}});await capture(7,{forum_topic_reopened:{}});
    const id=(await stores.control.query(`SELECT chat_id FROM chat_ids WHERE external_id=$1`,[group])).rows[0]?.chat_id;
    assert.equal(id,chatIdFor('telegram',group),'a group first seen after step 2b has a digest id');
    await assert.rejects(s.telegramTopics.change({admin:false,scope:null},{action:'add',chat_id:id,topic_id:9,name:'x'}),{status:403});
    await s.telegramTopics.change(owner,{action:'add',chat_id:id,topic_id:9,name:'Old empty topic'});
    await s.telegramTopics.change(owner,{action:'add',chat_id:group,topic_id:5,name:'Owner label'});
    await assert.rejects(s.telegramTopics.change(owner,{action:'add',chat_id:id,topic_id:10,name:'  '}),{code:'topic_name_required'});
    await assert.rejects(s.telegramTopics.change(owner,{action:'add',chat_id:'-100'+(base+1),topic_id:3,name:'Unknown group'}),{code:'chat_not_found'});
    let found=await topics(id);
    assert.equal(found['5']?.space_id,chatIdFor('telegram',group,'5'));
    assert.equal(found['5']?.name,'Owner label','the owner\'s own name for a topic is the one shown');assert.equal(found['5']?.registered,true);
    assert.equal(found['6']?.closed,true);assert.equal(found['7']?.closed,false,'the latest lifecycle message decides');
    assert.equal(found['6']?.name,'Closed later','a captured creation names a topic without any ordinary message');
    assert.deepEqual([found['9']?.name,found['9']?.registered,found['9']?.observed_at],['Old empty topic',true,null],'an owner-added topic is listed');
    // A topic Telegram names later keeps the owner's name.
    await capture(9,{forum_topic_edited:{name:'Telegram name'}});
    assert.equal((await topics(id))['9']?.name,'Old empty topic');
    await s.telegramTopics.change(owner,{action:'add',link:'https://t.me/c/'+group.slice(4)+'/9',name:'Renamed by owner'});
    assert.equal((await topics(id))['9']?.name,'Renamed by owner');
    // Removing the owner's name goes back to what Telegram showed; a topic never seen leaves the list.
    await s.telegramTopics.change(owner,{action:'remove',chat_id:id,topic_id:9});
    await s.telegramTopics.change(owner,{action:'add',chat_id:id,topic_id:11,name:'Never seen'});
    await s.telegramTopics.change(owner,{action:'remove',chat_id:id,topic_id:11});
    found=await topics(id);
    assert.equal(found['9']?.name,'Telegram name');assert.equal(found['9']?.registered,undefined);assert.equal(found['11'],undefined);
    await s.telegramTopics.change(owner,{action:'remove',chat_id:id,topic_id:5});
    assert.equal((await topics(id))['5']?.name,'Created with no messages');
    // An old-shaped group: its known topic keeps its id, a new one gets a digest id; both list under GP1.
    await s.telegramTopics.change(owner,{action:'add',link:'https://t.me/c/'+GP1.slice(4)+'/'+GP1_TOPIC_KEY,name:'Old topic'});
    await s.telegramTopics.change(owner,{action:'add',chat_id:GP1,topic_id:12,name:'New topic of an old group'});
    found=await topics(GP1);
    assert.equal(found[GP1_TOPIC_KEY]?.space_id,GP1_TOPIC);assert.equal(found[GP1_TOPIC_KEY]?.name,'Old topic');
    assert.equal(found['12']?.space_id,chatIdFor('telegram',GP1,'12'));assert.equal(found['12']?.parent_name,'GP1');
    const listed=(await s.telegramTopics.list(owner)).topics.filter(topic=>topic.chat_id===GP1).map(topic=>[topic.topic_id,topic.space_id,topic.name]);
    assert.deepEqual(listed,[[7,GP1_TOPIC,'Old topic'],[12,chatIdFor('telegram',GP1,'12'),'New topic of an old group']]);
    // The frozen table is never written.
    assert.equal(Number((await stores.control.query('SELECT count(*) FROM telegram_topic_registrations')).rows[0].count),0);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

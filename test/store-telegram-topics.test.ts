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
import {topicReference} from '../src/stores/telegram-topics.js';

test('topic links resolve to the forum chat and topic, and malformed references are rejected',()=>{
  assert.deepEqual(topicReference({link:'https://t.me/c/5550001234/12'}),{chat_id:'-1005550001234',topic_id:12});
  assert.deepEqual(topicReference({link:'t.me/c/5550001234/14/250'}),{chat_id:'-1005550001234',topic_id:14},'a message link inside a topic names its topic');
  assert.deepEqual(topicReference({chat_id:'-1005550001234',topic_id:31}),{chat_id:'-1005550001234',topic_id:31});
  for(const bad of [{link:'https://t.me/somepublicgroup/12'},{link:'https://example.com/c/1/2'},{chat_id:'-5550009876',topic_id:3},{chat_id:'-1005550001234',topic_id:1}])
    assert.throws(()=>topicReference(bad),/invalid_topic/);
});

test('owner-added topics, topic lifecycle messages and observed names form one topic directory',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-telegram-topics-')),base=Date.now(),group='-100'+base,owner:Reader={admin:true,scope:null};
  const policy={enabled:true,owner_id:'123',group_ids:[group]};
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>policy,runtime:async()=>({literals:[]}),honcho:async()=>{throw Error('no memory provider');}});
  let serial=0;
  const capture=async(topic:number,extra:Record<string,unknown>)=>{const id=++serial;await s.capture.capture({version:1,key:'topics:'+base+':'+id,origin:'live',kind:'telegram_update',
    bot_id:'topics',scope:group,source_id:String(id),revision:'1',occurred_at:null,text:null,payload:{update_id:id,message:{message_id:id,date:id,
      chat:{id:Number(group),type:'supergroup',title:'Forum',is_forum:true},from:{id:123},message_thread_id:topic,is_topic_message:true,...extra}}} as Envelope);};
  const topics=async()=>Object.fromEntries((await s.supervision.conversations(owner,{q:group,after:'',limit:100})).items
    .filter(item=>item.kind==='topic').map(item=>[item.space_id.split('/topic/')[1],item]));
  try {
    await s.guards.reconcile();await s.configuration.configure(policy,'on');
    await capture(5,{forum_topic_created:{name:'Created with no messages',icon_color:7322096}});
    await capture(6,{forum_topic_created:{name:'Closed later',icon_color:7322096}});await capture(6,{forum_topic_closed:{}});
    await capture(7,{forum_topic_created:{name:'Reopened',icon_color:7322096}});await capture(7,{forum_topic_closed:{}});await capture(7,{forum_topic_reopened:{}});
    await assert.rejects(s.telegramTopics.change({admin:false,scope:null},{action:'add',chat_id:group,topic_id:9,name:'x'}),{status:403});
    await s.telegramTopics.change(owner,{action:'add',chat_id:group,topic_id:9,name:'Old empty topic'});
    await s.telegramTopics.change(owner,{action:'add',chat_id:group,topic_id:5,name:'Owner label'});
    await assert.rejects(s.telegramTopics.change(owner,{action:'add',chat_id:group,topic_id:10,name:'  '}),{code:'topic_name_required'});
    let found=await topics();
    assert.equal(found['5']?.name,'Created with no messages','a captured creation names a topic without any ordinary message, ahead of a registration');
    assert.equal(found['6']?.closed,true);assert.equal(found['7']?.closed,false,'the latest lifecycle message decides');
    assert.deepEqual([found['9']?.name,found['9']?.registered,found['9']?.observed_at],['Old empty topic',true,null],'an owner-added topic is listed');
    await s.telegramTopics.change(owner,{action:'add',link:'https://t.me/c/'+group.slice(4)+'/9',name:'Renamed by owner'});
    assert.equal((await topics())['9']?.name,'Renamed by owner');
    await s.telegramTopics.change(owner,{action:'remove',chat_id:group,topic_id:9});
    found=await topics();assert.equal(found['9'],undefined);assert.equal(found['5']?.registered,true);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

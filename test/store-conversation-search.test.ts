import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest} from '../src/archive.js';
import type {Settings} from '../src/config.js';
import {installChatsForTest} from '../src/chats.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServer} from '../src/stores/server.js';
import {fixtureServices} from './fixture-agent.js';
import {GP1,GP1_TOPIC,GP2,GP_GROUP_IDS,NG1,NG1_TG,NG1_TOPIC,NG2,NG2_OLD_TG,NG2_TG,NG_GROUP_IDS,OWNER,fixtureChats,fixtureDirectory,seedChats} from './fixture-groups.js';

// The owner's chat search on the real chat records (ADR-0252): a chat is found by any Telegram ID it has had, current
// or old, in both id families, and a topic is found with its group; a digest id is never shown as a Telegram ID.
test('GET /v1/conversations?q finds a chat by any Telegram ID it has had, with its topics, in both id families',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-conversation-search-')),token=digest('conversation-search:'+Date.now());
  const groupIds=[...GP_GROUP_IDS,...NG_GROUP_IDS],policy={enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:groupIds};
  const restore=installChatsForTest(fixtureDirectory(groupIds));
  const runtime=async()=>{throw Error('the chat search calls nothing');};
  const s=fixtureServices(stores,{dataDir:root,serviceToken:token,detectorVersion:'fixture',policy:()=>policy,runtime,memoryEngine:honchoEngine(runtime as any)});
  const settings:Settings={service:'nocheh-app',host:'127.0.0.1',port:0,token,agentKey:digest('agent:'+token),databasePassword:'',storageLayout:'original-only-v1',dataDir:root,
    hermesUrl:'http://fixture',telegramUrl:'http://fixture',honchoUrl:'http://fixture',honchoEnabled:false,memoryToken:'',guardMode:'on',detectorVersion:'fixture',assistant:policy};
  const server=storageServer(s,settings,runtime as any);
  try {
    await s.guards.reconcile();await s.configuration.configure(policy,'on');
    // The chat records as the seeder and capture leave them: GP1 and its topic keep their Telegram values as their ids;
    // NG1, its topic and NG2 (upgraded from NG2_OLD_TG to NG2_TG) were first seen after step 2b. Both topics have had a
    // message, so the directory lists them.
    await seedChats(stores.control,fixtureChats(groupIds));
    for(const topic of [GP1_TOPIC,NG1_TOPIC])await stores.control.query(`INSERT INTO chat_details(chat_id,seen_at) VALUES($1,now())
      ON CONFLICT(chat_id) DO UPDATE SET seen_at=now()`,[topic]);
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();assert.ok(address&&typeof address==='object');
    const search=async(q:string)=>{
      const response=await fetch(`http://127.0.0.1:${address.port}/v1/conversations?limit=100&q=${encodeURIComponent(q)}`,{headers:{authorization:'Bearer '+token}});
      const value=await response.json() as any;assert.equal(response.status,200,JSON.stringify(value));return value.items as any[];
    };
    const ids=async(q:string)=>(await search(q)).map(item=>item.space_id).sort();
    assert.deepEqual(await ids(NG1_TG),[NG1,NG1_TOPIC].sort(),'a group first seen after step 2b, by its Telegram ID, with its topic');
    assert.deepEqual(await ids(NG2_TG),[NG2],'an upgraded group by its new Telegram ID');
    assert.deepEqual(await ids(NG2_OLD_TG),[NG2],'and by the one it had before the upgrade');
    assert.deepEqual(await ids(GP1),[GP1,GP1_TOPIC].sort(),'a chat stored before step 2b, by the Telegram ID that is also its id');
    assert.deepEqual(await ids(NG1),[NG1],'the Nocheh id still finds its chat');
    const [ng2]=await search(NG2_OLD_TG),[topic]=(await search(NG1_TG)).filter(item=>item.space_id===NG1_TOPIC);
    assert.deepEqual(ng2.app_ids,[{app:'telegram',external:NG2_TG,state:'current'},{app:'telegram',external:NG2_OLD_TG,state:'old'}],'current Telegram ID first');
    assert.deepEqual([topic.kind,topic.parent_space,topic.topic_key,topic.app_ids],[ 'topic',NG1,'7',[{app:'telegram',external:NG1_TG,state:'current'}]]);
    assert.ok((await search(NG1_TG)).every(item=>item.app_ids.every((label:any)=>!/^[a-f0-9]{64}$/.test(label.external))),'a digest is never an app id');
    assert.deepEqual(await ids(GP2+'9'),[],'no partial id of another chat');
  }finally{server.close();restore();await stores.close();await rm(root,{recursive:true,force:true});}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {installChatsForTest} from '../src/chats.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServer} from '../src/stores/server.js';
import {fixtureServices} from './fixture-brain.js';
import {BOB,GP1,MEMBER_GP,MEMBER_NG,NG1_TG,OWNER,fixtureDirectory,GP_GROUP_IDS,NG_GROUP_IDS} from './fixture-groups.js';

/*
 * Step 4: the dashboard's Messages list (GET /v1/data and /v1/search, admin only) leaves out the private chats of people
 * other than the owner when it asks with private_chats=hide, and shows only them with private_chats=only (its "Members'
 * chats" filter), so a member's chat never shows when the owner shares their screen. Both fixture families: MEMBER_GP's
 * chat keeps its stored value as its id, MEMBER_NG's is named through chat_ids.
 */
test('the Messages list keeps members\' and strangers\' private chats under their own filter',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();
  try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-member-messages-')),run=Date.now(),key='member-messages:'+run;
  const policy:AssistantPolicy={enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:[GP1],topic_memory:'group'};
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>policy,
    runtime:async()=>({literals:[]}),memoryEngine:honchoEngine(async()=>{throw Error('no provider');})});
  const restore=installChatsForTest(fixtureDirectory([...GP_GROUP_IDS,...NG_GROUP_IDS]));
  const token=digest('member-messages-token:'+run);
  const server=storageServer(s,{token,dataDir:root} as Parameters<typeof storageServer>[1],async()=>({}));
  try {
    let serial=0;
    const word='Quillmark'+run;
    const capture=async(scope:string,from:string,label:string)=>{
      const update=++serial,text=`${word} ${label}`;
      const value={version:1,key:`${key}:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope,source_id:String(update),
        revision:String(update),occurred_at:String(1762179120+update),text,
        payload:{update_id:update,message:{message_id:update,date:1762179120+update,chat:{id:Number(scope),type:Number(scope)<0?'supergroup':'private'},
          from:{id:Number(from),is_bot:false,first_name:label},text}}} as Envelope;
      await s.capture.capture(value);return text;
    };
    const owner=await capture(OWNER,OWNER,'owner'),group=await capture(GP1,MEMBER_GP,'group'),ngGroup=await capture(NG1_TG,MEMBER_NG,'ng-group');
    const memberGp=await capture(MEMBER_GP,MEMBER_GP,'member-gp'),memberNg=await capture(MEMBER_NG,MEMBER_NG,'member-ng'),stranger=await capture(BOB,BOB,'stranger');
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();assert.ok(address&&typeof address==='object');
    const get=async(path:string,status=200):Promise<any>=>{const response=await fetch(`http://127.0.0.1:${address.port}${path}`,{headers:{authorization:'Bearer '+token}});
      assert.equal(response.status,status,path);return response.json();};
    const texts=(rows:any[])=>rows.map(row=>row.text).filter((text:unknown)=>typeof text==='string'&&text.startsWith(word)).sort();
    const listed=async(query:string)=>texts((await get('/v1/data?'+query)).records);
    assert.deepEqual(await listed('private_chats=hide'),[group,ngGroup,owner].sort(),'the default list holds the owner and the groups only');
    assert.deepEqual(await listed('private_chats=only'),[memberGp,memberNg,stranger].sort(),'"Members\' chats" holds the other private chats');
    assert.deepEqual(await listed(''),[group,ngGroup,owner,memberGp,memberNg,stranger].sort(),'without the filter nothing changes');
    assert.deepEqual(await listed('private_chats=hide&scope='+MEMBER_GP),[],'a chosen chat still obeys the split');
    assert.deepEqual(await listed('scope='+MEMBER_GP),[memberGp],'one member\'s chat by itself');
    await get('/v1/data?private_chats=members',400);
    // Search obeys the same split.
    const searched=await get('/v1/search?q='+encodeURIComponent(word)+'&private_chats=hide');
    const hits=Array.isArray(searched)?searched:searched.results??searched.hits??[];
    assert.deepEqual(texts(hits),[group,ngGroup,owner].sort());
    const only=await get('/v1/search?q='+encodeURIComponent(word)+'&private_chats=only');
    assert.deepEqual(texts(Array.isArray(only)?only:only.results??only.hits??[]),[memberGp,memberNg,stranger].sort());
  } finally {
    restore();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await Promise.all([stores.archive.end(),stores.derived.end(),stores.control.end()]);
    await rm(root,{recursive:true,force:true});
  }
});

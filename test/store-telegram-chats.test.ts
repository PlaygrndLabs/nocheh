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
import {honchoEngine} from '../src/memory/honcho.js';
import {chatIdFor} from '../src/chats.js';
import {ChatSeeder} from '../src/stores/chat-seed.js';
import type {ConversationDirectoryItem} from '../src/stores/owner-supervision.js';

test('an explicit owner refresh names selected groups from Telegram, follows an upgrade, and directory reads never call it',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-telegram-chats-')),base=Date.now();
  const observed='-100'+base,silent='-'+(base%1000000000+7),moved='-'+(base%1000000000+8),missing='-'+(base%1000000000+9),upgraded='-100'+(base+1),owner:Reader={admin:true,scope:null};
  const calls:string[]=[],policy={enabled:true,owner_id:'123',group_ids:[observed,silent,moved,missing]};
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      assert.equal(operation,'telegram.chat');const id=String(input.chat_id);calls.push(id);
      if(id===moved)return {chat_id:id,state:'migrated',migrate_to_chat_id:upgraded};
      if(id===missing)return {chat_id:id,state:'not_member'};
      return {chat_id:id,state:'available',type:'supergroup',title:id===silent?'Quiet group':'Telegram title',username:id===upgraded?'upgraded_group':null,is_forum:true};
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  try {
    await s.guards.reconcile();await s.configuration.configure(policy,'on');
    const event:Envelope={version:1,key:'chats:'+base,origin:'live',kind:'telegram_update',bot_id:'chats',scope:observed,source_id:'1',revision:'1',occurred_at:null,text:'hi',
      payload:{update_id:1,message:{message_id:1,date:1,chat:{id:Number(observed),type:'supergroup',title:'Captured title'},from:{id:123},text:'hi'}}};
    await s.capture.capture(event);
    // The groups only TELEGRAM_GROUP_IDS names get their rows at app start, served by the 2b-1 bridge.
    await new ChatSeeder(stores,policy).seed();await s.chats.serve(policy);
    const ids=new Map((await stores.control.query('SELECT external_id,chat_id FROM chat_ids WHERE external_id=ANY($1::text[])',[policy.group_ids])).rows
      .map(row=>[row.external_id as string,row.chat_id as string])),chat=(external:string)=>ids.get(external)!;
    assert.equal(chat(observed),chatIdFor('telegram',observed),'a group first seen after step 2b has a digest id');
    const before=await s.supervision.conversations(owner,{q:'',after:'',limit:100});
    assert.equal(before.items.find(item=>item.space_id===chat(silent))?.name,null);assert.equal(calls.length,0,'directory reads never call Telegram');
    await assert.rejects(s.telegramChats.refresh({admin:false,scope:null}),{status:403});
    const refreshed=await s.telegramChats.refresh(owner);
    // The upgraded group is asked again under its new id, at once.
    assert.deepEqual(refreshed.chats.map(item=>[item.external,item.state]).sort(),
      [[observed,'available'],[silent,'available'],[moved,'migrated'],[upgraded,'available'],[missing,'not_member']].sort());
    assert.ok(refreshed.chats.every(item=>item.chat_id===chat(item.external===upgraded?moved:item.external)));
    const all:ConversationDirectoryItem[]=[];let after='';
    for(;;){const page=await s.supervision.conversations(owner,{limit:100,after});all.push(...page.items);if(!page.next_cursor)break;after=page.next_cursor;}
    const find=(id:string)=>all.find(item=>item.space_id===chat(id));
    assert.equal(find(silent)?.name,'Quiet group','a group with no captured message is named by the refresh');
    assert.equal(find(observed)?.name,'Captured title','a captured name stays preferred');
    assert.deepEqual(find(moved)?.app_ids,[{app:'telegram',external:upgraded,state:'current'},{app:'telegram',external:moved,state:'old'}],
      'the new id becomes current and the old one stays');
    assert.equal(find(moved)?.name,'Telegram title');assert.equal(find(moved)?.state,'active','an upgrade never changes whether a chat is served');
    assert.equal(find(moved)?.telegram?.state,'available');
    assert.equal(find(missing)?.telegram?.state,'not_member');
    assert.equal(calls.length,5);
    // The frozen table is never written.
    assert.equal(Number((await stores.control.query('SELECT count(*) FROM telegram_chat_observations WHERE chat_id=ANY($1::text[])',[[observed,silent,moved,missing]])).rows[0].count),0);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

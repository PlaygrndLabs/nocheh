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

test('an explicit owner refresh names the groups that are on from Telegram, follows an upgrade, and directory reads never call it',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-telegram-chats-')),base=Date.now();
  const observed='-100'+base,silent='-'+(base%1000000000+7),moved='-'+(base%1000000000+8),missing='-'+(base%1000000000+9),upgraded='-100'+(base+1),owner:Reader={admin:true,scope:null};
  // A group Telegram upgraded whose new id already names a chat of its own (upgraded before step 2b): they stay apart.
  const split='-'+(base%1000000000+10),splitTo='-100'+(base+2);
  const calls:string[]=[],policy={enabled:true,owner_id:'123',group_ids:[]},groups=[observed,silent,moved,missing,split];
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      assert.equal(operation,'telegram.chat');const id=String(input.chat_id);calls.push(id);
      if(id===moved)return {chat_id:id,state:'migrated',migrate_to_chat_id:upgraded};
      if(id===split)return {chat_id:id,state:'migrated',migrate_to_chat_id:splitTo};
      if(id===missing)return {chat_id:id,state:'not_member'};
      return {chat_id:id,state:'available',type:'supergroup',title:id===silent?'Quiet group':'Telegram title',username:id===upgraded?'upgraded_group':null,is_forum:true};
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  try {
    await s.guards.reconcile();await s.configuration.configure(policy,'on');
    const event:Envelope={version:1,key:'chats:'+base,origin:'live',kind:'telegram_update',bot_id:'chats',scope:observed,source_id:'1',revision:'1',occurred_at:null,text:'hi',
      payload:{update_id:1,message:{message_id:1,date:1,chat:{id:Number(observed),type:'supergroup',title:'Captured title'},from:{id:123},text:'hi'}}};
    await s.capture.capture(event);
    await s.capture.capture({...event,key:'chats-split:'+base,scope:splitTo,payload:{update_id:2,message:{message_id:1,date:1,
      chat:{id:Number(splitTo),type:'supergroup',title:'Supergroup of its own'},from:{id:123},text:'hi'}}});
    // The groups only an owner record names get their rows from the seeder, off; the owner turns each on (ADR-0253).
    await new ChatSeeder(stores,policy).values(groups.filter(id=>id!==observed));
    const ids=new Map((await stores.control.query('SELECT external_id,chat_id FROM chat_ids WHERE external_id=ANY($1::text[])',[groups])).rows
      .map(row=>[row.external_id as string,row.chat_id as string])),chat=(external:string)=>ids.get(external)!;
    for(const external of groups)await s.chats.setState(owner,{chat_id:chat(external),state:'active',operation_id:'chats-on:'+base+':'+external});
    assert.equal(chat(observed),chatIdFor('telegram',observed),'a group first seen after step 2b has a digest id');
    const before=await s.supervision.conversations(owner,{q:'',after:'',limit:100});
    assert.equal(before.items.find(item=>item.space_id===chat(silent))?.name,null);assert.equal(calls.length,0,'directory reads never call Telegram');
    await assert.rejects(s.telegramChats.refresh({admin:false,scope:null}),{status:403});
    const refreshed=await s.telegramChats.refresh(owner),mine=new Set([...groups,upgraded,splitTo]);
    // Other tests' groups that are on are refreshed too: only this test's are looked at.
    refreshed.chats=refreshed.chats.filter(item=>mine.has(item.external));
    // The upgraded group is asked again under its new id, at once.
    assert.deepEqual(refreshed.chats.map(item=>[item.external,item.state]).sort(),
      [[observed,'available'],[silent,'available'],[moved,'migrated'],[upgraded,'available'],[missing,'not_member'],[split,'migrated']].sort());
    assert.ok(refreshed.chats.every(item=>item.chat_id===chat(item.external===upgraded?moved:item.external)));
    const all:ConversationDirectoryItem[]=[];let after='';
    for(;;){const page=await s.supervision.conversations(owner,{limit:100,after});all.push(...page.items);if(!page.next_cursor)break;after=page.next_cursor;}
    const find=(id:string)=>all.find(item=>item.space_id===chat(id));
    assert.equal(find(silent)?.name,'Quiet group','a group with no captured message is named by the refresh');
    assert.equal(find(observed)?.name,'Captured title','a captured name stays preferred');
    // The refresh's own answer is kept beside it: what runtime profiles and destinations are named by, as before step 2b.
    const answered=async(id:string)=>(await stores.control.query('SELECT refreshed_title,refreshed_username FROM chat_details WHERE chat_id=$1',[chat(id)])).rows[0];
    assert.deepEqual({...await answered(observed)},{refreshed_title:'Telegram title',refreshed_username:null});
    assert.deepEqual({...await answered(moved)},{refreshed_title:'Telegram title',refreshed_username:'upgraded_group'});
    assert.deepEqual({...await answered(missing)},{refreshed_title:null,refreshed_username:null},'an unavailable answer names nothing');
    assert.deepEqual(find(moved)?.app_ids,[{app:'telegram',external:upgraded,state:'current'},{app:'telegram',external:moved,state:'old'}],
      'the new id becomes current and the old one stays');
    assert.equal(find(moved)?.name,'Telegram title');assert.equal(find(moved)?.state,'active','an upgrade never changes whether a chat is served');
    assert.equal(find(moved)?.telegram?.state,'available');
    assert.equal(find(missing)?.telegram?.state,'not_member');
    // The new id names another chat, so it is not linked, not asked, and the served group keeps the 'migrated' notice.
    assert.deepEqual(find(split)?.telegram&&{state:find(split)!.telegram!.state,to:find(split)!.telegram!.migrate_to_chat_id},{state:'migrated',to:splitTo});
    assert.deepEqual(find(split)?.app_ids,[{app:'telegram',external:split,state:'current'}]);
    const other=all.find(item=>item.app_ids.some(label=>label.external===splitTo));
    assert.ok(other&&other.space_id!==chat(split));assert.equal(other.name,'Supergroup of its own');assert.equal(other.telegram,undefined);
    assert.equal(calls.filter(id=>mine.has(id)).length,6);assert.ok(!calls.includes(splitTo));
    // The frozen table is never written.
    assert.equal(Number((await stores.control.query('SELECT count(*) FROM telegram_chat_observations WHERE chat_id=ANY($1::text[])',[[observed,silent,moved,missing,split]])).rows[0].count),0);
  }finally{
    // Turned off again, so no later test's refresh asks Telegram about them.
    await stores.control.query(`UPDATE chats c SET state='off' FROM chat_ids i WHERE i.chat_id=c.id AND i.external_id=ANY($1::text[]) AND c.state='active'`,[[...groups,upgraded]]).catch(()=>undefined);
    await stores.close();await rm(root,{recursive:true,force:true});
  }
});

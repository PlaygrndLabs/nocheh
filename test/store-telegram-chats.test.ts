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

test('an explicit owner refresh names selected groups from Telegram while directory reads never call it',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-telegram-chats-')),base=Date.now();
  const observed='-100'+base,silent='-'+(base%1000000000+7),moved='-'+(base%1000000000+8),missing='-'+(base%1000000000+9),owner:Reader={admin:true,scope:null};
  const calls:string[]=[],policy={enabled:true,owner_id:'123',group_ids:[observed,silent,moved,missing]};
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      assert.equal(operation,'telegram.chat');const id=String(input.chat_id);calls.push(id);
      if(id===moved)return {chat_id:id,state:'migrated',migrate_to_chat_id:'-100'+(base+1)};
      if(id===missing)return {chat_id:id,state:'not_member'};
      return {chat_id:id,state:'available',type:'supergroup',title:id===silent?'Quiet group':'Telegram title',is_forum:true};
    },honcho:async()=>{throw Error('no memory provider');}});
  try {
    await s.guards.reconcile();await s.configuration.configure(policy,'on');
    const event:Envelope={version:1,key:'chats:'+base,origin:'live',kind:'telegram_update',bot_id:'chats',scope:observed,source_id:'1',revision:'1',occurred_at:null,text:'hi',
      payload:{update_id:1,message:{message_id:1,date:1,chat:{id:Number(observed),type:'supergroup',title:'Captured title'},from:{id:123},text:'hi'}}};
    await s.capture.capture(event);
    const before=await s.supervision.conversations(owner,{q:'',after:'',limit:100});
    assert.equal(before.items.find(item=>item.space_id===silent)?.name,null);assert.equal(calls.length,0,'directory reads never call Telegram');
    await assert.rejects(s.telegramChats.refresh({admin:false,scope:null}),{status:403});
    const refreshed=await s.telegramChats.refresh(owner);
    assert.deepEqual(refreshed.chats.map(chat=>chat.state).sort(),['available','available','migrated','not_member']);
    const after=await s.supervision.conversations(owner,{q:'',after:'',limit:100}),find=(id:string)=>after.items.find(item=>item.space_id===id);
    assert.equal(find(silent)?.name,'Quiet group','a group with no captured message is named by the refresh');
    assert.equal(find(observed)?.name,'Captured title','a captured name stays preferred');
    assert.equal(find(moved)?.telegram?.migrate_to_chat_id,'-100'+(base+1));
    assert.equal(find(missing)?.telegram?.state,'not_member');
    assert.equal(calls.length,4);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

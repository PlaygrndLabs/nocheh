import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';

test('an explicit owner refresh names unobserved groups and reports upgraded group IDs without granting access',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:120000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),forum='-100'+(Date.now()%1000000000),basic='-'+(Date.now()%100000000+7),owner:Reader={admin:true,scope:null},calls:string[]=[];
  const s=storageServices(stores,{dataDir:'/tmp/nocheh-telegram-chats',detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[forum,basic]}),
    runtime:async(operation,input)=>{
      assert.equal(operation,'telegram.chat');calls.push(String(input.chat_id));
      return input.chat_id===forum?{chat_id:forum,state:'available',type:'supergroup',title:'  Synthetic   forum ',is_forum:true}:
        {chat_id:basic,state:'migrated',migrate_to_chat_id:forum};
    },honcho:async()=>{throw Error('no memory provider');}});
  try {
    await s.guards.reconcile();await s.configuration.configure({enabled:true,owner_id:'123',group_ids:[forum,basic]},'on');
    await assert.rejects(s.telegramChats.refresh({admin:false,scope:null}),{status:403});
    assert.deepEqual(calls,[],'a non-owner caller cannot reach Telegram');
    const before=await s.supervision.conversations(owner,{q:forum,limit:100});
    assert.equal(before.items.find(item=>item.space_id===forum)?.name??null,null,'directory reads never call Telegram');
    const result=await s.telegramChats.refresh(owner);
    assert.deepEqual(calls.sort(),[forum,basic].sort());
    assert.equal(result.chats.find(chat=>chat.chat_id===forum)?.title,'Synthetic forum');
    assert.equal(result.chats.find(chat=>chat.chat_id===basic)?.migrate_to_chat_id,forum);
    const after=await s.supervision.conversations(owner,{q:'',limit:100});
    assert.equal(after.items.find(item=>item.space_id===forum)?.name,'Synthetic forum');
    assert.deepEqual(after.items.find(item=>item.space_id===basic)?.telegram?.migrate_to_chat_id,forum);
  }finally{await stores.close();}
});

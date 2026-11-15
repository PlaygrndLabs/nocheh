import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {chatIdFor,installChatsForTest} from '../src/chats.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {recallNames,recallPlace} from '../src/stores/recall-places.js';
import {GP1,GP1_TOPIC,GP2,GP3,NG1,NG1_TG,NG1_TOPIC,NG1_TOPIC_KEY,NG2,NG2_OLD_TG,NG2_TG,fixtureDirectory,seedChats} from './fixture-groups.js';

test('a recalled note is named from its chat row and its newest message under any Telegram id, on old-shaped and digest chats (ADR-0251, ADR-0252)',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:120000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),restore=installChatsForTest(fixtureDirectory());
  try {
    await seedChats(stores.control);
    // GP2's name came from an owner's refresh that has since found the group gone; GP3's from one that found it.
    await stores.control.query(`UPDATE chats SET title_source='refreshed' WHERE id=ANY($1::text[])`,[[GP2,GP3]]);
    await stores.control.query(`INSERT INTO chat_details(chat_id,refreshed_state,refreshed_title,refreshed_at) VALUES($1,'not_member',NULL,now()),($2,'available','GP3',now())
      ON CONFLICT(chat_id) DO UPDATE SET refreshed_state=excluded.refreshed_state,refreshed_title=excluded.refreshed_title,refreshed_at=now()`,[GP2,GP3]);
    // The owner named GP1's topic.
    await stores.control.query(`UPDATE chats SET title='Seed swap',title_source='owner' WHERE id=$1`,[GP1_TOPIC]);

    // Archived originals keep the Telegram id their chat had then: NG2 spoke first as a basic group, then as the
    // supergroup Telegram upgraded it to; NG1 created its topic.
    const archive=new ArchiveRepository(stores.archive);let serial=0;
    const say=async(telegram:string,chat:Record<string,unknown>,at:string,extra:Record<string,unknown>={})=>{
      const update=++serial,message={message_id:update,date:1700000000+update,chat:{id:Number(telegram),...chat},from:{id:456,is_bot:false,first_name:'Bob'},text:'Synthetic hello',...extra};
      await archive.capture({version:1,key:`recall-places:${Date.now()}:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope:telegram,
        source_id:String(update),revision:'1',occurred_at:null,text:'Synthetic hello',payload:{update_id:update,message}} as Envelope,{received_at:at,manifests:[]});
    };
    await say(NG2_OLD_TG,{type:'group',title:'NG2 basic'},'2026-09-01T00:00:00.000Z');
    await say(NG2_TG,{type:'supergroup',title:'NG2 team'},'2026-09-02T00:00:00.000Z');
    await say(NG1_TG,{type:'supergroup',title:'NG1 forum',is_forum:true},'2026-09-03T00:00:00.000Z',
      {message_thread_id:Number(NG1_TOPIC_KEY),is_topic_message:true,forum_topic_created:{name:'Trip plans',icon_color:7322096}});

    const stray=chatIdFor('telegram','-1002000000099');
    const spaces=[GP1,GP1_TOPIC,GP2,GP3,NG1,NG1_TOPIC,NG2,stray];
    const names=await recallNames(stores,spaces);
    const label=(space:string)=>recallPlace({space},names);
    assert.deepEqual(spaces.map(label),[
      '“GP1”','“GP1” › Seed swap',
      // A name only a refresh gave counts while that refresh found the chat, as before step 2b.
      'A Telegram group','“GP3”',
      // Digest chats are named by their newest message under any Telegram id they have had, never by an id's shape.
      '“NG1 forum”','“NG1 forum” › Trip plans','“NG2 team”',
      'A chat Nocheh can’t name']);
    assert.ok(![...names.keys()].includes(stray));
    assert.ok([...names.values()].every(name=>!/-?\d{6,}/.test(name)));
  } finally {restore();await Promise.all([stores.archive.end(),stores.derived.end(),stores.control.end()]);}
});

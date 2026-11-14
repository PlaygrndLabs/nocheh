import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {accountIdFor,chatIdFor,chats,refreshChatsOnEpoch,setChatLoader} from '../src/chats.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {CaptureCoordinator} from '../src/stores/capture.js';
import {ChatDirectoryLoader,ChatRepository,startChatDirectory} from '../src/stores/chats.js';
import {connectStores,initializeStoreDatabases,type StorePools} from '../src/stores/connections.js';
import {BOB_CHAT,GP1,GP1_TOPIC,GP2,GP_GROUP_IDS,NG1,NG1_TOPIC,NG2,NG2_OLD_TG,NG2_TG,OWNER,UNSERVED,seedChats} from './fixture-groups.js';

const fixture={skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000};
async function open():Promise<StorePools> {
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  return connectStores(config,passwords);
}
/** Every row the chat records hold for these chats: what a replay must leave as it is. */
async function records(control:pg.Pool,ids:string[]) {
  const all=[...ids,...(await control.query('SELECT id FROM chats WHERE parent_id=ANY($1::text[])',[ids])).rows.map(row=>row.id as string)];
  const [rows,appIds,details,members,state]=await Promise.all([
    control.query('SELECT id,kind,parent_id,topic_key,title,title_source,app_type,is_forum,state,account_id FROM chats WHERE id=ANY($1::text[]) ORDER BY id',[all]),
    control.query('SELECT external_id,chat_id,state FROM chat_ids WHERE chat_id=ANY($1::text[]) ORDER BY external_id',[all]),
    control.query('SELECT chat_id,username,observed_title,seen_at,closed,seq FROM chat_details WHERE chat_id=ANY($1::text[]) ORDER BY chat_id',[all]),
    control.query('SELECT chat_id,account_id,state,source,seen_seq FROM chat_memberships WHERE chat_id=ANY($1::text[]) ORDER BY chat_id,account_id',[all]),
    control.query('SELECT revision FROM chat_directory_state WHERE singleton')]);
  return {chats:rows.rows,ids:appIds.rows,details:details.rows,members:members.rows,revision:state.rows[0].revision};
}

test('captured updates record chats, topics, private chats, people and memberships, once and in update order',fixture,async()=>{
  const stores=await open(),base=Date.now(),group='-100'+base,update=(n:number)=>base*100+n;
  const person=(n:number)=>String(base%1000000000*10+n),[alice,carol,dave,bob,bot]=[1,2,3,4,5].map(person) as [string,string,string,string,string];
  const policy:AssistantPolicy={enabled:true,owner_id:OWNER,group_ids:[]},repository=new ChatRepository(stores,()=>policy);
  const coordinator=new CaptureCoordinator(new ArchiveRepository(stores.archive),stores.control,undefined,repository);
  const chat={id:Number(group),type:'supergroup',title:'Records group',is_forum:true};
  const sources:Awaited<ReturnType<CaptureCoordinator['capture']>>['source'][]=[];
  const capture=async(n:number,payload:Record<string,unknown>,scope=group,kind='telegram_update')=>{
    const result=await coordinator.capture({version:1,key:'records:'+base+':'+n,origin:'live',kind,bot_id:'777',scope,source_id:String(n),revision:'1',
      occurred_at:null,text:null,payload:{update_id:update(n),...payload}} as Envelope);
    sources.push(result.source);
  };
  try {
    // A forum message names its topic through the root message every topic message replies to.
    await capture(1,{message:{message_id:10,date:1,chat,from:{id:Number(alice),first_name:'Alice',username:'alice_p1'},message_thread_id:5,is_topic_message:true,
      reply_to_message:{message_id:5,forum_topic_created:{name:'Plans'}},text:'SECRET_TEXT_ONE'}});
    // An anonymous admin and a channel post as a chat: neither is a person in the group.
    await capture(2,{message:{message_id:11,date:2,chat,from:{id:1087968824,is_bot:true,first_name:'Group'},sender_chat:{id:Number(group),type:'supergroup'},text:'SECRET_TEXT_TWO'}});
    await capture(3,{message:{message_id:12,date:3,chat,from:{id:136817688,is_bot:true,first_name:'Channel'},sender_chat:{id:-1009,type:'channel'},text:'SECRET_TEXT_THREE'}});
    await capture(4,{message:{message_id:13,date:4,chat,from:{id:Number(alice),first_name:'Alice'},new_chat_members:[{id:Number(carol),first_name:'Carol'},
      {id:Number(bot),is_bot:true,first_name:'Helper'}]}});
    // Leaving outranks the leave message's own sender.
    await capture(5,{message:{message_id:14,date:5,chat,from:{id:Number(dave),first_name:'Dave'},left_chat_member:{id:Number(dave),first_name:'Dave'}}});
    // An older update taken in after a newer one changes neither the membership nor the name.
    await capture(7,{chat_member:{chat,from:{id:Number(alice)},date:7,old_chat_member:{status:'member',user:{id:Number(carol)}},new_chat_member:{status:'kicked',user:{id:Number(carol)}}}});
    await capture(6,{chat_member:{chat:{...chat,title:'Older title'},from:{id:Number(alice)},date:6,old_chat_member:{status:'left',user:{id:Number(carol)}},
      new_chat_member:{status:'member',user:{id:Number(carol)}}}});
    // Bob writes to Nocheh privately: a private chat with his account, and no memberships.
    await capture(8,{message:{message_id:1,date:8,chat:{id:Number(bob),type:'private',first_name:'Bob'},from:{id:Number(bob),first_name:'Bob'},text:'SECRET_TEXT_FOUR'}},bob);

    const id=chatIdFor('telegram',group),topic=chatIdFor('telegram',group,'5'),bobChat=chatIdFor('telegram',bob);
    const saved=await records(stores.control,[id,bobChat]);
    assert.deepEqual(saved.chats.map(row=>[row.id,row.kind,row.parent_id,row.topic_key,row.title,row.app_type,row.state,row.account_id]).sort(),[
      [id,'group',null,null,'Records group','supergroup','off',null],
      [topic,'topic',id,'5','Plans',null,'off',null],
      [bobChat,'private',null,null,'Bob','private','off',accountIdFor('telegram',bob)],
    ].sort(),'chats first seen after step 2b have digest ids, served only as the 2b-1 bridge says');
    assert.equal(saved.chats.find(row=>row.id===id)!.is_forum,true);
    assert.deepEqual(saved.ids.map(row=>[row.external_id,row.chat_id,row.state]).sort(),[[bob,bobChat,'current'],[group,id,'current']].sort());
    assert.deepEqual(saved.members.filter(row=>row.chat_id===id).map(row=>[row.account_id,row.state]).sort(),
      [[accountIdFor('telegram',alice),'in'],[accountIdFor('telegram',carol),'left'],[accountIdFor('telegram',dave),'left']].sort(),
      'bots, an anonymous admin and a channel are never members; the newest update about each person wins');
    assert.equal(saved.members.some(row=>row.chat_id===bobChat),false);
    const accounts=new Map((await stores.control.query('SELECT external_id,kind,display_name,username FROM chat_accounts WHERE external_id=ANY($1::text[])',
      [[alice,bot,'1087968824','136817688']])).rows.map(row=>[row.external_id,row]));
    assert.equal(accounts.get(alice)?.kind,'human');assert.equal(accounts.get(alice)?.username,'alice_p1');
    assert.equal(accounts.get(bot)?.kind,'bot');assert.equal(accounts.get('1087968824')?.kind,'bot');assert.equal(accounts.get('136817688')?.kind,'bot');
    assert.equal(saved.details.find(row=>row.chat_id===topic)?.observed_title,'Plans');
    // Names and ids only: no message text reaches the chat records.
    for(const table of ['chats','chat_ids','chat_details','chat_accounts','chat_memberships'])
      assert.equal(Number((await stores.control.query(`SELECT count(*) FROM ${table} t WHERE row_to_json(t)::text LIKE '%SECRET_TEXT%'`)).rows[0].count),0,table);

    // A replay of every original (a reconcile pass after a lost commit) changes nothing.
    for(const source of sources)await coordinator.handoff(source);
    assert.deepEqual(await records(stores.control,[id,bobChat]),saved);
  }finally{await stores.close();}
});

test('a group Telegram upgrades keeps one chat with its old and current ids, served under either',fixture,async()=>{
  const stores=await open(),base=Date.now(),old='-4'+String(base).slice(-12),next='-100'+(base+5),update=(n:number)=>base*100+n;
  const policy:AssistantPolicy={enabled:true,owner_id:OWNER,group_ids:[old]},repository=new ChatRepository(stores,()=>policy);
  const coordinator=new CaptureCoordinator(new ArchiveRepository(stores.archive),stores.control,undefined,repository);
  const capture=(n:number,scope:string,message:Record<string,unknown>)=>coordinator.capture({version:1,key:'upgrade:'+base+':'+n,origin:'live',kind:'telegram_update',
    bot_id:'777',scope,source_id:String(n),revision:'1',occurred_at:null,text:null,payload:{update_id:update(n),message:{message_id:n,date:n,from:{id:7},...message}}} as Envelope);
  try {
    await capture(1,old,{chat:{id:Number(old),type:'group',title:'Basic'},text:'hi'});
    await capture(2,old,{chat:{id:Number(old),type:'group',title:'Basic'},migrate_to_chat_id:Number(next)});
    await capture(3,next,{chat:{id:Number(next),type:'supergroup',title:'Basic'},migrate_from_chat_id:Number(old)});
    await capture(4,next,{chat:{id:Number(next),type:'supergroup',title:'Basic upgraded'},text:'hi again'});
    const id=chatIdFor('telegram',old);
    const saved=await records(stores.control,[id]);
    assert.deepEqual(saved.ids.map(row=>[row.external_id,row.chat_id,row.state]).sort(),[[next,id,'current'],[old,id,'old']].sort());
    assert.equal((await stores.control.query('SELECT count(*) FROM chat_ids WHERE external_id=ANY($1::text[])',[[old,next]])).rows[0].count,'2','no second chat');
    assert.deepEqual(saved.chats.map(row=>[row.title,row.app_type,row.state]),[['Basic upgraded','supergroup','active']]);
    // The bridge serves it while either id is in TELEGRAM_GROUP_IDS.
    for(const [ids,state] of [[[next],'active'],[[old],'active'],[[],'off']] as const) {
      await repository.serve({owner_id:OWNER,group_ids:[...ids]});
      assert.equal((await stores.control.query('SELECT state FROM chats WHERE id=$1',[id])).rows[0].state,state);
    }
  }finally{await stores.close();}
});

test('the 2b-1 bridge serves chats from TELEGRAM_GROUP_IDS and the owner id, in both chat id families',fixture,async()=>{
  const stores=await open(),repository=new ChatRepository(stores,()=>({enabled:true,owner_id:OWNER,group_ids:[]}));
  const states=async()=>Object.fromEntries((await stores.control.query('SELECT id,state FROM chats WHERE id=ANY($1::text[])',
    [[OWNER,BOB_CHAT,GP1,GP2,UNSERVED,NG1,NG2,GP1_TOPIC,NG1_TOPIC]])).rows.map(row=>[row.id,row.state]));
  try {
    await seedChats(stores.control);
    await repository.serve({owner_id:OWNER,group_ids:[GP1,NG2_OLD_TG]});
    let found=await states();
    assert.deepEqual([found[OWNER],found[BOB_CHAT],found[GP1],found[GP2],found[UNSERVED],found[NG1],found[NG2]],['active','off','active','off','off','off','active']);
    // A group upgraded after step 2b is served under its new id too.
    await repository.serve({owner_id:OWNER,group_ids:[NG2_TG]});
    found=await states();assert.equal(found[NG2],'active');assert.equal(found[GP1],'off');
    assert.equal(await repository.serve({owner_id:OWNER,group_ids:[NG2_TG]}),0,'nothing changes when the list is the same');
    // A topic keeps its own row as it is: whether it is served follows its group.
    assert.equal(found[GP1_TOPIC],(await stores.control.query('SELECT state FROM chats WHERE id=$1',[GP1_TOPIC])).rows[0].state);
  }finally{
    // Put the fixture back as other tests expect it.
    await repository.serve({owner_id:OWNER,group_ids:[...GP_GROUP_IDS]}).catch(()=>0);
    await stores.close();
  }
});

test('the process directory reloads after a capture, a newer epoch and a miss, and an unknown id reads nothing',fixture,async()=>{
  const stores=await open(),base=Date.now(),group='-100'+base,policy:AssistantPolicy={enabled:true,owner_id:OWNER,group_ids:[]};
  const repository=new ChatRepository(stores,()=>policy);
  const coordinator=new CaptureCoordinator(new ArchiveRepository(stores.archive),stores.control,undefined,repository);
  class Counting extends ChatDirectoryLoader{checks=0;override async stale(){this.checks++;return super.stale();}}
  const insert=async(external:string,bump:boolean)=>{
    const id=chatIdFor('telegram',external),connection=(await stores.control.query(`SELECT id FROM chat_connections WHERE app='telegram'`)).rows[0].id;
    await stores.control.query(`INSERT INTO chats(id,connection_id,kind,state) VALUES($1,$2,'group','off')`,[id,connection]);
    await stores.control.query(`INSERT INTO chat_ids(connection_id,external_id,chat_id,state) VALUES($1,$2,$3,'current')`,[connection,external,id]);
    if(bump)await stores.control.query('UPDATE chat_directory_state SET revision=revision+1 WHERE singleton');
    return id;
  };
  const until=async(check:()=>boolean)=>{for(let i=0;i<100&&!check();i++)await new Promise(resolve=>setTimeout(resolve,50));return check();};
  const loader=await startChatDirectory(stores.control,()=>policy);
  try {
    // A capture that adds a chat and a topic reloads this process's directory as soon as it commits.
    await coordinator.capture({version:1,key:'reload:'+base,origin:'live',kind:'telegram_update',bot_id:'777',scope:group,source_id:'1',revision:'1',occurred_at:null,text:null,
      payload:{update_id:base*100+1,message:{message_id:1,date:1,chat:{id:Number(group),type:'supergroup',title:'Reload',is_forum:true},from:{id:7},message_thread_id:9,is_topic_message:true}}} as Envelope);
    assert.equal(chats().resolve('telegram',group),chatIdFor('telegram',group));
    assert.equal(chats().resolve('telegram',group,'9'),chatIdFor('telegram',group,'9'));

    // A row another process added: unknown until the miss reloads, and unknown means private, unserved and empty.
    const missed=await insert('-100'+(base+1),true);
    assert.equal(chats().get(missed),null);assert.equal(chats().isPrivate(missed),true);assert.equal(chats().isGroup(missed),false);
    assert.equal(chats().served(missed),false);assert.deepEqual(chats().expand([missed]),[]);assert.deepEqual(chats().rawScopes([missed]),[]);
    assert.ok(await until(()=>chats().get(missed)!==null),'a miss reloads once the directory revision moved');

    // A newer guard epoch reloads too, even when no revision moved.
    const quiet=await insert('-100'+(base+2),false);
    refreshChatsOnEpoch(chats().epoch+1);
    assert.ok(await until(()=>chats().get(quiet)!==null),'a newer epoch reloads');

    // Misses are checked at most once an interval.
    const counting=new Counting(stores.control,()=>policy,1000);setChatLoader(counting);
    for(let i=0;i<5;i++)chats().get('-100'+(base+3));
    assert.equal(counting.checks,1);
    await new Promise(resolve=>setTimeout(resolve,1100));
    chats().get('-100'+(base+3));assert.equal(counting.checks,2);
  }finally{setChatLoader(loader);await stores.close();}
});

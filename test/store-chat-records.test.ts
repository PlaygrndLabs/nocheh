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
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonical} from '../src/archive.js';
import {legacyChatValue} from '../src/chats-telegram.js';
import {drainSourceSpool} from '../src/stores/capture.js';
import {ChatSeeder} from '../src/stores/chat-seed.js';
import {OwnerPortabilityRepository,type OwnerRecord} from '../src/stores/owner-portability.js';
import {telegramDirectory} from '../src/stores/telegram-directory.js';

const fixture={skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
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

    // The owner's People list shows whom the group's own messages show, as before step 2b: Alice wrote, Carol was added and
    // Dave sent his own leave message. Erin, whom Alice removed, and Frank, known only from a member update, keep their
    // state but are not shown (ADR-0252).
    const [erin,frank]=[6,7].map(person) as [string,string];
    await capture(9,{message:{message_id:15,date:9,chat,from:{id:Number(alice),first_name:'Alice'},left_chat_member:{id:Number(erin),first_name:'Erin'}}});
    await capture(10,{chat_member:{chat,from:{id:Number(alice)},date:10,old_chat_member:{status:'left',user:{id:Number(frank)}},new_chat_member:{status:'member',user:{id:Number(frank),first_name:'Frank'}}}});
    await capture(11,{message_reaction:{chat,message_id:10,user:{id:Number(frank),first_name:'Frank'},date:11,old_reaction:[],new_reaction:[{type:'emoji',emoji:'👍'}]}});
    const listed=(await telegramDirectory(stores.control,{admin:true,scope:null},stores.archive)).groups.find(group=>group.id===id)!;
    assert.equal(listed.external,group);
    assert.deepEqual(listed.users.map(user=>[user.id,user.state,user.seen]).sort(),
      [[alice,'in',true],[carol,'left',true],[dave,'left',true],[erin,'left',false],[frank,'in',false]].sort(),'a reaction is not a message');
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
    // The owner's people route names it once, by its Nocheh id, with both its Telegram ids, current first: the dashboard
    // opens it by that id, and TELEGRAM_GROUP_IDS still naming it by the earlier one finds it (ADR-0252).
    const listed=(await telegramDirectory(stores.control,{admin:true,scope:null},stores.archive)).groups
      .filter(group=>group.id===id||[old,next].some(external=>group.telegram_ids.includes(external)));
    assert.deepEqual(listed.map(group=>[group.id,group.external,group.telegram_ids]),[[id,next,[next,old]]]);
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

test('each update is recorded once: a replay waits on no chat row and keeps newer names, and the next replay records a failed one',fixture,async()=>{
  const stores=await open(),base=Date.now(),group='-100'+base,update=(n:number)=>base*100+n,[alice,bob]=[1,2].map(n=>String(base%1000000000*10+n)) as [string,string];
  const policy:AssistantPolicy={enabled:true,owner_id:OWNER,group_ids:[]};let broken=false;
  const repository=new ChatRepository(stores,()=>{if(broken)throw Object.assign(Error('records unavailable'),{code:'XX000'});return policy;});
  const coordinator=new CaptureCoordinator(new ArchiveRepository(stores.archive),stores.control,undefined,repository);
  const chat={id:Number(group),type:'supergroup',title:'Once group'};
  const capture=async(n:number,name:string,extra:Record<string,unknown>={})=>(await coordinator.capture({version:1,key:'once:'+base+':'+n,origin:'live',
    kind:'telegram_update',bot_id:'777',scope:group,source_id:String(n),revision:'1',occurred_at:null,text:null,
    payload:{update_id:update(n),message:{message_id:n,date:n,chat,from:{id:Number(alice),first_name:name},text:'SECRET_TEXT_ONCE',...extra}}} as Envelope)).source;
  const marked=async(event:string)=>(await stores.control.query('SELECT 1 FROM chat_recorded_events WHERE event_id=$1',[event])).rowCount;
  const id=chatIdFor('telegram',group),account=accountIdFor('telegram',alice);
  const name=async()=>(await stores.control.query('SELECT display_name FROM chat_accounts WHERE id=$1',[account])).rows[0]?.display_name;
  const failures:string[]=[],warn=console.warn;
  console.warn=(...args:unknown[])=>{const line=String(args[0]);if(line.includes('"chat_record_failed"'))failures.push(line);else warn(...args);};
  const holder=await stores.control.connect();
  try {
    const first=await capture(1,'Alice Old');
    await capture(2,'Alice New');
    const saved=await records(stores.control,[id]);
    assert.equal(await name(),'Alice New');assert.equal(saved.members.length,1);
    // Another transaction holds the rows a record writes, as a live capture or the membership backfill does while the
    // reconciliation sweeps: the sweep's replay must not wait on them.
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM chat_details WHERE chat_id=$1 FOR UPDATE',[id]);
    await holder.query('SELECT 1 FROM chat_accounts WHERE id=$1 FOR UPDATE',[account]);
    await holder.query('SELECT 1 FROM chat_memberships WHERE chat_id=$1 FOR UPDATE',[id]);
    const replay=coordinator.handoff(first);
    const waited=await Promise.race([replay.then(()=>false),sleep(3000).then(()=>true)]);
    await holder.query('ROLLBACK');await replay;
    assert.equal(waited,false,'a replay of a recorded update writes no chat row, so it waits on none');
    assert.equal(await name(),'Alice New','a replay never writes an older update\'s name over a newer one');
    assert.deepEqual(await records(stores.control,[id]),saved);
    // A record that fails leaves its update unrecorded, and the capture goes on; the next replay records it, and its
    // names stay behind those of an update recorded meanwhile, also when that update repeats the names already stored.
    broken=true;
    const failed=await capture(3,'Alice Later',{new_chat_members:[{id:Number(bob),first_name:'Bob'}]});
    assert.deepEqual(failures.map(line=>JSON.parse(line)),[{event:'chat_record_failed',code:'XX000'}]);
    assert.equal((await stores.control.query('SELECT count(*)::int AS n FROM source_intakes WHERE event_id=$1',[failed.reference.id])).rows[0].n,1);
    assert.equal(await marked(failed.reference.id),0);
    broken=false;
    await capture(4,'Alice New');
    assert.equal((await records(stores.control,[id])).members.some(row=>row.account_id===accountIdFor('telegram',bob)),false);
    await coordinator.handoff(failed);
    assert.equal(await marked(failed.reference.id),1);
    assert.deepEqual((await records(stores.control,[id])).members.filter(row=>row.account_id===accountIdFor('telegram',bob)).map(row=>row.state),['in']);
    assert.equal(await name(),'Alice New');
    assert.equal(failures.length,1);
  }finally{console.warn=warn;holder.release();await stores.close();}
});

test('memberships and names follow each bot\'s own update order, a new bot, a week\'s gap and imported history',fixture,async()=>{
  const stores=await open(),base=Date.now(),group='-100'+base,update=(n:number)=>base*100+n;
  const [carol,dave]=[1,2].map(n=>String(base%1000000000*10+n)) as [string,string];
  const policy:AssistantPolicy={enabled:true,owner_id:OWNER,group_ids:[group]},repository=new ChatRepository(stores,()=>policy);
  const archive=new ArchiveRepository(stores.archive),coordinator=new CaptureCoordinator(archive,stores.control,undefined,repository);
  const chat={id:Number(group),type:'supergroup',title:'Ordered group'};
  const envelope=(n:number,bot:string,id:number,payload:Record<string,unknown>)=>({version:1,key:`order:${base}:${n}`,origin:'live',kind:'telegram_update',bot_id:bot,
    scope:group,source_id:String(n),revision:String(id),occurred_at:null,text:null,payload:{update_id:id,...payload}}) as Envelope;
  const member=(who:string,status:string,title='Ordered group')=>({chat_member:{chat:{...chat,title},from:{id:7},date:1,
    old_chat_member:{status:'member',user:{id:Number(who)}},new_chat_member:{status,user:{id:Number(who)}}}});
  const id=chatIdFor('telegram',group),state=async(who:string)=>(await stores.control.query('SELECT state FROM chat_memberships WHERE chat_id=$1 AND account_id=$2',
    [id,accountIdFor('telegram',who)])).rows[0]?.state,title=async()=>(await stores.control.query('SELECT title FROM chats WHERE id=$1',[id])).rows[0].title;
  try {
    await coordinator.capture(envelope(1,'777',update(50),member(carol,'member')));
    await coordinator.capture(envelope(2,'777',update(51),member(dave,'member')));
    assert.deepEqual([await state(carol),await state(dave)],['in','in']);
    // The owner replaces the bot: the new bot's update ids start far lower, and its updates are still the newer ones.
    await coordinator.capture(envelope(3,'888',5,member(carol,'left','Renamed by the new bot')));
    assert.deepEqual([await state(carol),await state(dave)],['left','in']);assert.equal(await title(),'Renamed by the new bot');
    // Within one bot an older update taken in later changes nothing, as before.
    await coordinator.capture(envelope(4,'888',4,member(carol,'member','Older name')));
    assert.equal(await state(carol),'left');assert.equal(await title(),'Renamed by the new bot');
    // The membership backfill skips the updates capture recorded: after an app start it reads the updates taken in since
    // the last one, and writes none of their rows again, so it waits on none of them.
    const before=await records(stores.control,[id]),last=(await stores.archive.query('SELECT max(capture_sequence) AS last FROM events')).rows[0].last;
    const rewind=()=>stores.control.query('UPDATE chat_seed_state SET members_sequence=0,archive_sequence=$1 WHERE singleton',[last]);
    await rewind();
    const holder=await stores.control.connect();
    try {
      await holder.query('BEGIN');await holder.query('SELECT 1 FROM chat_memberships WHERE chat_id=$1 FOR UPDATE',[id]);
      const filling=(async()=>{while(await repository.backfill(500));})();
      const waited=await Promise.race([filling.then(()=>false),sleep(3000).then(()=>true)]);
      await holder.query('ROLLBACK');await filling;
      assert.equal(waited,false,'the backfill waited on a membership capture had already written');
    } finally{holder.release();}
    assert.deepEqual(await records(stores.control,[id]),before);
    // Updates no capture recorded it fills in by the same rule: reading them all again gives the same memberships.
    const events=(await stores.archive.query('SELECT id FROM events WHERE scope=$1',[group])).rows.map(row=>row.id as string);
    await stores.control.query('DELETE FROM chat_recorded_events WHERE event_id=ANY($1::text[])',[events]);
    await stores.control.query('DELETE FROM chat_memberships WHERE chat_id=$1',[id]);
    await rewind();
    while(await repository.backfill(500));
    assert.deepEqual(await records(stores.control,[id]),before);
    // A week with no updates: Telegram may start the bot's count anywhere, and the later update is the newer one.
    await stores.control.query(`UPDATE chat_memberships SET checked_at=checked_at-interval '8 days' WHERE chat_id=$1`,[id]);
    await stores.control.query(`UPDATE chat_details SET seq_at=seq_at-interval '8 days' WHERE chat_id=$1`,[id]);
    await coordinator.capture(envelope(5,'888',2,member(carol,'member','Named after a quiet week')));
    assert.equal(await state(carol),'in');assert.equal(await title(),'Named after a quiet week');
    // History imported from another installation, taken in there long ago by its own bot with higher ids, never
    // overrides what this installation saw since, and never names this installation's bot.
    const old=await archive.capture(envelope(6,'999',update(90),member(carol,'left','An old imported name')),{received_at:'2020-01-01T00:00:00Z',manifests:[]});
    await stores.control.query(`INSERT INTO source_intakes(event_id,source_revision,input_hash,transport,state) VALUES($1,$2,$3,'import','ready')`,
      [old.source.reference.id,old.source.reference.revision,old.source.reference.input_hash]);
    await coordinator.handoff(old.source);
    assert.equal(await state(carol),'in');assert.equal(await title(),'Named after a quiet week');
    assert.equal((await stores.control.query(`SELECT account FROM chat_connections WHERE app='telegram'`)).rows[0].account,'888');
  }finally{await stores.close();}
});

test('an imported archive keeps its chats\' old ids, so the derivatives and owner records imported after it find them',fixture,async()=>{
  const stores=await open(),base=Date.now(),served='-100'+base,other='-100'+(base+1),later='-100'+(base+2);
  const policy:AssistantPolicy={enabled:true,owner_id:OWNER,group_ids:[served]},repository=new ChatRepository(stores,()=>policy);
  const archive=new ArchiveRepository(stores.archive),coordinator=new CaptureCoordinator(archive,stores.control,undefined,repository);
  const portability=new OwnerPortabilityRepository(stores),owner={admin:true,scope:null};
  const sealed=(table:string,key:string[],row:Record<string,unknown>):OwnerRecord=>({format:'nocheh-owner-record-v1',table,key,row,sha256:digest(canonical({table,key,row}))});
  const imported=async(n:number,scope:string,message:Record<string,unknown>)=>{
    const result=await archive.capture({version:1,key:`imported:${base}:${n}`,origin:'live',kind:'telegram_update',bot_id:'source-bot',scope,source_id:String(n),revision:String(n),
      occurred_at:null,text:null,payload:{update_id:n,message:{message_id:n,date:1,from:{id:7,first_name:'Alice'},chat:{id:Number(scope),type:'supergroup',title:'Imported'},...message}}} as Envelope,
      {received_at:'2025-06-01T00:00:00Z',manifests:[]});
    await stores.control.query(`INSERT INTO source_intakes(event_id,source_revision,input_hash,transport,state) VALUES($1,$2,$3,'import','ready')`,
      [result.source.reference.id,result.source.reference.revision,result.source.reference.input_hash]);
    await coordinator.handoff(result.source);
  };
  const appIds=async(external:string)=>(await stores.control.query('SELECT chat_id,state FROM chat_ids WHERE external_id=$1',[external])).rows;
  try {
    // A new installation's first start gives the served group its row.
    await new ChatSeeder(stores,policy).values([served]);
    const connection=(await stores.control.query(`SELECT id FROM chat_connections WHERE app='telegram'`)).rows[0].id as string;
    const account=(await stores.control.query(`SELECT account FROM chat_connections WHERE id=$1`,[connection])).rows[0].account;
    // A package exported after step 2b names a chat first seen there by its digest id: its chat records come first.
    const digestChat=chatIdFor('telegram',later);
    await portability.restore(owner,[sealed('chats',['group',digestChat],{id:digestChat,connection_id:connection,kind:'group',title:null,title_source:null,is_forum:false,state:'active'}),
      sealed('chat_ids',[connection,later],{connection_id:connection,external_id:later,chat_id:digestChat,state:'current',reason:null,changed_at:'2026-01-01T00:00:00Z'})]);
    // Then the archive: the served group's topic 7, a group this installation does not serve, and the later chat.
    await imported(1,served,{message_thread_id:7,is_topic_message:true,forum_topic_created:{name:'Imported topic'}});
    await imported(2,other,{text:'hi'});
    await imported(3,later,{text:'hi'});
    const topic=legacyChatValue(served,7);
    assert.deepEqual(await appIds(other),[{chat_id:other,state:'current'}],'an imported chat keeps the value it was stored under');
    assert.equal((await stores.control.query('SELECT id FROM chats WHERE parent_id=$1 AND topic_key=$2',[served,'7'])).rows[0]?.id,topic);
    assert.deepEqual(await appIds(later),[{chat_id:digestChat,state:'current'}],'a chat the package\'s records name keeps that id');
    assert.equal(Number((await stores.control.query('SELECT count(*) FROM chats WHERE id=$1',[later])).rows[0].count),0);
    assert.equal((await stores.control.query(`SELECT account FROM chat_connections WHERE id=$1`,[connection])).rows[0].account,account,'an import never names this installation\'s bot');
    // The derivatives and owner records that follow name the same chats, and seeding them adds nothing.
    const rows=Number((await stores.control.query('SELECT count(*) FROM chats')).rows[0].count);
    const restored=await portability.restore(owner,[sealed('project_assignments',[other],{space_id:other,project_id:null,mode:'none',revision:1}),
      sealed('chat_tool_settings',[topic],{space_id:topic,shell:false,browser:null,mcp:null,revision:1})]);
    assert.equal(restored.added,2);
    assert.equal(Number((await stores.control.query('SELECT count(*) FROM chats')).rows[0].count),rows);
    const {directory}=await repository.listing();
    assert.equal(directory.resolve('telegram',other),other);assert.equal(directory.resolve('telegram',served,'7'),topic);
    assert.equal(directory.kind(topic),'topic');assert.equal(directory.groupOf(topic),served);
    // An owner record brings a member's private chat naming no person. Imported history does not name it; this
    // installation's bot hearing from the chat does, so Answer privately finds the member's own chat again (ADR-0249).
    const member=String(base%1000000000*10+3),memberChat=chatIdFor('telegram',member);
    await portability.restore(owner,[sealed('chats',['private',memberChat],{id:memberChat,connection_id:connection,kind:'private',app_type:'private',
      title:null,title_source:null,is_forum:false,state:'off'}),
      sealed('chat_ids',[connection,member],{connection_id:connection,external_id:member,chat_id:memberChat,state:'current',reason:null,changed_at:'2026-01-01T00:00:00Z'})]);
    const person=async()=>(await stores.control.query('SELECT account_id FROM chats WHERE id=$1',[memberChat])).rows[0].account_id;
    const said=(key:string,n:number)=>({version:1,key:`${key}:${base}`,origin:'live',kind:'telegram_update',bot_id:'777',scope:member,source_id:String(n),revision:'1',
      occurred_at:null,text:null,payload:{update_id:n,message:{message_id:n,date:1,chat:{id:Number(member),type:'private',first_name:'Bob'},
        from:{id:Number(member),first_name:'Bob'},text:'/start'}}}) as Envelope;
    assert.equal(await person(),null,'an owner record names no person');
    const old=await archive.capture(said('member-imported',4),{received_at:'2025-06-01T00:00:00Z',manifests:[]});
    await stores.control.query(`INSERT INTO source_intakes(event_id,source_revision,input_hash,transport,state) VALUES($1,$2,$3,'import','ready')`,
      [old.source.reference.id,old.source.reference.revision,old.source.reference.input_hash]);
    await coordinator.handoff(old.source);
    assert.equal(await person(),null,'nor does imported history');
    const revision=Number((await stores.control.query('SELECT revision FROM chat_directory_state WHERE singleton')).rows[0].revision);
    await coordinator.capture(said('member-live',5));
    assert.equal(await person(),accountIdFor('telegram',member),'the bot hearing from the chat names its person');
    assert.ok(Number((await stores.control.query('SELECT revision FROM chat_directory_state WHERE singleton')).rows[0].revision)>revision,'and the directory reloads');
  }finally{await stores.close();}
});

test('the spool hands Telegram updates off in update order, so an upgrade read after the new group\'s messages keeps one chat',fixture,async()=>{
  const stores=await open(),base=Date.now(),old='-4'+String(base).slice(-12),next='-100'+(base+7),root=await mkdtemp(join(tmpdir(),'nocheh-chat-spool-'));
  const policy:AssistantPolicy={enabled:true,owner_id:OWNER,group_ids:[old]},repository=new ChatRepository(stores,()=>policy);
  const coordinator=new CaptureCoordinator(new ArchiveRepository(stores.archive),stores.control,undefined,repository);
  const envelope=(n:number,nonce:number,scope:string,message:Record<string,unknown>):Envelope=>({version:1,key:`telegram:777:update:${base}${n}:${nonce}`,origin:'live',
    kind:'telegram_update',bot_id:'777',scope,source_id:String(n),revision:String(base*10+n),occurred_at:null,text:null,
    payload:{update_id:base*10+n,message:{message_id:n,date:n,from:{id:7},...message}}});
  try {
    await coordinator.capture(envelope(1,0,old,{chat:{id:Number(old),type:'group',title:'Basic'},text:'hi'}));
    // Three updates of one batch, written so the new group's ordinary message is read first.
    const files=[envelope(2,0,old,{chat:{id:Number(old),type:'group',title:'Basic'},migrate_to_chat_id:Number(next)}),
      envelope(3,0,next,{chat:{id:Number(next),type:'supergroup',title:'Basic'},migrate_from_chat_id:Number(old)})];
    const names=files.map(file=>digest(file.key));
    let nonce=0,member=envelope(4,nonce,next,{chat:{id:Number(next),type:'supergroup',title:'Basic'},text:'first in the new group'});
    while(!names.every(name=>digest(member.key)<name))member=envelope(4,++nonce,next,{chat:{id:Number(next),type:'supergroup',title:'Basic'},text:'first in the new group'});
    const pending=join(root,'spool','pending');await mkdir(pending,{recursive:true});
    for(const file of [...files,member])await writeFile(join(pending,digest(file.key)+'.json'),canonical(file));
    await drainSourceSpool(coordinator,root);
    const id=chatIdFor('telegram',old);
    assert.deepEqual((await stores.control.query('SELECT external_id,chat_id,state FROM chat_ids WHERE external_id=ANY($1::text[]) ORDER BY external_id',[[old,next]])).rows
      .map(row=>[row.external_id,row.chat_id,row.state]).sort(),[[next,id,'current'],[old,id,'old']].sort());
    assert.equal(Number((await stores.control.query('SELECT count(*) FROM chats WHERE id=$1',[chatIdFor('telegram',next)])).rows[0].count),0,'no second chat');
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

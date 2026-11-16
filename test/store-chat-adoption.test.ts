import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {accountIdFor,chatIdFor,chats,installChatsForTest} from '../src/chats.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {CaptureCoordinator} from '../src/stores/capture.js';
import {bumpChatRevision,ChatRepository,servedPolicy,startChatDirectory} from '../src/stores/chats.js';
import {connectStores,initializeStoreDatabases,type StorePools} from '../src/stores/connections.js';
import {legacyChats,OWNER,seedChats} from './fixture-groups.js';
import {seededDirectory} from './fixture-seeded-chats.js';

/*
 * Only the owner adds Nocheh (ADR-0253): a my_chat_member update about Nocheh in a group decides chats.state as it is
 * taken in. Both chat id families: groups first seen now have digest ids, and a group stored before step 2b keeps its
 * Telegram value as its id. Every group here is new to this test, so the shared GP/NG fixture is never changed.
 */
const fixture={skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000};
const BOT='777',ANONYMOUS=1087968824,CHANNEL=136817688;
const owner={admin:true,scope:null};
async function open():Promise<StorePools> {
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  return connectStores(config,passwords);
}

/** One test's captures: live Telegram updates through the capture coordinator, as the app takes them in. */
function harness(stores:StorePools,policy:()=>AssistantPolicy,label:string) {
  const base=Date.now(),repository=new ChatRepository(stores,policy),archive=new ArchiveRepository(stores.archive);
  const coordinator=new CaptureCoordinator(archive,stores.control,undefined,repository);
  let serial=0,past=false;
  const envelope=(scope:string,payload:Record<string,unknown>):Envelope=>({version:1,key:label+':'+base+':'+(++serial),origin:'live',kind:'telegram_update',bot_id:BOT,
    scope,source_id:String(serial),revision:'1',occurred_at:null,text:null,payload} as Envelope);
  const send=async(scope:string,payload:Record<string,unknown>)=>past?(await archive.capture(envelope(scope,payload))).source
    :(await coordinator.capture(envelope(scope,payload))).source;
  /** Takes updates in as a build that never recorded them did: they reach the archive, and nothing records them. */
  const unrecorded=async<T>(takeIn:()=>Promise<T>)=>{past=true;try{return await takeIn();}finally{past=false;}};
  /** A my_chat_member update: Nocheh's status in `group` went from `before` to `after`, changed by `from` (null: no sender). */
  const status=(group:string,update:number,from:number|null,before:string,after:string,type='supergroup')=>send(group,{update_id:update,
    my_chat_member:{chat:{id:Number(group),type,title:'Bakery '+group.slice(-3)},...from===null?{}:{from:{id:from,first_name:'Adder'}},date:1,
      old_chat_member:{status:before,user:{id:Number(BOT),is_bot:true}},new_chat_member:{status:after,user:{id:Number(BOT),is_bot:true}}}});
  const message=(group:string,update:number,extra:Record<string,unknown>={},type='supergroup')=>send(group,{update_id:update,
    message:{message_id:update%100000,date:1,chat:{id:Number(group),type,title:'Bakery '+group.slice(-3)},from:{id:5551},text:'hello',...extra}});
  const update=(n:number)=>base*100+n;
  const named=new Set<string>(),group=(n:number)=>{const value='-100'+(base+n);named.add(value);return value;};
  /** Turns this test's groups off again, so a later test's refresh never asks Telegram about them. */
  const cleanup=()=>stores.control.query(`UPDATE chats c SET state='off' FROM chat_ids i WHERE i.chat_id=c.id AND i.external_id=ANY($1::text[]) AND c.state='active'
    AND c.kind='group'`,[[...named]]).catch(()=>undefined);
  return {base,repository,coordinator,archive,send,unrecorded,status,message,update,group,cleanup,named};
}
const row=async(stores:StorePools,id:string)=>(await stores.control.query(`SELECT state,added_by_role,added_by_account_id,added_at,add_event,state_seq,state_bot,state_at
  FROM chats WHERE id=$1`,[id])).rows[0];
const events=async(stores:StorePools,id:string)=>(await stores.control.query(`SELECT event_id,external_id,kind,role,account_id,member,action,state,
  due_at>created_at+interval '25 seconds' AS waits FROM chat_state_events WHERE chat_id=$1 ORDER BY created_at,event_id`,[id])).rows;
const guard=async(stores:StorePools)=>{
  const result=(await stores.control.query(`SELECT (SELECT epoch FROM guard_state WHERE singleton) AS epoch,(SELECT revision FROM chat_directory_state WHERE singleton) AS revision`)).rows[0];
  return {epoch:Number(result.epoch),revision:Number(result.revision)};
};

test('the owner adding Nocheh turns a group on with a card; anyone else\'s add makes it pending to leave, and no add moves the guard epoch',fixture,async()=>{
  const stores=await open(),MEMBER=7771,STRANGER=7772;
  let policy:AssistantPolicy={enabled:true,owner_id:OWNER,group_ids:[],group_access:{'-1001234567890':{granted:[String(MEMBER)],denied:[]}}};
  const h=harness(stores,()=>policy,'adds');
  try {
    // A group stored before step 2b keeps its Telegram value as its id: the seeder left it off.
    const legacy=h.group(9);await seedChats(stores.control,legacyChats([legacy]));
    const before=await guard(stores);
    const ownerAdd=await h.status(h.group(1),h.update(1),Number(OWNER),'left','member');
    const legacyAdd=await h.status(legacy,h.update(2),Number(OWNER),'kicked','administrator');
    const memberAdd=await h.status(h.group(2),h.update(3),MEMBER,'left','member');
    const strangerAdd=await h.status(h.group(3),h.update(4),STRANGER,'left','member');
    const anonymous=await h.status(h.group(4),h.update(5),ANONYMOUS,'left','administrator');
    const channel=await h.status(h.group(5),h.update(6),CHANNEL,'left','member');
    const nobody=await h.status(h.group(6),h.update(7),null,'left','member');
    const after=await guard(stores);
    assert.equal(after.epoch,before.epoch,'a capture never moves the guard epoch');assert.ok(after.revision>before.revision,'the directory revision tells every process');

    const expect=async(id:string,source:{reference:{id:string}},state:string,role:string,by:number|null,action:string,member:boolean)=>{
      const saved=await row(stores,id);
      assert.deepEqual([saved.state,saved.added_by_role,saved.added_by_account_id,saved.add_event,saved.state_bot],
        [state,role,by===null?null:accountIdFor('telegram',String(by)),source.reference.id,BOT],id);
      assert.ok(saved.added_at&&saved.state_at&&saved.state_seq!==null);
      assert.deepEqual((await events(stores,id)).map(item=>[item.event_id,item.kind,item.role,item.account_id,item.member,item.action,item.state,item.waits]),
        [[source.reference.id,'added',role,by===null?null:accountIdFor('telegram',String(by)),member,action,'waiting',true]],id);
    };
    await expect(chatIdFor('telegram',h.group(1)),ownerAdd,'active','owner',Number(OWNER),'card',false);
    await expect(legacy,legacyAdd,'active','owner',Number(OWNER),'card',false);
    await expect(chatIdFor('telegram',h.group(2)),memberAdd,'pending','other',MEMBER,'leave',true);
    await expect(chatIdFor('telegram',h.group(3)),strangerAdd,'pending','other',STRANGER,'leave',false);
    for(const [n,source] of [[4,anonymous],[5,channel],[6,nobody]] as const)await expect(chatIdFor('telegram',h.group(n)),source,'pending','anonymous',null,'leave',false);
    // Content-free: the event rows hold ids and roles only.
    assert.equal(Number((await stores.control.query(`SELECT count(*) FROM chat_state_events t WHERE row_to_json(t)::text LIKE '%Bakery%' OR row_to_json(t)::text LIKE '%Adder%'`)).rows[0].count),0);

    // With no owner set, every add is someone else's.
    policy={...policy,owner_id:null};
    const unowned=await h.status(h.group(7),h.update(8),Number(OWNER),'left','member');
    await expect(chatIdFor('telegram',h.group(7)),unowned,'pending','other',Number(OWNER),'leave',false);
  }finally{await h.cleanup();await stores.close();}
});

test('Nocheh removed from a group that is on is told, from one that is off is not; its own leave is left, and an add to a group on changes nothing',fixture,async()=>{
  const stores=await open(),ALICE=7781,policy:AssistantPolicy={enabled:true,owner_id:OWNER,group_ids:[]};
  const h=harness(stores,()=>policy,'removals');
  try {
    const on=chatIdFor('telegram',h.group(1)),off=chatIdFor('telegram',h.group(2)),pending=chatIdFor('telegram',h.group(3)),legacy=h.group(4);
    const add=await h.status(h.group(1),h.update(1),Number(OWNER),'left','member');
    // Telegram tells Nocheh again that it is in a group that is on (a restore, an echo): nothing but the order moves.
    await h.status(h.group(1),h.update(2),ALICE,'left','member');
    assert.deepEqual([(await row(stores,on)).state,(await row(stores,on)).add_event,(await events(stores,on)).length],['active',add.reference.id,1]);
    assert.equal(Number((await row(stores,on)).state_seq),h.update(2));
    const removal=await h.status(h.group(1),h.update(3),ALICE,'administrator','kicked');
    assert.equal((await row(stores,on)).state,'removed');
    assert.deepEqual((await events(stores,on)).map(item=>[item.event_id,item.kind,item.role,item.account_id,item.action,item.state,item.waits]).at(-1),
      [removal.reference.id,'removed','other',accountIdFor('telegram',String(ALICE)),'tell','waiting',false]);

    // A group seen with no add (after a long downtime) stays off and silent, and removing Nocheh there tells no one.
    await h.message(h.group(2),h.update(4));
    assert.equal((await row(stores,off)).state,'off');assert.equal((await row(stores,off)).state_at,null,'a new chat is ordered by no update yet');
    await h.status(h.group(2),h.update(5),ALICE,'member','left');
    assert.equal((await row(stores,off)).state,'removed');
    assert.deepEqual((await events(stores,off)).map(item=>[item.kind,item.action,item.state]),[['removed','none','done']]);

    // Nocheh leaving a group someone else added it to is left; that leave writes no event row.
    await h.status(h.group(3),h.update(6),ALICE,'left','member');
    await h.status(h.group(3),h.update(7),Number(BOT),'member','left');
    assert.equal((await row(stores,pending)).state,'left');
    assert.deepEqual((await events(stores,pending)).map(item=>item.kind),['added']);
    // ...in the old-shaped family too, and a later removal of a chat it already left still says removed.
    await seedChats(stores.control,legacyChats([legacy]));
    await h.status(legacy,h.update(8),Number(BOT),'member','left');
    assert.equal((await row(stores,legacy)).state,'left');
    await h.status(legacy,h.update(9),Number(BOT),'left','kicked');
    assert.equal((await row(stores,legacy)).state,'left','an out to out change is nothing');
  }finally{await h.cleanup();await stores.close();}
});

test('a bot-status update applies only when newer; a replay, an import, a private chat and an old id change nothing',fixture,async()=>{
  const stores=await open(),ALICE=7791,policy:AssistantPolicy={enabled:true,owner_id:OWNER,group_ids:[]};
  const h=harness(stores,()=>policy,'order');
  try {
    const id=chatIdFor('telegram',h.group(1));
    const add=await h.status(h.group(1),h.update(10),Number(OWNER),'left','member');
    // An older update taken in later never undoes a newer one.
    await h.status(h.group(1),h.update(9),ALICE,'member','kicked');
    assert.equal((await row(stores,id)).state,'active');assert.deepEqual((await events(stores,id)).map(item=>item.kind),['added']);
    // A replay of the add changes nothing.
    const saved=await row(stores,id);await h.coordinator.handoff(add);
    assert.deepEqual(await row(stores,id),saved);assert.equal((await events(stores,id)).length,1);

    // An owner change orders by when it happened: an update taken in before it but recorded after never undoes it.
    const late=await h.archive.capture({version:1,key:'order-late:'+h.base,origin:'live',kind:'telegram_update',bot_id:BOT,scope:h.group(1),source_id:'late',
      revision:'1',occurred_at:null,text:null,payload:{update_id:h.update(11),my_chat_member:{chat:{id:Number(h.group(1)),type:'supergroup',title:'Bakery'},from:{id:ALICE},date:1,
        old_chat_member:{status:'member',user:{id:Number(BOT),is_bot:true}},new_chat_member:{status:'kicked',user:{id:Number(BOT),is_bot:true}}}}} as Envelope);
    await h.repository.setState(owner,{chat_id:id,state:'off',operation_id:'order-off:'+h.base});
    assert.deepEqual([(await row(stores,id)).state,(await row(stores,id)).state_seq,(await row(stores,id)).state_bot],['off',null,null]);
    await h.coordinator.handoff(late.source);
    assert.equal((await row(stores,id)).state,'off');assert.equal((await events(stores,id)).length,1);

    // Imported history never adopts: the group it names is recorded off, with no event.
    const imported=h.group(2);
    const old=await h.archive.capture({version:1,key:'order-import:'+h.base,origin:'live',kind:'telegram_update',bot_id:'999',scope:imported,source_id:'imported',
      revision:'1',occurred_at:null,text:null,payload:{update_id:5,my_chat_member:{chat:{id:Number(imported),type:'supergroup',title:'Old'},from:{id:Number(OWNER)},date:1,
        old_chat_member:{status:'left',user:{id:999,is_bot:true}},new_chat_member:{status:'member',user:{id:999,is_bot:true}}}}} as Envelope,{received_at:'2020-01-01T00:00:00Z',manifests:[]});
    await stores.control.query(`INSERT INTO source_intakes(event_id,source_revision,input_hash,transport,state) VALUES($1,$2,$3,'import','ready')`,
      [old.source.reference.id,old.source.reference.revision,old.source.reference.input_hash]);
    await h.coordinator.handoff(old.source);
    const importedId=(await stores.control.query('SELECT chat_id FROM chat_ids WHERE external_id=$1',[imported])).rows[0].chat_id;
    assert.equal((await row(stores,importedId)).state,'off');assert.equal((await events(stores,importedId)).length,0);

    // A private chat's block and unblock decide nothing.
    const person=String(h.base%1000000000*10+3),privateChat=chatIdFor('telegram',person);
    await h.send(person,{update_id:h.update(12),my_chat_member:{chat:{id:Number(person),type:'private',first_name:'Carol'},from:{id:Number(person)},date:1,
      old_chat_member:{status:'member',user:{id:Number(BOT),is_bot:true}},new_chat_member:{status:'kicked',user:{id:Number(BOT),is_bot:true}}}});
    assert.equal((await row(stores,privateChat)).state,'off');assert.equal((await events(stores,privateChat)).length,0);

    // An update about a group's old id (before Telegram upgraded it) decides nothing for the chat it now names.
    const basic='-4'+String(h.base).slice(-9),upgraded=h.group(3),chat=chatIdFor('telegram',basic);h.named.add(basic);
    await h.status(basic,h.update(13),Number(OWNER),'left','member','group');
    await h.message(basic,h.update(14),{migrate_to_chat_id:Number(upgraded)},'group');
    await h.status(basic,h.update(15),ALICE,'member','kicked','group');
    assert.equal((await row(stores,chat)).state,'active');assert.equal((await events(stores,chat)).length,1);
  }finally{await h.cleanup();await stores.close();}
});

test('adds, removals and upgrades taken in before adoption began are history: recorded, never acted on',fixture,async()=>{
  const stores=await open(),ALICE=7821,BOB=7822,policy:AssistantPolicy={enabled:true,owner_id:OWNER,group_ids:[]};
  const h=harness(stores,()=>policy,'history');
  try {
    // A group on from the last 2b-1 start (no update ordered its state), a group seen with no add, and the two ids of an
    // upgraded group that 2b-1 kept as two chats.
    const on=h.group(1),seen=h.group(2),basic='-4'+String(h.base+3).slice(-9),next=h.group(3);h.named.add(basic);
    const onId=chatIdFor('telegram',on),seenId=chatIdFor('telegram',seen),basicId=chatIdFor('telegram',basic),nextId=chatIdFor('telegram',next);
    await h.message(on,h.update(1));await h.message(seen,h.update(2));await h.message(basic,h.update(3),{},'group');await h.message(next,h.update(4));
    await stores.control.query(`UPDATE chats SET state='active' WHERE id=$1`,[onId]);
    // Taken in by a build that never marked them recorded: Alice removed Nocheh and Bob added it back, the owner added it
    // to the seen group, and Telegram upgraded the basic group.
    const old=await h.unrecorded(async()=>[await h.status(on,h.update(5),ALICE,'member','kicked'),await h.status(on,h.update(6),BOB,'left','member'),
      await h.status(seen,h.update(7),Number(OWNER),'left','member'),await h.message(basic,h.update(8),{migrate_to_chat_id:Number(next)},'group')]);
    const boundary=await h.repository.startAdoption();
    assert.ok(old.every(source=>Number(source.sequence)<=boundary),'the first start sets the boundary past the archive');
    await h.message(seen,h.update(9));
    assert.equal(await h.repository.startAdoption(),boundary,'a later start keeps it');

    // The capture reconciliation's sweep records them now: their chats, names and memberships, and nothing else.
    await stores.control.query('UPDATE capture_reconciliation SET after_sequence=$1 WHERE singleton',[String(Number(old[0]!.sequence)-1)]);
    await h.coordinator.reconcile();
    assert.equal(Number((await stores.control.query('SELECT count(*) FROM chat_recorded_events WHERE event_id=ANY($1::text[])',[old.map(source=>source.reference.id)])).rows[0].count),4);
    assert.equal((await stores.control.query('SELECT 1 FROM chat_accounts WHERE id=$1',[accountIdFor('telegram',String(BOB))])).rowCount,1);
    const saved=await row(stores,onId);
    assert.deepEqual([saved.state,saved.state_seq,saved.state_at,saved.add_event],['active',null,null,null],'the group on stays on, with no update ordering it');
    assert.equal((await row(stores,seenId)).state,'off');
    assert.deepEqual([...await events(stores,onId),...await events(stores,seenId)],[],'no note, leave or card');
    assert.equal((await stores.control.query('SELECT chat_id FROM chat_ids WHERE external_id=$1',[next])).rows[0].chat_id,nextId,'an old upgrade folds nothing');
    assert.equal((await row(stores,basicId)).state,'off');

    // Taken in after it, live: acted on as ever.
    const removal=await h.status(on,h.update(10),ALICE,'member','kicked');
    assert.equal((await row(stores,onId)).state,'removed');
    assert.deepEqual((await events(stores,onId)).map(item=>[item.event_id,item.action]),[[removal.reference.id,'tell']]);
    const add=await h.status(seen,h.update(11),Number(OWNER),'left','member');
    assert.deepEqual([(await row(stores,seenId)).state,(await row(stores,seenId)).add_event],['active',add.reference.id]);
    assert.deepEqual((await events(stores,seenId)).map(item=>[item.event_id,item.action]),[[add.reference.id,'card']]);
  }finally{await stores.control.query('UPDATE chat_seed_state SET adopt_after=NULL WHERE singleton').catch(()=>undefined);await h.cleanup();await stores.close();}
});

test('an upgrade folds the new supergroup\'s own add into the old group, whichever upgrade message comes first, unless the owner served it otherwise',fixture,async()=>{
  const stores=await open(),ALICE=7801,policy:AssistantPolicy={enabled:true,owner_id:OWNER,group_ids:[]};
  const h=harness(stores,()=>policy,'fold');
  try {
    for(const [n,first,adder,start] of [[1,'old',ALICE,'off'],[2,'new',ALICE,'active'],[3,'old',Number(OWNER),'off'],[4,'new',Number(OWNER),'active']] as const) {
      const basic='-4'+String(h.base+n).slice(-9),next=h.group(n),old=chatIdFor('telegram',basic),fresh=chatIdFor('telegram',next);h.named.add(basic);
      if(start==='active')await h.status(basic,h.update(n*10),Number(OWNER),'left','member','group');
      else await h.message(basic,h.update(n*10),{},'group');
      const startEvents=(await events(stores,old)).map(item=>item.event_id);
      // Telegram tells Nocheh it is in the new supergroup before the upgrade messages link the two ids.
      const add=await h.status(next,h.update(n*10+1),adder,'left','member');
      assert.equal((await row(stores,fresh)).state,adder===Number(OWNER)?'active':'pending');
      const toOld=()=>h.message(basic,h.update(n*10+2),{migrate_to_chat_id:Number(next)},'group');
      const fromNew=()=>h.message(next,h.update(n*10+3),{migrate_from_chat_id:Number(basic)});
      if(first==='old'){await toOld();await fromNew();}else{await fromNew();await toOld();}
      const label=JSON.stringify({n,first,adder,start});
      assert.equal((await stores.control.query('SELECT count(*) FROM chats WHERE id=$1',[fresh])).rows[0].count,'0',label+': the new row folded');
      assert.deepEqual((await stores.control.query('SELECT external_id,state,reason FROM chat_ids WHERE chat_id=$1 ORDER BY state',[old])).rows
        .map(item=>[item.external_id,item.state,item.reason]),[[next,'current',null],[basic,'old','migrated']],label);
      assert.deepEqual((await events(stores,old)).map(item=>item.event_id),[...startEvents,add.reference.id],label+': the add\'s event moved with it');
      const folded=await row(stores,old);
      // An owner add makes a group that was off on; anything else leaves the group as it was, and the stage finds the
      // moved card or leave superseded (the chat's add_event is not that add).
      if(adder===Number(OWNER)&&start==='off')assert.deepEqual([folded.state,folded.add_event,folded.added_by_role],['active',add.reference.id,'owner'],label);
      else {assert.equal(folded.state,start,label);assert.notEqual(folded.add_event,add.reference.id,label);}
    }

    // The add arrives after the upgrade linked the ids: an off group stays off, unless the owner added it.
    const basic='-4'+String(h.base+5).slice(-9),next=h.group(5),old=chatIdFor('telegram',basic);h.named.add(basic);
    await h.message(basic,h.update(50),{},'group');
    await h.message(basic,h.update(51),{migrate_to_chat_id:Number(next)},'group');
    await h.status(next,h.update(52),ALICE,'left','member');
    assert.equal((await row(stores,old)).state,'off');assert.equal((await events(stores,old)).length,0);
    await h.status(next,h.update(53),Number(OWNER),'left','member');
    assert.equal((await row(stores,old)).state,'active','the owner adding it again is an add');

    // The new supergroup was turned on by the owner: it is the owner's chat, and the two stay apart.
    const keptBasic='-4'+String(h.base+6).slice(-9),keptNext=h.group(6),keptOld=chatIdFor('telegram',keptBasic),keptNew=chatIdFor('telegram',keptNext);h.named.add(keptBasic);
    await h.message(keptBasic,h.update(60),{},'group');
    await h.message(keptNext,h.update(61));
    await h.repository.setState(owner,{chat_id:keptNew,state:'active',operation_id:'fold-kept:'+h.base});
    await h.message(keptBasic,h.update(62),{migrate_to_chat_id:Number(keptNext)},'group');
    assert.deepEqual([(await row(stores,keptOld)).state,(await row(stores,keptNew)).state],['off','active']);
    assert.equal((await stores.control.query('SELECT chat_id FROM chat_ids WHERE external_id=$1',[keptNext])).rows[0].chat_id,keptNew);
  }finally{await h.cleanup();await stores.close();}
});

test('the owner switch turns a group on or off with its project in one owner command, and refuses chats Nocheh is not in',fixture,async()=>{
  const stores=await open(),policy:AssistantPolicy={enabled:true,owner_id:OWNER,group_ids:[]};
  const h=harness(stores,()=>policy,'switch');
  try {
    const digestGroup=chatIdFor('telegram',h.group(1)),legacy=h.group(2),pending=chatIdFor('telegram',h.group(3));
    await h.message(h.group(1),h.update(1));
    await seedChats(stores.control,legacyChats([legacy]));
    await h.status(h.group(3),h.update(2),7811,'left','member');
    await startChatDirectory(stores.control,()=>policy);
    const project=digest('project:switch-on:'+h.base);

    // On, with a new project named after the group, in the same command: one new epoch, the receipt, no update order.
    let before=await guard(stores);
    const on={chat_id:digestGroup,state:'active',operation_id:'switch-on:'+h.base,project:{mode:'new'}};
    assert.deepEqual(await h.repository.setState(owner,on),{chat_id:digestGroup,state:'active',project_id:project});
    let after=await guard(stores);
    assert.equal(after.epoch,before.epoch+1);assert.ok(after.revision>before.revision);
    const saved=await row(stores,digestGroup);
    assert.deepEqual([saved.state,saved.state_seq,saved.state_bot],['active',null,null]);assert.ok(saved.state_at);
    assert.deepEqual((await stores.control.query('SELECT name,state FROM projects WHERE id=$1',[project])).rows[0],{name:'Bakery '+h.group(1).slice(-3),state:'active'});
    assert.deepEqual((await stores.control.query('SELECT project_id,mode FROM project_assignments WHERE space_id=$1',[digestGroup])).rows[0],{project_id:project,mode:'assigned'});
    assert.equal(chats().served(digestGroup),true,'this process sees it at once');
    // The same command again is its receipt; another body under its id is refused.
    before=await guard(stores);
    assert.deepEqual(await h.repository.setState(owner,on),{chat_id:digestGroup,state:'active',project_id:project});
    assert.equal((await guard(stores)).epoch,before.epoch);
    await assert.rejects(h.repository.setState(owner,{...on,state:'off',project:undefined}),{code:'owner_command_conflict'});

    // Off keeps the project; the same state again changes nothing but still writes a receipt and an epoch.
    assert.deepEqual(await h.repository.setState(owner,{chat_id:digestGroup,state:'off',operation_id:'switch-off:'+h.base}),{chat_id:digestGroup,state:'off',project_id:project});
    before=await guard(stores);
    assert.deepEqual(await h.repository.setState(owner,{chat_id:digestGroup,state:'off',operation_id:'switch-off-again:'+h.base}),{chat_id:digestGroup,state:'off',project_id:project});
    after=await guard(stores);assert.equal(after.epoch,before.epoch+1);assert.equal(after.revision,before.revision);
    assert.equal(chats().served(digestGroup),false);

    // The old-shaped family: on into an existing project, then into none.
    await stores.control.query(`INSERT INTO projects(id,name,description,state,revision) VALUES($1,'Existing','','active',1) ON CONFLICT DO NOTHING`,[digest('switch:'+h.base)]);
    assert.deepEqual(await h.repository.setState(owner,{chat_id:legacy,state:'active',operation_id:'switch-legacy:'+h.base,project:{mode:'assigned',project_id:digest('switch:'+h.base)}}),
      {chat_id:legacy,state:'active',project_id:digest('switch:'+h.base)});
    assert.deepEqual(await h.repository.setState(owner,{chat_id:legacy,state:'active',operation_id:'switch-legacy-none:'+h.base,project:{mode:'none'}}),
      {chat_id:legacy,state:'active',project_id:null});
    assert.deepEqual((await stores.control.query('SELECT project_id,mode,revision FROM project_assignments WHERE space_id=$1',[legacy])).rows[0],{project_id:null,mode:'none',revision:2});
    // A group someone else added is on once the owner says so.
    assert.equal((await h.repository.setState(owner,{chat_id:pending,state:'active',operation_id:'switch-pending:'+h.base})).state,'active');

    // Refused: a chat Nocheh left, was removed from or knows only from imported history, a private chat, an unknown chat,
    // a project with off, a malformed body, and anyone but the owner.
    for(const [n,state] of [[4,'left'],[5,'removed'],[6,'archived']] as const) {
      await h.message(h.group(n),h.update(n));
      await stores.control.query('UPDATE chats SET state=$2 WHERE id=$1',[chatIdFor('telegram',h.group(n)),state]);
      await assert.rejects(h.repository.setState(owner,{chat_id:chatIdFor('telegram',h.group(n)),state:'active',operation_id:'switch-refused:'+h.base+':'+n}),
        {status:409,code:'chat_not_joined'},state);
    }
    const person=String(h.base%1000000000*10+7);
    await h.send(person,{update_id:h.update(9),message:{message_id:1,date:1,chat:{id:Number(person),type:'private',first_name:'Dana'},from:{id:Number(person)},text:'hi'}});
    await assert.rejects(h.repository.setState(owner,{chat_id:chatIdFor('telegram',person),state:'active',operation_id:'switch-private:'+h.base}),{status:400,code:'chat_not_group'});
    await assert.rejects(h.repository.setState(owner,{chat_id:chatIdFor('telegram',h.group(8)),state:'active',operation_id:'switch-unknown:'+h.base}),{status:404,code:'chat_not_found'});
    for(const body of [{chat_id:digestGroup,state:'off',operation_id:'x',project:{mode:'none'}},{chat_id:digestGroup,state:'pending',operation_id:'x'},
      {chat_id:digestGroup,state:'active',operation_id:'x',project:{mode:'assigned'}},{chat_id:digestGroup,state:'active',operation_id:'x',extra:true},
      {chat_id:'not a chat',state:'active',operation_id:'x'}])
      await assert.rejects(h.repository.setState(owner,body),{status:400},JSON.stringify(body));
    await assert.rejects(h.repository.setState({admin:false,scope:null},{chat_id:digestGroup,state:'active',operation_id:'x'}),{status:403});
  }finally{await h.cleanup();await stores.close();}
});

test('at start only the owner\'s private chat is on, and every process sees a state change within the watch interval with no new epoch',fixture,async()=>{
  const stores=await open(),policy:AssistantPolicy={enabled:true,owner_id:OWNER,group_ids:[]};
  const h=harness(stores,()=>policy,'start');
  try {
    // The owner's private chat as the shared fixture has it: seeded with its old-shaped id, unless a capture made it first.
    const ownerChat=async()=>(await stores.control.query('SELECT chat_id FROM chat_ids WHERE external_id=$1',[OWNER])).rows[0]?.chat_id as string|undefined;
    if(!await ownerChat())await seedChats(stores.control,legacyChats([OWNER],{owner:OWNER}));
    const OWNER_CHAT=(await ownerChat())!;
    const person=String(h.base%1000000000*10+9),other=chatIdFor('telegram',person),group=chatIdFor('telegram',h.group(1));
    await h.send(person,{update_id:h.update(1),message:{message_id:1,date:1,chat:{id:Number(person),type:'private',first_name:'Erin'},from:{id:Number(person)},text:'hi'}});
    await h.status(h.group(1),h.update(2),Number(OWNER),'left','member');
    // As an earlier owner's chat would be: on, and the owner's own off.
    await stores.control.query(`UPDATE chats SET state='active' WHERE id=$1`,[other]);
    await stores.control.query(`UPDATE chats SET state='off' WHERE id=$1`,[OWNER_CHAT]);
    assert.ok(await h.repository.startOwnerChat()>=2);
    assert.deepEqual([(await row(stores,OWNER_CHAT)).state,(await row(stores,other)).state,(await row(stores,group)).state],['active','off','active'],'groups keep their state');
    assert.equal((await row(stores,OWNER_CHAT)).state_seq,null);assert.ok((await row(stores,OWNER_CHAT)).state_at);
    assert.equal(await h.repository.startOwnerChat(),0,'a second start changes nothing');

    // Another process changes a state (a capture there, or the stage): this one reloads on its own, with no epoch.
    await startChatDirectory(stores.control,()=>policy);
    assert.equal(chats().served(group),true);
    const before=await guard(stores);
    await stores.control.query(`UPDATE chats SET state='off' WHERE id=$1`,[group]);await bumpChatRevision(stores.control);
    const until=Date.now()+6000;
    while(chats().served(group)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,200));
    assert.equal(chats().served(group),false,'the watch reloaded the directory');assert.equal((await guard(stores)).epoch,before.epoch);
    // The served policy's group list is the directory's alone: a list in the configured policy is ignored.
    const served=servedPolicy(()=>({...policy,group_ids:[h.group(1)]}));
    assert.equal(served().group_ids.includes(h.group(1)),false);
    await stores.control.query(`UPDATE chats SET state='active' WHERE id=$1`,[group]);await bumpChatRevision(stores.control);
    await startChatDirectory(stores.control,()=>policy);
    assert.equal(served().group_ids.includes(h.group(1)),true);
  }finally{await h.cleanup();await stores.close();}
});

test('the served policy names only the groups the directory has on, whatever list the configured policy carries',async()=>{
  // The seeded family: values stored before step 2b, on as the directory says.
  const on='-1001234567801',off='-1001234567802';
  const restore=installChatsForTest(seededDirectory(()=>({owner_id:OWNER,group_ids:[on]})));
  try {
    chats().resolve('telegram',off);
    const policy=servedPolicy(()=>({enabled:true,owner_id:OWNER,group_ids:[off]}))();
    assert.deepEqual(policy.group_ids,[on]);assert.equal(policy.owner_chat,OWNER);
  }finally{restore();}
});

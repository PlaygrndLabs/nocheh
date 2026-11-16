import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {chatIdFor,chatShortId,chats} from '../src/chats.js';
import {HttpError} from '../src/http.js';
import type {RuntimeCall} from '../src/runtime.js';
import {ActionCommandRepository} from '../src/stores/action-commands.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {CaptureCoordinator} from '../src/stores/capture.js';
import {ChatAdds,chatAddData} from '../src/stores/chat-adds.js';
import {ChatRepository,servedPolicy,startChatDirectory} from '../src/stores/chats.js';
import {connectStores,initializeStoreDatabases,type StorePools} from '../src/stores/connections.js';
import {legacyChats,OWNER,seedChats} from './fixture-groups.js';

/*
 * The stage after someone adds Nocheh to a group or removes it (ADR-0253): it leaves a group someone else added it to,
 * tells the owner only of adds by a person they allowed or a hidden adder, under caps, gives a group the owner added its
 * own project with a card, answers the card's buttons, and tells the owner when Nocheh was removed from a group it was
 * on in. Telegram is a recorder here. Both chat id families: groups first seen now have digest ids, and a group stored
 * before step 2b keeps its Telegram value as its id. Every group here is new to this test.
 */
const fixture={skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:240000};
const BOT='777',ANONYMOUS=1087968824,MEMBER=7901,STRANGER=7902,ALICE=7903;
/** A group key of TELEGRAM_GROUP_ACCESS where the owner allowed MEMBER. */
const ACCESS='-1001234567890';
const owner={admin:true,scope:null};
async function open():Promise<StorePools> {
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  return connectStores(config,passwords);
}
type Call={operation:string;input:any};

/** One test's captures, its Telegram recorder and its stage. */
async function harness(stores:StorePools,label:string) {
  const policy:AssistantPolicy={enabled:true,owner_id:OWNER,group_ids:[],group_access:{[ACCESS]:{granted:[String(MEMBER)],denied:[]}}};
  const base=Date.now(),repository=new ChatRepository(stores,()=>policy),archive=new ArchiveRepository(stores.archive);
  const coordinator=new CaptureCoordinator(archive,stores.control,undefined,repository);
  // The owner's private chat as the shared fixture has it: seeded with its old-shaped id, unless a capture made it first.
  if(!(await stores.control.query('SELECT 1 FROM chat_ids WHERE external_id=$1',[OWNER])).rowCount)await seedChats(stores.control,legacyChats([OWNER],{owner:OWNER}));
  await startChatDirectory(stores.control,()=>policy);
  // Notes sent before this test are out of its 24 hours, so the caps count this test's own, and rows another test left
  // waiting are not this test's to settle.
  await stores.control.query(`UPDATE chat_state_events SET updated_at=updated_at-interval '2 days' WHERE notice='sent'`);
  await stores.control.query(`UPDATE chat_state_events SET state='done' WHERE state='waiting'`);
  const calls:Call[]=[];
  const answers={leave:(_input:any):Record<string,unknown>=>({state:'done'}),notice:(_input:any):Record<string,unknown>=>({state:'done'})};
  const call:RuntimeCall=async(operation,input)=>{
    calls.push({operation,input});
    if(operation==='telegram.leave')return answers.leave(input);
    if(operation==='telegram.notice')return answers.notice(input);
    if(operation==='telegram.approval')return {state:'done'};
    throw new HttpError(409,'runtime_capability_unavailable');
  };
  const served=servedPolicy(()=>policy),adds=new ChatAdds(stores.control,served,call,repository);
  let serial=0;
  const envelope=(scope:string,payload:Record<string,unknown>):Envelope=>({version:1,key:label+':'+base+':'+(++serial),origin:'live',kind:'telegram_update',bot_id:BOT,
    scope,source_id:String(serial),revision:'1',occurred_at:null,text:null,payload} as Envelope);
  const send=async(scope:string,payload:Record<string,unknown>)=>(await coordinator.capture(envelope(scope,payload))).source.reference.id;
  const update=(n:number)=>base*100+n;
  const title=(group:string)=>'Bakery '+group.slice(-3);
  /** A my_chat_member update: Nocheh's status in `group` went from `before` to `after`, changed by `from`. Returns its event id. */
  const status=(group:string,n:number,from:number,before:string,after:string)=>send(group,{update_id:update(n),
    my_chat_member:{chat:{id:Number(group),type:'supergroup',title:title(group)},from:{id:from,first_name:from===MEMBER?'Mina':'Adder'},date:1,
      old_chat_member:{status:before,user:{id:Number(BOT),is_bot:true}},new_chat_member:{status:after,user:{id:Number(BOT),is_bot:true}}}});
  const named=new Set<string>(),group=(n:number)=>{const value='-100'+(base+n);named.add(value);return value;};
  /** This test's chats, by Nocheh id, whichever family. */
  const mine=async()=>(await stores.control.query('SELECT chat_id FROM chat_ids WHERE external_id=ANY($1::text[])',[[...named]])).rows.map(row=>row.chat_id as string);
  /** Makes this test's waiting rows due now, as they are 30 s after an add. */
  const due=async()=>{await stores.control.query(`UPDATE chat_state_events SET due_at=now() WHERE state='waiting' AND chat_id=ANY($1::text[])`,[await mine()]);};
  const row=async(event:string)=>(await stores.control.query('SELECT * FROM chat_state_events WHERE event_id=$1',[event])).rows[0];
  const chat=async(chatId:string)=>(await stores.control.query('SELECT state,state_seq,state_bot,state_at,add_event FROM chats WHERE id=$1',[chatId])).rows[0];
  const epoch=async()=>Number((await stores.control.query('SELECT epoch FROM guard_state WHERE singleton')).rows[0].epoch);
  /** The owner's press on a button of a notice, through the button routing the dispatch uses. Each press is its own archived
   *  update; `source` names an earlier one's, as when the dispatch tries that press again. Returns the press's answer. */
  const press=async(data:string,from=Number(OWNER),where=Number(OWNER),source=digest(label+':press:'+base+':'+(++serial)))=>{
    const query={id:'q'+(++serial),data,from:{id:from},message:{message_id:9,chat:{id:where,type:where===Number(OWNER)?'private':'supergroup'}}};
    const access={policy:served,archive:{verify:async()=>({kind:'telegram_update',origin:'live'})},
      stores:{archive:{query:async()=>({rows:[{payload:Buffer.from(JSON.stringify({callback_query:query}))}]})},control:stores.control}};
    const actions=new ActionCommandRepository(access as any,{} as any,{} as any,call,undefined,undefined,undefined,adds);
    assert.equal(await actions.callback({store:'archive',kind:'event',id:source,revision:'1',input_hash:'f'.repeat(64)} as any),true);
    return calls.filter(item=>item.operation==='telegram.approval'&&item.input.callback_query_id===query.id).at(-1)?.input.text as string;
  };
  /** Leaves nothing of this test due, and its groups off, for a later test. */
  const cleanup=async()=>{
    const ids=await mine().catch(()=>[]);
    await stores.control.query(`UPDATE chat_state_events SET state='done' WHERE state='waiting' AND chat_id=ANY($1::text[])`,[ids]).catch(()=>undefined);
    await stores.control.query(`UPDATE chats SET state='off' WHERE id=ANY($1::text[]) AND state='active'`,[ids]).catch(()=>undefined);
  };
  return {policy,repository,adds,calls,answers,status,group,named,mine,due,row,chat,epoch,press,cleanup,title,send,update};
}
/** A group as notices name it: its title, quoted and isolated, then its short id. */
const shown=(chatId:string,title:string)=>`\u2068“${title}”\u2069 (…${chatShortId(chatId)})`;
const quoted=(name:string)=>`\u2068“${name}”\u2069`;

test('someone else\'s add is left after the wait, as one leave call, and only a person the owner allowed or a hidden adder is told of it',fixture,async()=>{
  const stores=await open(),h=await harness(stores,'leave');
  try {
    const member=h.group(1),stranger=h.group(2),hidden=h.group(3),legacy=h.group(4),turnedOn=h.group(5),refused=h.group(6),offline=h.group(7),gone=h.group(8);
    // A group stored before step 2b keeps its Telegram value as its id.
    await seedChats(stores.control,legacyChats([legacy]));
    const memberAdd=await h.status(member,1,MEMBER,'left','member'),strangerAdd=await h.status(stranger,2,STRANGER,'left','member');
    const hiddenAdd=await h.status(hidden,3,ANONYMOUS,'left','administrator'),legacyAdd=await h.status(legacy,4,MEMBER,'kicked','member');
    const turnedOnAdd=await h.status(turnedOn,5,STRANGER,'left','member'),refusedAdd=await h.status(refused,6,MEMBER,'left','member');
    const offlineAdd=await h.status(offline,7,STRANGER,'left','member'),goneAdd=await h.status(gone,8,MEMBER,'left','member');
    const tg=(value:string)=>chatIdFor('telegram',value);
    const memberId=tg(member),strangerId=tg(stranger),hiddenId=tg(hidden),turnedOnId=tg(turnedOn),refusedId=tg(refused),offlineId=tg(offline),goneId=tg(gone);
    // The owner turns one on during the wait, and an earlier try already left another (its answer was lost).
    await h.repository.setState(owner,{chat_id:turnedOnId,state:'active',operation_id:'adds-on:'+h.update(0)});
    assert.equal(await h.repository.leaveSettled(goneId,goneAdd,'left'),true);

    // Nothing is done before the wait, so an upgrade's two halves can fold first.
    await h.adds.settle();
    assert.equal(h.calls.length,0,'no call before the 30 s wait');
    await h.due();
    h.answers.leave=input=>input.chat_id===refused?{state:'failed',error_code:'telegram_refused'}:
      input.chat_id===offline?{state:'not_started',error_code:'telegram_not_connected'}:{state:'done'};
    const before=await h.epoch();
    await h.adds.settle();
    assert.equal(await h.epoch(),before,'leaving moves no guard epoch');
    const leaves=h.calls.filter(item=>item.operation==='telegram.leave').map(item=>item.input);
    assert.deepEqual(leaves.map(item=>[item.id,item.chat_id]).sort(),[[memberAdd,member],[strangerAdd,stranger],[hiddenAdd,hidden],[legacyAdd,legacy],
      [refusedAdd,refused],[offlineAdd,offline]].sort(),'one leave each, named by the add, for the group\'s Telegram id now');
    for(const [chatId,state] of [[memberId,'left'],[strangerId,'left'],[hiddenId,'left'],[legacy,'left'],[refusedId,'could_not_leave'],[offlineId,'pending'],
      [turnedOnId,'active'],[goneId,'left']] as const) {
      const saved=await h.chat(chatId);assert.equal(saved.state,state,chatId);
      // A system change: an older bot-status update recorded late never undoes it.
      if(chatId==offlineId&&chatId==turnedOnId&&chatId==goneId)assert.deepEqual([saved.state_seq,saved.state_bot],[null,null]);
    }
    assert.equal(chats().get(memberId)?.state,'left','this process sees it at once');
    const outcome=async(event:string)=>{const saved=await h.row(event);return [saved.state,saved.outcome,saved.notice];};
    assert.deepEqual(await outcome(memberAdd),['done','left','sent']);
    assert.deepEqual(await outcome(strangerAdd),['done','left','none'],'a stranger\'s add is only the content-free record');
    assert.deepEqual(await outcome(hiddenAdd),['done','left','sent']);
    assert.deepEqual(await outcome(legacyAdd),['done','left','sent']);
    assert.deepEqual(await outcome(refusedAdd),['done','could_not_leave','sent']);
    assert.deepEqual(await outcome(turnedOnAdd),['done','superseded','none'],'the owner turned it on: nothing left');
    assert.deepEqual(await outcome(goneAdd),['done','left','sent'],'an earlier try left: no second leave, still the note');
    // Telegram did not answer: tried again a minute later, then two, as the add's own call.
    let waiting=await h.row(offlineAdd);
    assert.deepEqual([waiting.state,waiting.outcome,waiting.attempts],['waiting',null,1]);
    const minutes=async(event:string)=>Number((await stores.control.query(`SELECT extract(epoch FROM due_at-now())/60 AS m FROM chat_state_events WHERE event_id=$1`,[event])).rows[0].m);
    let wait=await minutes(offlineAdd);assert.ok(wait>0.8&&wait<=1.01,String(wait));

    // The notes: one each, in the owner's private chat, naming the adder and the group with its short id.
    const notes=h.calls.filter(item=>item.operation==='telegram.notice');
    const note=(event:string)=>notes.filter(item=>item.input.id===digest('chat-add-note:'+event));
    assert.equal(notes.length,5);
    for(const item of notes){assert.equal(item.input.chat_id,OWNER);assert.equal(item.input.buttons,undefined);assert.equal(item.input.topic,undefined);}
    assert.equal(note(memberAdd)[0]!.input.text,`${quoted('Mina')} added Nocheh to ${shown(memberId,h.title(member))}. Only you can add Nocheh, so it left. To use it there, add it yourself.`);
    assert.equal(note(hiddenAdd)[0]!.input.text,`Someone added Nocheh to ${shown(hiddenId,h.title(hidden))} without showing who, so it left. To use it there, turn off Remain anonymous and add Nocheh yourself.`);
    assert.equal(note(legacyAdd)[0]!.input.text,`${quoted('Mina')} added Nocheh to ${shown(legacy,h.title(legacy))}. Only you can add Nocheh, so it left. To use it there, add it yourself.`);
    assert.equal(note(refusedAdd)[0]!.input.text,`${quoted('Mina')} added Nocheh to ${shown(refusedId,h.title(refused))}, and it couldn't leave. It stays silent there.`);
    assert.equal(note(goneAdd).length,1);

    // Settled twice: nothing is called twice.
    const count=h.calls.length;
    await h.adds.settle();assert.equal(h.calls.length,count,'a second settle calls nothing');
    // The offline group, tried again: still not connected, then gone.
    await h.due();await h.adds.settle();
    waiting=await h.row(offlineAdd);assert.equal(waiting.attempts,2);
    wait=await minutes(offlineAdd);assert.ok(wait>1.8&&wait<=2.01,String(wait));
    h.answers.leave=()=>({state:'done'});
    await h.due();await h.adds.settle();
    assert.deepEqual(await outcome(offlineAdd),['done','left','none']);assert.equal((await h.chat(offlineId)).state,'left');
    // A leave the bot refuses (the group is served there now) is an HTTP 400: tried again later, never decided.
    const late=h.group(9),lateAdd=await h.status(late,9,STRANGER,'left','member');
    h.answers.leave=()=>{throw new HttpError(400,'telegram_rejected_request');};
    await h.due();await h.adds.settle();
    assert.deepEqual([(await h.row(lateAdd)).state,(await h.row(lateAdd)).attempts,(await h.chat(chatIdFor('telegram',late))).state],['waiting',1,'pending']);
    assert.equal(h.calls.filter(item=>item.operation==='telegram.leave').length,9);
  }finally{await h.cleanup();await stores.close();}
});

test('the bot\'s last check before a leave holds only while the group is pending from that add',fixture,async()=>{
  const stores=await open(),h=await harness(stores,'stands');
  try {
    const off=h.group(1),again=h.group(2),offId=chatIdFor('telegram',off),againId=chatIdFor('telegram',again);
    const offAdd=await h.status(off,1,STRANGER,'left','member'),firstAdd=await h.status(again,2,STRANGER,'left','member');
    assert.equal(await h.adds.leaveStands(offAdd,off),true,'pending from this add, under its Telegram id now');
    assert.equal(await h.adds.leaveStands(offAdd,again),false,'another group');
    assert.equal(await h.adds.leaveStands(firstAdd,again),true);
    // While the leaves wait behind other sends, the owner turns one group off, and the other is removed and added again.
    await h.repository.setState(owner,{chat_id:offId,state:'off',operation_id:'adds-off:'+h.update(0)});
    assert.equal(await h.adds.leaveStands(offAdd,off),false,'turned off: Nocheh stays there, silent');
    await h.status(again,3,STRANGER,'member','left');const secondAdd=await h.status(again,4,STRANGER,'left','member');
    assert.equal(await h.adds.leaveStands(firstAdd,again),false,'added again: the newer add\'s leave decides');
    assert.equal(await h.adds.leaveStands(secondAdd,again),true);
    // Once the stage settles it, a late try of the same leave leaves nothing.
    assert.equal(await h.repository.leaveSettled(againId,secondAdd,'left'),true);
    assert.equal(await h.adds.leaveStands(secondAdd,again),false);
    assert.deepEqual([(await h.chat(offId)).state,(await h.chat(againId)).state],['off','left']);
  }finally{await h.cleanup();await stores.close();}
});

test('a leave Telegram still answers with the group\'s upgrade after over an hour of tries ends as could not leave; any other answer is tried again',fixture,async()=>{
  const stores=await open(),h=await harness(stores,'migrated');
  try {
    const member=h.group(1),stranger=h.group(2),offline=h.group(3),tg=(value:string)=>chatIdFor('telegram',value);
    const memberAdd=await h.status(member,1,MEMBER,'left','member'),strangerAdd=await h.status(stranger,2,STRANGER,'left','member');
    const offlineAdd=await h.status(offline,3,STRANGER,'left','member');
    // Two old basic groups whose new ids never came: Telegram answers each leave with the upgrade. The bot cannot reach
    // Telegram for the third.
    h.answers.leave=input=>input.chat_id===offline?{state:'not_started',error_code:'telegram_not_connected'}:{state:'not_started',error_code:'telegram_chat_migrated'};
    const leaves=(event:string)=>h.calls.filter(item=>item.operation==='telegram.leave'&&item.input.id===event).length;
    const outcome=async(event:string)=>{const saved=await h.row(event);return [saved.state,saved.outcome,saved.notice,saved.attempts];};
    // Six tries, with waits of 1, 2, 4… 32 minutes after them: each is tried again, and each group stays pending.
    for(let index=0;index<6;index++){await h.due();await h.adds.settle();}
    for(const [event,value] of [[memberAdd,member],[strangerAdd,stranger],[offlineAdd,offline]] as const) {
      assert.deepEqual(await outcome(event),['waiting',null,'none',6],value);
      assert.equal((await h.chat(tg(value))).state,'pending');
    }
    // The seventh try, over an hour on: the upgraded ones end as a refused leave does, so the owner gets the switch and,
    // for the member's add, the note. The one Telegram could not be reached for is tried again.
    await h.due();await h.adds.settle();
    assert.deepEqual([leaves(memberAdd),leaves(strangerAdd),leaves(offlineAdd)],[7,7,7]);
    assert.deepEqual(await outcome(memberAdd),['done','could_not_leave','sent',0]);
    assert.deepEqual(await outcome(strangerAdd),['done','could_not_leave','none',0],'a stranger\'s add is only the content-free record');
    for(const value of [member,stranger]){const saved=await h.chat(tg(value));assert.deepEqual([saved.state,saved.state_seq],['could_not_leave',null]);}
    assert.deepEqual(await outcome(offlineAdd),['waiting',null,'none',7]);assert.equal((await h.chat(tg(offline))).state,'pending');
    assert.deepEqual(h.calls.filter(item=>item.operation==='telegram.notice').map(item=>item.input),[{id:digest('chat-add-note:'+memberAdd),chat_id:OWNER,
      text:`${quoted('Mina')} added Nocheh to ${shown(tg(member),h.title(member))}, and it couldn't leave. It stays silent there.`}]);
    // Once settled, nothing is tried again, and the owner can turn the group on or off.
    await h.due();await h.adds.settle();
    assert.deepEqual([leaves(memberAdd),leaves(strangerAdd)],[7,7]);
    assert.equal((await h.repository.setState(owner,{chat_id:tg(stranger),state:'off',operation_id:'migrated-off:'+h.update(0)})).state,'off');
  }finally{await h.cleanup();await stores.close();}
});

test('notes about leaving are capped at one per group and ten in all a day, a removal\'s line is not, and none goes without the owner\'s private chat',fixture,async()=>{
  const stores=await open(),h=await harness(stores,'caps');
  try {
    const sent=()=>h.calls.filter(item=>item.operation==='telegram.notice'&&!item.input.edit);
    // A person the owner allowed adds Nocheh to the same group again and again: one note that day.
    const again=h.group(1),againId=chatIdFor('telegram',again);
    const first=await h.status(again,1,MEMBER,'left','member');
    await h.due();await h.adds.settle();
    assert.equal((await h.row(first)).notice,'sent');
    const second=await h.status(again,2,MEMBER,'left','member');
    assert.equal((await h.chat(againId)).state,'pending');
    await h.due();await h.adds.settle();
    assert.deepEqual([(await h.row(second)).outcome,(await h.row(second)).notice],['left','capped']);
    assert.equal(h.calls.filter(item=>item.operation==='telegram.leave').length,2,'it still leaves each time');
    assert.equal(sent().length,1);

    // Hidden adders in new groups: nine more notes, then the rest are capped. A removal from the owner's own group is still
    // told: strangers' adds cannot use up the cap to hide it.
    const groups=Array.from({length:10},(_,index)=>h.group(10+index)),events:string[]=[];
    for(const [index,value] of groups.entries())events.push(await h.status(value,10+index,ANONYMOUS,'left','member'));
    await h.due();await h.adds.settle();
    assert.deepEqual(await Promise.all(events.map(async event=>(await h.row(event)).notice)),[...Array(9).fill('sent'),'capped']);
    assert.equal(sent().length,10);
    const on=h.group(30),onAdd=await h.status(on,30,Number(OWNER),'left','member');
    await stores.control.query('UPDATE chat_state_events SET state=\'done\' WHERE event_id=$1',[onAdd]);
    const removal=await h.status(on,31,ALICE,'member','kicked');
    await h.adds.settle();
    assert.deepEqual([(await h.row(removal)).outcome,(await h.row(removal)).notice],['told','sent']);
    assert.equal(sent().length,11);
    assert.deepEqual(sent().at(-1)!.input,{id:digest('chat-add-tell:'+removal),chat_id:OWNER,text:`Nocheh was removed from ${shown(chatIdFor('telegram',on),h.title(on))}.`});
    await h.adds.settle();assert.equal(sent().length,11,'told once');
    // Nor does a removal's line count toward the cap: with nine notes about leaving and that line in the 24 hours, the next
    // hidden adder's note still goes.
    await stores.control.query(`UPDATE chat_state_events SET updated_at=updated_at-interval '2 days' WHERE event_id=$1`,[events[0]]);
    const more=h.group(32),moreAdd=await h.status(more,32,ANONYMOUS,'left','member');
    await h.due();await h.adds.settle();
    assert.deepEqual([(await h.row(moreAdd)).outcome,(await h.row(moreAdd)).notice],['left','sent']);
    assert.equal(sent().length,12);

    // No owner chat: Nocheh still leaves, and tells no one.
    await stores.control.query(`UPDATE chat_state_events SET updated_at=updated_at-interval '2 days' WHERE notice='sent'`);
    const lone=new ChatAdds(stores.control,()=>({owner_id:null,owner_chat:null}),async(operation,input)=>{h.calls.push({operation,input});return {state:'done'};},h.repository);
    const nobody=h.group(40),nobodyAdd=await h.status(nobody,40,MEMBER,'left','member');
    await h.due();await lone.settle();
    assert.deepEqual([(await h.row(nobodyAdd)).outcome,(await h.row(nobodyAdd)).notice,(await h.chat(chatIdFor('telegram',nobody))).state],['left','none','left']);
    assert.equal(sent().length,12);

    // A notice that keeps failing is given up after ten tries.
    const failing=h.group(41),failingAdd=await h.status(failing,41,MEMBER,'left','member');
    h.answers.notice=()=>({state:'not_started',error_code:'telegram_not_connected'});
    for(let index=0;index<10;index++){await h.due();await h.adds.settle();}
    assert.deepEqual([(await h.row(failingAdd)).state,(await h.row(failingAdd)).outcome,(await h.row(failingAdd)).notice],['done','left','failed']);
    assert.equal(h.calls.filter(item=>item.input?.id===digest('chat-add-note:'+failingAdd)).length,10);
    assert.equal(h.calls.filter(item=>item.operation==='telegram.leave'&&item.input.id===failingAdd).length,1,'a note tried again never leaves again');
  }finally{await h.cleanup();await stores.close();}
});

test('the owner\'s add gets its own project and a card, in one owner command; the card\'s buttons move the group, take it out of projects or turn it off',fixture,async()=>{
  const stores=await open(),h=await harness(stores,'card');
  try {
    const fresh=h.group(1),legacy=h.group(2),answered=h.group(3),offAgain=h.group(4),third=h.group(5);
    await seedChats(stores.control,legacyChats([legacy]));
    const freshId=chatIdFor('telegram',fresh),answeredId=chatIdFor('telegram',answered),offId=chatIdFor('telegram',offAgain),thirdId=chatIdFor('telegram',third);
    // A group with a project answer already (none): a re-add keeps it and gets no card.
    await stores.control.query(`INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,NULL,'none',1)`,[answeredId]);
    const freshAdd=await h.status(fresh,1,Number(OWNER),'left','member'),legacyAdd=await h.status(legacy,2,Number(OWNER),'left','administrator');
    const answeredAdd=await h.status(answered,3,Number(OWNER),'left','member'),offAdd=await h.status(offAgain,4,Number(OWNER),'left','member');
    const thirdAdd=await h.status(third,5,Number(OWNER),'left','member');
    // The owner turns one off again during the wait: no project, no card.
    await h.repository.setState(owner,{chat_id:offId,state:'off',operation_id:'card-off:'+h.update(0)});
    // The projects a card offers: the three active ones updated last.
    const projects=[1,2,3,4].map(n=>digest('chat-adds-card:'+h.update(n)));
    for(const [index,project] of projects.entries())await stores.control.query(`INSERT INTO projects(id,name,description,state,revision,updated_at)
      VALUES($1,$2,'','active',1,now()+interval '1 day'+$3*interval '1 second')`,[project,'Shop '+(index+1),index]);
    const [,p2,p3,p4]=projects as [string,string,string,string];
    // The Telegram service is older than the card's rows of buttons for the legacy group's card: it refuses them, and the
    // card goes as text.
    h.answers.notice=input=>{if(input.buttons&&input.id===digest('chat-add-card:'+legacyAdd))throw new HttpError(400,'telegram_rejected_request');return {state:'done'};};

    const before=await h.epoch();
    await h.due();await h.adds.settle();
    assert.equal(await h.epoch(),before+3,'one owner command for each card\'s project');
    const auto=(event:string)=>digest('project:chat-add-project:'+event);
    for(const [chatId,event,value] of [[freshId,freshAdd,fresh],[legacy,legacyAdd,legacy],[thirdId,thirdAdd,third]] as const) {
      assert.deepEqual((await stores.control.query('SELECT name,state FROM projects WHERE id=$1',[auto(event)])).rows[0],{name:h.title(value),state:'active'});
      assert.deepEqual((await stores.control.query('SELECT project_id,mode FROM project_assignments WHERE space_id=$1',[chatId])).rows[0],{project_id:auto(event),mode:'assigned'});
      const saved=await h.row(event);
      assert.deepEqual([saved.state,saved.outcome,saved.notice,saved.project_id],['done','carded','sent',auto(event)]);
    }
    assert.deepEqual((await h.row(freshAdd)).offered,[p4,p3,p2],'the three active projects updated last');
    assert.deepEqual([(await h.row(answeredAdd)).outcome,(await h.row(offAdd)).outcome],['answered','superseded']);
    assert.deepEqual((await stores.control.query('SELECT project_id,mode,revision FROM project_assignments WHERE space_id=$1',[answeredId])).rows[0],{project_id:null,mode:'none',revision:1});
    assert.equal((await stores.control.query('SELECT count(*)::int AS n FROM projects WHERE id=ANY($1::text[])',[[auto(answeredAdd),auto(offAdd)]])).rows[0].n,0);

    const cards=h.calls.filter(item=>item.operation==='telegram.notice'),card=(event:string)=>cards.filter(item=>item.input.id===digest('chat-add-card:'+event));
    const text=(chatId:string,value:string)=>`Nocheh is on in ${shown(chatId,h.title(value))}, in its new project ${quoted(h.title(value))}. You can move it to another project, take it out of projects, or turn Nocheh off there.`;
    const freshCard=card(freshAdd);
    assert.equal(freshCard.length,1);
    assert.deepEqual(freshCard[0]!.input,{id:digest('chat-add-card:'+freshAdd),chat_id:OWNER,text:text(freshId,fresh),buttons:[
      [{text:'Move to Shop 4',callback:'ng0'+freshAdd.slice(0,32)},{text:'Move to Shop 3',callback:'ng1'+freshAdd.slice(0,32)},{text:'Move to Shop 2',callback:'ng2'+freshAdd.slice(0,32)}],
      [{text:'No project',callback:'ngx'+freshAdd.slice(0,32)},{text:'Turn off',callback:'ngo'+freshAdd.slice(0,32)}]]});
    assert.deepEqual(card(legacyAdd).map(item=>!!item.input.buttons),[true,false],'refused buttons: the card goes as text');
    assert.equal(card(legacyAdd)[1]!.input.text,text(legacy,legacy));
    assert.equal(card(answeredAdd).length+card(offAdd).length,0);
    const count=h.calls.length;
    await h.adds.settle();assert.equal(h.calls.length,count,'a second settle sends nothing');

    // Anyone else's press, or the owner's press outside their private chat, changes nothing.
    assert.equal(await h.press(chatAddData('0',freshAdd),ALICE),'Only the owner can do this.');
    assert.equal(await h.press(chatAddData('0',freshAdd),Number(OWNER),Number(fresh)),'Only the owner can do this.');
    assert.equal((await stores.control.query('SELECT project_id FROM project_assignments WHERE space_id=$1',[freshId])).rows[0].project_id,auto(freshAdd));

    // Move to the first offered project: one owner command; the card's own project, now empty, is archived; the card shows
    // the answer and loses its buttons.
    let epoch=await h.epoch();
    const first=digest('card:press:'+h.update(10)),moved=await h.press(chatAddData('0',freshAdd),Number(OWNER),Number(OWNER),first);
    assert.equal(moved,`${shown(freshId,h.title(fresh))} is now in ${quoted('Shop 4')}.`);
    assert.equal(await h.epoch(),epoch+1);
    assert.deepEqual((await stores.control.query('SELECT project_id,mode FROM project_assignments WHERE space_id=$1',[freshId])).rows[0],{project_id:p4,mode:'assigned'});
    assert.equal((await stores.control.query('SELECT state FROM projects WHERE id=$1',[auto(freshAdd)])).rows[0].state,'archived');
    const edit=h.calls.filter(item=>item.operation==='telegram.notice'&&item.input.edit).at(-1)!.input;
    assert.deepEqual(edit,{id:digest('chat-add-card:'+freshAdd),chat_id:OWNER,text:text(freshId,fresh)+'\n\n'+moved,edit:true});
    // The dispatch trying the same press again gets its receipt: nothing runs again.
    epoch=await h.epoch();
    assert.equal(await h.press(chatAddData('0',freshAdd),Number(OWNER),Number(OWNER),first),moved);assert.equal(await h.epoch(),epoch);
    // A card can keep its buttons (an edit that failed), and each later press runs on the group as it is now: Move to Shop
    // 2, then to Shop 4 again, ends in Shop 4, and each answer says where it is.
    const assigned=async()=>(await stores.control.query('SELECT project_id FROM project_assignments WHERE space_id=$1',[freshId])).rows[0].project_id;
    assert.equal(await h.press(chatAddData('2',freshAdd)),`${shown(freshId,h.title(fresh))} is now in ${quoted('Shop 2')}.`);
    assert.equal(await assigned(),p2);
    epoch=await h.epoch();
    assert.equal(await h.press(chatAddData('0',freshAdd)),moved);
    assert.equal(await h.epoch(),epoch+1);assert.equal(await assigned(),p4);

    // No project, in the old-shaped family.
    assert.equal(await h.press(chatAddData('x',legacyAdd)),`${shown(legacy,h.title(legacy))} is in no project now.`);
    assert.deepEqual((await stores.control.query('SELECT project_id,mode FROM project_assignments WHERE space_id=$1',[legacy])).rows[0],{project_id:null,mode:'none'});
    assert.equal((await stores.control.query('SELECT state FROM projects WHERE id=$1',[auto(legacyAdd)])).rows[0].state,'archived');

    // A card's own project another group joined meanwhile stays when the group moves on; then Turn off.
    await stores.control.query(`INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1)
      ON CONFLICT(space_id) DO UPDATE SET project_id=$2,mode='assigned',revision=project_assignments.revision+1`,[answeredId,auto(thirdAdd)]);
    assert.equal(await h.press(chatAddData('1',thirdAdd)),`${shown(thirdId,h.title(third))} is now in ${quoted('Shop 3')}.`);
    assert.equal((await stores.control.query('SELECT state FROM projects WHERE id=$1',[auto(thirdAdd)])).rows[0].state,'active');
    epoch=await h.epoch();
    const off=await h.press(chatAddData('o',thirdAdd));
    assert.equal(off,`Nocheh is off in ${shown(thirdId,h.title(third))}. It stays in the group, silent.`);
    assert.equal(await h.epoch(),epoch+1);
    const saved=await h.chat(thirdId);assert.deepEqual([saved.state,saved.state_seq],['off',null]);
    assert.equal(chats().served(thirdId),false);
    assert.equal(h.calls.filter(item=>item.operation==='telegram.notice'&&item.input.edit).at(-1)!.input.text,text(thirdId,third)+'\n\n'+off);
    // Turned on again from the dashboard, Turn off on the same card turns it off again; pressed once more while off, it
    // writes only a receipt.
    await h.repository.setState(owner,{chat_id:thirdId,state:'active',operation_id:'card-on:'+h.update(8)});
    assert.equal(chats().served(thirdId),true);
    epoch=await h.epoch();
    assert.equal(await h.press(chatAddData('o',thirdAdd)),off);
    assert.equal(await h.epoch(),epoch+1);
    assert.equal((await h.chat(thirdId)).state,'off');assert.equal(chats().served(thirdId),false);
    assert.equal(await h.press(chatAddData('o',thirdAdd)),off);
    assert.equal(await h.epoch(),epoch+2);assert.equal((await h.chat(thirdId)).state,'off');
    // Off is refused once Nocheh is out of the group, and a press for no card says the card is out of date.
    await h.status(third,6,ALICE,'member','kicked');
    assert.equal(await h.press(chatAddData('o',thirdAdd)),'This card is out of date. Change it in the dashboard.');
    const removed=await h.status(fresh,7,ALICE,'member','kicked');
    await stores.control.query('UPDATE chat_state_events SET state=\'done\' WHERE event_id=$1',[removed]);
    assert.equal(await h.press(chatAddData('o',freshAdd)),'This card is out of date. Change it in the dashboard.');
    assert.equal(await h.press(chatAddData('1','0'.repeat(64))),'This card is out of date. Change it in the dashboard.');
  }finally{await h.cleanup();await stores.close();}
});

test('a card tried again after its send did not go goes only while the group is still on from that add and in the card\'s project',fixture,async()=>{
  const stores=await open(),h=await harness(stores,'card-retry');
  try {
    const kept=h.group(1),off=h.group(2),removed=h.group(3),moved=h.group(4),tg=(value:string)=>chatIdFor('telegram',value);
    const auto=(event:string)=>digest('project:chat-add-project:'+event);
    // The bot cannot reach Telegram: each card makes its project, and its send is tried again later.
    h.answers.notice=()=>({state:'not_started',error_code:'telegram_not_connected'});
    const events:string[]=[];
    for(const [index,value] of [kept,off,removed,moved].entries())events.push(await h.status(value,index+1,Number(OWNER),'left','member'));
    const [keptAdd,offAdd,removedAdd,movedAdd]=events as [string,string,string,string];
    await h.due();await h.adds.settle();
    const cards=(event:string)=>h.calls.filter(item=>item.operation==='telegram.notice'&&item.input.id===digest('chat-add-card:'+event)).length;
    for(const event of events) {
      const saved=await h.row(event);
      assert.deepEqual([saved.state,saved.outcome,saved.notice,saved.attempts,saved.project_id],['waiting','carded','none',1,auto(event)]);
      assert.equal(cards(event),1);
    }
    // Meanwhile the owner turns one off on the dashboard, a member removes Nocheh from another, and the owner moves a third
    // to another project.
    await h.repository.setState(owner,{chat_id:tg(off),state:'off',operation_id:'retry-off:'+h.update(0)});
    const removal=await h.status(removed,5,ALICE,'member','kicked');
    const other=digest('chat-adds-retry:'+h.update(6));
    await stores.control.query(`INSERT INTO projects(id,name,description,state,revision) VALUES($1,'Shop','','active',1)`,[other]);
    await stores.control.query(`UPDATE project_assignments SET project_id=$2,revision=revision+1 WHERE space_id=$1`,[tg(moved),other]);

    // Telegram is back: only the group still on in its card's project gets its card. The others end with none, still
    // 'carded', and the removal is told once.
    h.answers.notice=()=>({state:'done'});
    const epoch=await h.epoch();
    await h.due();await h.adds.settle();
    assert.equal(cards(keptAdd),2);
    assert.deepEqual([(await h.row(keptAdd)).state,(await h.row(keptAdd)).outcome,(await h.row(keptAdd)).notice],['done','carded','sent']);
    for(const event of [offAdd,removedAdd,movedAdd]) {
      assert.equal(cards(event),1,event);
      const saved=await h.row(event);assert.deepEqual([saved.state,saved.outcome,saved.notice],['done','carded','none'],event);
    }
    assert.equal(h.calls.filter(item=>item.input?.id===digest('chat-add-tell:'+removal)).length,1);
    assert.deepEqual([(await h.row(removal)).outcome,(await h.row(removal)).notice],['told','sent']);
    // The moved group's card project, left with no group, is archived in one owner command; the others keep theirs.
    assert.equal(await h.epoch(),epoch+1);
    const state=async(event:string)=>(await stores.control.query('SELECT state FROM projects WHERE id=$1',[auto(event)])).rows[0].state;
    assert.deepEqual([await state(keptAdd),await state(offAdd),await state(removedAdd),await state(movedAdd)],['active','active','active','archived']);
    const count=h.calls.length;
    await h.due();await h.adds.settle();assert.equal(h.calls.length,count,'nothing is sent again');
    // A card an earlier try did deliver, though its answer was lost, still answers a press on the group as it is now.
    assert.equal(await h.press(chatAddData('o',offAdd)),`Nocheh is off in ${shown(tg(off),h.title(off))}. It stays in the group, silent.`);
  }finally{await h.cleanup();await stores.close();}
});

test('Nocheh removed from a group it was on in is told once; from a group that was off, nothing',fixture,async()=>{
  const stores=await open(),h=await harness(stores,'tell');
  try {
    const on=h.group(1),legacy=h.group(2),off=h.group(3);
    await seedChats(stores.control,legacyChats([legacy]));
    const onAdd=await h.status(on,1,Number(OWNER),'left','member'),legacyAdd=await h.status(legacy,2,Number(OWNER),'left','member');
    await h.send(off,{update_id:h.update(3),message:{message_id:3,date:1,chat:{id:Number(off),type:'supergroup',title:h.title(off)},from:{id:ALICE},text:'hi'}});
    // Removed before the card was due: the card is superseded, and the removal is told at once.
    const removals=[await h.status(on,4,ALICE,'administrator','kicked'),await h.status(legacy,5,ALICE,'member','left'),await h.status(off,6,ALICE,'member','kicked')];
    await h.due();await h.adds.settle();
    assert.deepEqual([(await h.row(onAdd)).outcome,(await h.row(legacyAdd)).outcome],['superseded','superseded']);
    const tells=h.calls.filter(item=>item.operation==='telegram.notice');
    assert.deepEqual(tells.map(item=>item.input),[
      {id:digest('chat-add-tell:'+removals[0]),chat_id:OWNER,text:`Nocheh was removed from ${shown(chatIdFor('telegram',on),h.title(on))}.`},
      {id:digest('chat-add-tell:'+removals[1]),chat_id:OWNER,text:`Nocheh was removed from ${shown(legacy,h.title(legacy))}.`}]);
    for(const event of removals.slice(0,2))assert.deepEqual([(await h.row(event)).state,(await h.row(event)).outcome,(await h.row(event)).notice],['done','told','sent']);
    assert.deepEqual([(await h.row(removals[2]!)).action,(await h.row(removals[2]!)).state,(await h.row(removals[2]!)).notice],['none','done','none']);
    await h.adds.settle();assert.equal(h.calls.length,2,'told once');
  }finally{await h.cleanup();await stores.close();}
});

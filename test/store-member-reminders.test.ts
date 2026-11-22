import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {chats,installChatsForTest} from '../src/chats.js';
import {HttpError} from '../src/http.js';
import {installMembersForTest} from '../src/members.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {noticeDigest} from '../src/notice-authorize.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {forgetMemberAppRechecks} from '../src/stores/member-reads.js';
import {memberTaskViews} from '../src/stores/member-task-views.js';
import {startMembers,type MemberDirectoryLoader} from '../src/stores/members.js';
import {authorizeNotice,recipientOf} from '../src/stores/task-reminder-delivery.js';
import {fixtureServices} from './fixture-agent.js';
import {BOB_ACCOUNT,GP1,GP2,GP3,GP_GROUP_IDS,MEMBER_GP,MEMBER_GP_ACCOUNT,MEMBER_GP_CHAT,MEMBER_GP_ID,MEMBER_NG,MEMBER_NG_ACCOUNT,MEMBER_NG_CHAT,MEMBER_NG_ID,
  NG1,NG_GROUP_IDS,OWNER,P1,P2,fixtureChats,fixtureDirectory,memberAppMembers,seedChats,seedGroups,seedMembers} from './fixture-groups.js';

// Reminders go to whoever set them (step 5, ADR-0265 D9, D10): a member's reminder reaches their own private chat with
// Nocheh, one message each, only after core's one-time yes; one set in a group falls back to the owner when it cannot
// reach them; one set in the members' app is skipped with one System › Health line per member per day. The fake
// gateway below asks core exactly as nocheh-telegram's send_notice does (authorizeNotice) before it "sends" to any chat
// but the owner's.

const fixture={skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000};
const served=[...GP_GROUP_IDS,...NG_GROUP_IDS];

test('reminders go to whoever set them: the member\'s own chat after core says yes once, the owner as before, or skipped with a Health line',fixture,async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),db=stores.control,root=await mkdtemp(join(tmpdir(),'nocheh-member-reminders-')),key='member-reminders:'+Date.now();
  const policy={enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:served,topic_memory:'group' as const},owner:Reader={admin:true,scope:null};
  const restoreChats=installChatsForTest(fixtureDirectory(served));
  const restoreMembers=installMembersForTest({members:[],accounts:[],chats:[],presence:[],owner_account:null});
  // The fake gateway: a chat that is not the owner's gets the notice only when core says yes for this id, chat and text
  // (as send_notice does), and the same id again is answered from its receipt. `gateway` 'down' fails before core is
  // asked; 'lost' sends but loses the answer once.
  const notices:Record<string,any>[]=[],receipts=new Map<string,{state:string}>();let gateway:'up'|'down'|'lost'='up';
  // Telegram's answer when a member's group is asked about again (telegram.member_status), and every ask.
  const statusAsks:Record<string,unknown>[]=[];let membership:'in'|'down'='in';
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='telegram.notice') {
        const id=String(input.id),chat=String(input.chat_id);
        if(receipts.has(id))return receipts.get(id)!;
        if(gateway==='down')throw Error('gateway unreachable');
        if(chat!==OWNER) {
          if(input.send_class!=='reminder'||input.topic!==undefined||input.buttons!==undefined)throw new HttpError(400,'notice_chat_not_allowed');
          if(!await authorizeNotice(db,{id,chat,text_digest:noticeDigest(String(input.text))},chats()))throw new HttpError(400,'notice_chat_not_allowed');
        }
        notices.push(input);receipts.set(id,{state:'done'});
        if(gateway==='lost'){gateway='up';throw new HttpError(500,'telegram_unavailable');}
        return {state:'done'};
      }
      if(operation==='telegram.member_status') {
        statusAsks.push(input);
        if(membership==='down')throw Error('telegram unreachable');
        return {state:'done',status:'in'};
      }
      throw Error('runtime_not_expected '+operation);
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  let serial=0,op=0,loader:MemberDirectoryLoader|null=null;const next=()=>key+':'+(++op);
  const capture=async(chat:string,from:string,text:string)=>{
    const label=String(++serial),value:Envelope={version:1,key:key+':'+label,origin:'live',kind:'telegram_update',bot_id:key,scope:chat,source_id:label,revision:'1',occurred_at:null,text,
      payload:{message:{message_id:serial,date:1700000000,chat:{id:Number(chat),type:'supergroup',is_forum:false},from:{id:Number(from),first_name:'Mira'},text}}};
    const source=(await s.capture.capture(value)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const turn=async(chat:string,from:string)=>{
    const source=(await capture(chat,from,'Remind me')).id,binding=await s.guards.state();
    return {admin:false,scope:chat,space:chat,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch} as Reader;
  };
  const soon=(minutes:number)=>new Date(Date.now()+minutes*60000).toISOString();
  const add=(body:Record<string,unknown>)=>s.tasks.create(owner,{operation_id:next(),...body});
  const revision=async(id:string)=>(await s.tasks.get(owner,id)).revision as number;
  // A change from the members' app, as part B's memberUpdate makes it: the member's account and Telegram name, no chat.
  const fromApp=async(id:string,body:Record<string,unknown>,who:{account:string;name:string;project:string;groups:string[]})=>{
    const [view]=await memberTaskViews(db,who.groups,'group');
    return (s.tasks as any).change(next(),id,{expected_revision:await revision(id),...body},{origin:'app',actor:{kind:'member',name:who.name},source:null,
      within:who.project,reach:view!.reach,chat:false,card:false,setter:{by:'person',account:who.account,name:who.name,chat:null,group:null,via:'app'}});
  };
  const mira={account:MEMBER_GP_ACCOUNT,name:'Mira',project:P1,groups:[GP1,GP3]};
  const due=(task:string)=>db.query("UPDATE owner_task_reminders SET remind_at=remind_at-interval '1 day' WHERE task_id=$1 AND state='pending'",[task]);
  const rows=async(task:string)=>(await db.query(`SELECT id,state,set_by,set_via,set_in_chat_id,set_in_group_id,deliver_chat,notice_digest,batch_id
    FROM owner_task_reminders WHERE task_id=$1 ORDER BY remind_at,id`,[task])).rows;
  const to=(chat:string)=>notices.filter(item=>String(item.chat_id)===chat);
  const skipped=async()=>(await db.query(`SELECT reference,state,status,detail FROM chat_sends WHERE error_code='reminder_skipped' ORDER BY reference`)).rows;
  const reset=async()=>{
    await db.query("UPDATE members SET state='active',reminders=true,private_chat=true WHERE id=ANY($1::text[])",[[MEMBER_GP_ID,MEMBER_NG_ID]]);
    await db.query('UPDATE member_chats SET enabled=true WHERE member_id=$1 AND chat_id=ANY($2::text[])',[MEMBER_GP_ID,[GP1,GP3]]);
    await db.query("DELETE FROM owner_task_reminder_batches");await db.query("DELETE FROM chat_sends WHERE error_code='reminder_skipped'");
    // Every pending reminder of the earlier steps is done with, so each step sees only its own.
    await db.query("UPDATE owner_task_reminders SET state='skipped' WHERE state IN ('pending','sending')");
    notices.length=0;
  };
  try {
    await seedChats(db,fixtureChats(served));await seedMembers(db,memberAppMembers());await seedGroups(db);
    await db.query('UPDATE member_chats SET enabled=true WHERE member_id=$1 AND chat_id=$2',[MEMBER_GP_ID,GP3]);
    await db.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1) ON CONFLICT(space_id) DO NOTHING",[NG1,P2]);
    // Telegram confirmed every membership an hour ago.
    await db.query("UPDATE chat_memberships SET checked_at=now()-interval '1 hour'");
    loader=await startMembers(db,()=>policy);
    await s.guards.reconcile();await s.guards.setMode('on');
    await db.query('DELETE FROM owner_tasks');await db.query("DELETE FROM chat_sends WHERE error_code='reminder_skipped'");

    // 1. Set in the members' app: the row names the member and the app, never a chat or group; what they wrote is kept
    // with no place either. A person's row with no chat that is not from the app is refused by the store.
    const hall=await add({title:'Book the hall',scope:P1,group:GP1,notes:'Two rooms'});
    await fromApp(hall.id,{reminders:[soon(10)],title:'Book the hall PREVIEWMARK'},mira);
    assert.deepEqual((await rows(hall.id)).map(row=>[row.set_by,row.set_via,row.set_in_chat_id,row.set_in_group_id,row.deliver_chat]),[['person','app',null,null,null]]);
    assert.deepEqual((await db.query('SELECT field,by,account_id,chat_id,group_id,via FROM owner_task_writers WHERE task_id=$1',[hall.id])).rows,
      [{field:'title',by:'person',account_id:MEMBER_GP_ACCOUNT,chat_id:null,group_id:null,via:'app'}]);
    await assert.rejects(db.query(`INSERT INTO owner_task_reminders(id,task_id,remind_at,set_by,set_by_account_id,set_by_name) VALUES($1,$2,now(),'person',$3,'Mira')`,
      [digest(key+':no-place'),hall.id,MEMBER_GP_ACCOUNT]),/owner_task_reminders_setter_check/);
    await assert.rejects(db.query(`INSERT INTO owner_task_reminders(id,task_id,remind_at,set_by,set_by_account_id,set_by_name,set_in_chat_id,set_in_group_id,set_via)
      VALUES($1,$2,now(),'person',$3,'Mira',$4,$4,'app')`,[digest(key+':app-in-chat'),hall.id,MEMBER_GP_ACCOUNT,GP1]),/owner_task_reminders_via_check/);
    // The owner sees who set it and where: in the members' app.
    assert.deepEqual((await s.tasks.get(owner,hall.id)).reminders.map((item:any)=>[item.set_by,item.source]),
      [['person','\u{1f464} Set by ⁨“Mira”⁩, a member in the members’ app']]);

    // 2. Due: it goes to Mira's own private chat only, one message, saying only "Set by you": no writer, closer or place
    // line, even with the owner's writer row naming another group. Core's yes was spent: a second ask is refused.
    await db.query(`INSERT INTO owner_task_writers(task_id,field,by,account_id,name,chat_id,group_id,via) VALUES($1,'notes','owner',NULL,NULL,$2,$2,'chat')`,[hall.id,GP2]);
    await due(hall.id);
    assert.equal(await s.tasks.remind(),1);
    assert.deepEqual(notices.map(item=>[String(item.chat_id),item.send_class,item.topic]),[[MEMBER_GP_CHAT,'reminder',undefined]]);
    assert.equal(notices[0]!.text,'⏰ Book the hall PREVIEWMARK\n\u{1f4c1} P1\n\n┆ Two rooms\n\n\u{1f464} Set by you');
    for(const absent of ['GP2','Last written','Closed by','members’ app','Mira'])assert.ok(!String(notices[0]!.text).includes(absent),absent);
    const [sent]=await rows(hall.id);
    assert.deepEqual([sent.state,sent.deliver_chat,sent.notice_digest,sent.batch_id],['sent',MEMBER_GP_CHAT,null,null]);
    assert.equal(await authorizeNotice(db,{id:sent.id,chat:MEMBER_GP,text_digest:noticeDigest(notices[0]!.text)},chats()),false,'core says yes once');
    assert.equal(await s.tasks.remind(),0,'nothing goes twice');

    // 3. Set by Mira in GP1 (a group turn): it goes to her too, not to the owner, and not merged.
    await reset();
    const band=await add({title:'Hire the band',scope:P1,group:GP1});
    await s.tasks.chatUpdate(await turn(GP1,MEMBER_GP),band.id,{expected_revision:band.revision,reminders:[soon(10)]});
    assert.deepEqual((await rows(band.id)).map(row=>[row.set_via,row.set_in_chat_id]),[['chat',GP1]]);
    await due(band.id);
    assert.equal(await s.tasks.remind(),1);
    assert.deepEqual([to(MEMBER_GP_CHAT).length,to(OWNER).length],[1,0]);
    assert.ok(String(to(MEMBER_GP_CHAT)[0]!.text).endsWith('\u{1f464} Set by you'));
    assert.equal((await db.query("SELECT count(*)::int AS n FROM owner_task_reminder_batches")).rows[0].n,0);

    // 4. Set in GP1 but Mira cannot be reached: paused, private chat off, reminders off, or a guest who is no member. It
    // comes to the owner as before, merged for the group, saying who set it.
    for(const [why,change] of [['paused',"state='paused'"],['private chat off','private_chat=false'],['reminders off','reminders=false']] as const) {
      await reset();
      const task=await add({title:'Group '+why,scope:P1,group:GP1});
      await s.tasks.chatUpdate(await turn(GP1,MEMBER_GP),task.id,{expected_revision:task.revision,reminders:[soon(10)]});
      await db.query(`UPDATE members SET ${change} WHERE id=$1`,[MEMBER_GP_ID]);
      await due(task.id);
      assert.equal(await s.tasks.remind(),1,why);
      assert.deepEqual([to(MEMBER_GP_CHAT).length,to(OWNER).length],[0,1],why);
      assert.match(String(to(OWNER)[0]!.text),/^\u{1f464} Set by ⁨“Mira”⁩.* in group /u,why);
      assert.equal((await rows(task.id))[0].deliver_chat,null,why);
    }
    await reset();
    const guest=await add({title:'Guest task',scope:P1,group:GP1});
    await db.query(`INSERT INTO owner_task_reminders(id,task_id,remind_at,set_by,set_by_account_id,set_by_name,set_in_chat_id,set_in_group_id)
      VALUES($1,$2,now()-interval '1 minute','person',$3,'Bob',$4,$4)`,[digest(key+':guest'),guest.id,BOB_ACCOUNT,GP1]);
    assert.equal(await s.tasks.remind(),1);
    assert.deepEqual([to(OWNER).length,notices.length],[1,1],'a guest\'s reminder comes to the owner');

    // 5. Set in the app but Mira cannot be reached: skipped, never sent to the owner, with one Health line for her per
    // day that counts them all and says why.
    await reset();
    const one=await add({title:'App one',scope:P1,group:GP1}),two=await add({title:'App two',scope:P1,group:GP3});
    for(const task of [one,two])await fromApp(task.id,{reminders:[soon(10)]},mira);
    await db.query('UPDATE members SET private_chat=false WHERE id=$1',[MEMBER_GP_ID]);
    await due(one.id);
    assert.equal(await s.tasks.remind(),1);
    assert.equal(notices.length,0,'an app reminder never falls back to the owner');
    assert.equal((await rows(one.id))[0].state,'skipped');
    let lines=await skipped();
    assert.equal(lines.length,1);
    assert.match(lines[0].reference,new RegExp('^reminders-skipped:'+MEMBER_GP_ID+':\\d{4}-\\d{2}-\\d{2}$'));
    assert.deepEqual([lines[0].state,lines[0].status,lines[0].detail],['failed',1,
      '1 reminder ⁨“Mira”⁩ set in the members’ app was not sent: their private chat with Nocheh is off.']);
    await db.query('UPDATE members SET private_chat=true,reminders=false WHERE id=$1',[MEMBER_GP_ID]);
    await due(two.id);
    assert.equal(await s.tasks.remind(),1);
    lines=await skipped();
    assert.deepEqual(lines.map(row=>[row.status,row.detail]),[[2,'2 reminders ⁨“Mira”⁩ set in the members’ app were not sent: '+
      '“Reminders to themselves” is off for them.']],'one line per member per day, its count the day\'s total');
    assert.ok((await s.chatSends.summary()).latest_problems.some((row:any)=>row.error_code==='reminder_skipped'),'it shows in System › Health');

    // 6. The task is no longer on her boards (she left GP1, or the task moved to GP2): skipped as well.
    await reset();
    const left=await add({title:'Left behind',scope:P1,group:GP1}),moved=await add({title:'Moved away',scope:P1,group:GP3});
    for(const task of [left,moved])await fromApp(task.id,{reminders:[soon(10)]},mira);
    await db.query('UPDATE member_chats SET enabled=false WHERE member_id=$1 AND chat_id=$2',[MEMBER_GP_ID,GP1]);
    await s.tasks.update(owner,moved.id,{operation_id:next(),expected_revision:await revision(moved.id),group:GP2});
    await due(left.id);await due(moved.id);
    assert.equal(await s.tasks.remind(),2);
    assert.equal(notices.length,0);
    assert.deepEqual([(await rows(left.id))[0].state,(await rows(moved.id))[0].state],['skipped','skipped']);
    assert.match((await skipped())[0].detail,/the task is no longer on their boards\.$/);
    assert.deepEqual(await recipientOf(db,{set_by:'person',account:MEMBER_GP_ACCOUNT,via:'chat',project:P1,group:GP2},
      {owner:OWNER,directory:chats(),topicMemory:'group'}),{lane:'owner',reason:'not_visible'},'set in a group, it would come to the owner');
    assert.deepEqual(await recipientOf(db,{set_by:'person',account:MEMBER_GP_ACCOUNT,via:'app',project:null,group:null},
      {owner:OWNER,directory:chats(),topicMemory:'group'}),{lane:'skip',member:MEMBER_GP_ID,reason:'not_visible'},'a personal task is never on a board');

    // 7. "Reminders to themselves" off: no new reminder in the app or in a group (403); removing her own still works.
    await reset();
    const quiet=await add({title:'Quiet',scope:P1,group:GP1});
    await fromApp(quiet.id,{reminders:[soon(10)]},mira);
    await db.query('UPDATE members SET reminders=false WHERE id=$1',[MEMBER_GP_ID]);
    await assert.rejects(fromApp(quiet.id,{reminders:[soon(10),soon(20)]},mira),{status:403,code:'task_reminders_off'});
    await assert.rejects(s.tasks.chatUpdate(await turn(GP1,MEMBER_GP),quiet.id,{expected_revision:await revision(quiet.id),reminders:[soon(10),soon(30)]}),
      {status:403,code:'task_reminders_off'});
    assert.equal((await rows(quiet.id)).filter(row=>row.state==='pending').length,1,'nothing changed');
    await fromApp(quiet.id,{reminders:[]},mira);
    assert.equal((await rows(quiet.id)).filter(row=>row.state==='pending').length,0,'her own reminder is removed');
    // The owner is never refused.
    await s.tasks.update(owner,quiet.id,{operation_id:next(),expected_revision:await revision(quiet.id),reminders:[soon(40)]});

    // 8. The gateway cannot be reached before core is asked: the claim stays unauthorized, so when Mira is paused before
    // the next pass, her group reminder goes back to the owner's merged lane; nothing reaches her chat.
    await reset();
    const late=await add({title:'Late',scope:P1,group:GP1});
    await s.tasks.chatUpdate(await turn(GP1,MEMBER_GP),late.id,{expected_revision:late.revision,reminders:[soon(10)]});
    await due(late.id);gateway='down';
    assert.equal(await s.tasks.remind(),0);
    let [claim]=await rows(late.id);
    assert.deepEqual([claim.state,claim.deliver_chat,typeof claim.notice_digest],['sending',MEMBER_GP_CHAT,'string']);
    gateway='up';await db.query("UPDATE members SET state='paused' WHERE id=$1",[MEMBER_GP_ID]);
    assert.equal(await s.tasks.remind(),1);
    assert.deepEqual([to(MEMBER_GP_CHAT).length,to(OWNER).length],[0,1]);
    [claim]=await rows(late.id);
    assert.deepEqual([claim.state,claim.deliver_chat,claim.notice_digest],['sent',null,null]);

    // 9. Core said yes and the gateway sent, but its answer was lost: the next pass sends the same id again, which the
    // gateway answers from its receipt, and it is sent once.
    await reset();
    const lost=await add({title:'Lost answer',scope:P1,group:GP1});
    await fromApp(lost.id,{reminders:[soon(10)]},mira);
    await due(lost.id);gateway='lost';
    assert.equal(await s.tasks.remind(),0);
    [claim]=await rows(lost.id);
    assert.deepEqual([claim.state,claim.deliver_chat,claim.notice_digest],['sending',MEMBER_GP_CHAT,null],'authorized: never routed again');
    await db.query('UPDATE members SET private_chat=false WHERE id=$1',[MEMBER_GP_ID]);
    assert.equal(await s.tasks.remind(),1);
    assert.equal((await rows(lost.id))[0].state,'sent');
    assert.deepEqual([to(MEMBER_GP_CHAT).length,(await skipped()).length],[1,0],'once, and not skipped after core said yes');

    // 10. Core's check, each condition on its own: the id, the chat (whole, as Telegram has it), the text, the state.
    await reset();
    const asked=await add({title:'Asked',scope:P1,group:GP1});
    await fromApp(asked.id,{reminders:[soon(10)]},mira);
    const [row]=await rows(asked.id),text='⏰ Asked',good={id:row.id,chat:MEMBER_GP,text_digest:noticeDigest(text)};
    assert.equal(await authorizeNotice(db,good,chats()),false,'pending: not being sent');
    await db.query(`UPDATE owner_task_reminders SET state='sending',deliver_chat=$2,notice_digest=$3 WHERE id=$1`,[row.id,MEMBER_GP_CHAT,good.text_digest]);
    for(const [why,request] of [['another text',{...good,text_digest:noticeDigest(text+' ')}],['another chat',{...good,chat:MEMBER_NG}],
      ['the chat with a sign',{...good,chat:'+'+MEMBER_GP}],['the owner\'s chat',{...good,chat:OWNER}],['another id',{...good,id:digest(key+':other')}]] as const)
      assert.equal(await authorizeNotice(db,request,chats()),false,why);
    await db.query("UPDATE members SET reminders=false WHERE id=$1",[MEMBER_GP_ID]);
    assert.equal(await authorizeNotice(db,good,chats()),false,'reminders turned off since it was claimed');
    await db.query("UPDATE members SET reminders=true WHERE id=$1",[MEMBER_GP_ID]);
    assert.equal(await authorizeNotice(db,good,chats()),true);
    assert.equal(await authorizeNotice(db,good,chats()),false,'once');

    // 11. The other family: Nils (a member first seen after step 2b, with a digest chat id) in NG1 and project P2.
    await reset();
    const nils={account:MEMBER_NG_ACCOUNT,name:'Nils',project:P2,groups:[NG1]};
    const ng=await add({title:'Paint the hall',scope:P2,group:NG1});
    await fromApp(ng.id,{reminders:[soon(10)]},nils);
    await due(ng.id);
    assert.equal(await s.tasks.remind(),1);
    assert.deepEqual(notices.map(item=>String(item.chat_id)),[MEMBER_NG],'to Nils\'s chat where it is in Telegram');
    assert.deepEqual((await rows(ng.id)).map(item=>[item.state,item.deliver_chat]),[['sent',MEMBER_NG_CHAT]]);

    // 12. Freshness, as the members' app has it: Mira's groups were last confirmed 7 hours ago, past MEMBER_RECHECK_HOURS.
    // Before her reminder goes, Telegram is asked again; when it confirms her groups, the reminder reaches her chat.
    await reset();forgetMemberAppRechecks();statusAsks.length=0;
    const confirmed=await add({title:'Confirmed again',scope:P1,group:GP1});
    await fromApp(confirmed.id,{reminders:[soon(10)]},mira);
    const old="UPDATE chat_memberships SET checked_at=now()-interval '7 hours' WHERE account_id=$1";
    await db.query(old,[MEMBER_GP_ACCOUNT]);await due(confirmed.id);
    assert.equal(await s.tasks.remind(),1);
    assert.deepEqual([to(MEMBER_GP_CHAT).length,to(OWNER).length],[1,0]);
    assert.deepEqual(statusAsks.map(item=>String(item.user_id)).sort(),[MEMBER_GP,MEMBER_GP],'both her groups asked about, for her');
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM chat_memberships WHERE account_id=$1 AND checked_at>now()-interval '1 minute'`,[MEMBER_GP_ACCOUNT])).rows[0].n,2);
    // When Telegram cannot be asked, nothing older than MEMBER_RECHECK_HOURS counts (fail closed): her app reminder is
    // skipped with the Health line, and the one she set in GP1 comes to the owner as before.
    await reset();forgetMemberAppRechecks();statusAsks.length=0;membership='down';
    const unconfirmed=await add({title:'Not confirmed',scope:P1,group:GP1}),fromGroup=await add({title:'Group not confirmed',scope:P1,group:GP1});
    await fromApp(unconfirmed.id,{reminders:[soon(10)]},mira);
    await s.tasks.chatUpdate(await turn(GP1,MEMBER_GP),fromGroup.id,{expected_revision:fromGroup.revision,reminders:[soon(10)]});
    await db.query(old,[MEMBER_GP_ACCOUNT]);await due(unconfirmed.id);await due(fromGroup.id);
    assert.equal(await s.tasks.remind(),2);
    assert.ok(statusAsks.length>0,'Telegram was asked');
    assert.deepEqual([to(MEMBER_GP_CHAT).length,to(OWNER).length],[0,1]);
    assert.equal((await rows(unconfirmed.id))[0].state,'skipped');
    assert.match((await skipped())[0].detail,/the task is no longer on their boards\.$/);
    assert.match(String(to(OWNER)[0]!.text),/Group not confirmed/);
    // A re-check that cannot run at all reaches no board either.
    assert.deepEqual(await recipientOf(db,{set_by:'person',account:MEMBER_GP_ACCOUNT,via:'app',project:P1,group:GP1},
      {owner:OWNER,directory:chats(),topicMemory:'group',recheck:async()=>{throw Error('no runtime');}}),{lane:'skip',member:MEMBER_GP_ID,reason:'not_visible'});
    membership='in';

    // 9. A member's private app reminder is hers alone (ADR-0265 D6, D9): no group sees its time, a group's list never
    // removes it, and another's reminder at the same minute neither stands in for hers nor blocks a group's own. The
    // group's other writer here is the owner speaking in GP1: a chat setter, so it is held to the group's own rows.
    await reset();
    const shared=await add({title:'Shared minute',scope:P1,group:GP1});
    const at=soon(90);
    await fromApp(shared.id,{reminders:[at]},mira);
    const inGroup=await s.tasks.chatGet(await turn(GP1,MEMBER_GP),shared.id) as any;
    assert.deepEqual(inGroup.reminders,[],'a group never sees her app reminder or its time');
    await s.tasks.chatUpdate(await turn(GP1,OWNER),shared.id,{expected_revision:await revision(shared.id),reminders:[soon(120)]});
    assert.deepEqual((await rows(shared.id)).map(row=>[row.set_via,row.state]),[['app','pending'],['chat','pending']],'a group\'s list leaves her app reminder');
    await s.tasks.chatUpdate(await turn(GP1,OWNER),shared.id,{expected_revision:await revision(shared.id),reminders:[at]});
    assert.deepEqual((await rows(shared.id)).map(row=>[row.set_via,row.state]).sort(),[['app','pending'],['chat','pending']],
      'a group\'s reminder at her minute is the group\'s own; the one it left out is removed');
    assert.deepEqual((await s.tasks.chatGet(await turn(GP1,MEMBER_GP),shared.id) as any).reminders.length,1,'the group sees only its own');
    const wholeList=(await s.tasks.get(owner,shared.id)).reminders as any[];
    assert.equal(wholeList.length,2,'the owner sees both');
    // The owner's reminder at another minute: hers at that minute is still set, as hers.
    const ownerAt=soon(150);
    await s.tasks.update(owner,shared.id,{operation_id:next(),expected_revision:await revision(shared.id),reminders:[...wholeList.map(item=>item.at),ownerAt]});
    await fromApp(shared.id,{reminders:[at,ownerAt]},mira);
    assert.deepEqual((await db.query(`SELECT set_by,set_via FROM owner_task_reminders WHERE task_id=$1 AND state='pending' AND date_trunc('minute',remind_at)=date_trunc('minute',$2::timestamptz)
      ORDER BY set_by`,[shared.id,ownerAt])).rows,[{set_by:'owner',set_via:'chat'},{set_by:'person',set_via:'app'}],'the owner\'s at that minute never stands in for hers');
  } finally {loader?.stop();restoreMembers();restoreChats();await stores.close();await rm(root,{recursive:true,force:true});}
});

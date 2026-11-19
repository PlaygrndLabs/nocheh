import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {HttpError} from '../src/http.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {installMembersForTest,memberDirectory,type MemberDirectory} from '../src/members.js';
import {memberPrivateDailyLimitReply,notAllowedPrivateReply} from '../src/prompts.js';
import {readSet,sourceChat} from '../src/spaces.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {memberChatClosed,memberReads,recheckMemberGroups} from '../src/stores/member-reads.js';
import {storageWorkflowOperations} from '../src/stores/workflow-operations.js';
import {fixtureServices,type FakeCall} from './fixture-brain.js';
import type {RuntimeCall} from '../src/runtime.js';
import {BOB,BOB_CHAT,GP1,GP2,GP3,GP_GROUP_IDS,MEMBER_GP,MEMBER_GP_ACCOUNT,MEMBER_GP_CHAT,MEMBER_GP_ID,MEMBER_GP_OFF,MEMBER_GP_OFF_CHAT,MEMBER_NG,MEMBER_NG_ACCOUNT,
  MEMBER_NG_CHAT,MEMBER_NG_ID,NG1,NG1_TG,NG2,NG2_TG,NG_GROUP_IDS,OWNER,UNSERVED,fixtureChats,fixtureMemberDirectory,fixtureMembers,groupsPolicy,seedChats,
  seedMembers} from './fixture-groups.js';

/*
 * Step 4 (ADR-0262), part A: who may talk to Nocheh in their own private chat, the groups that chat reads (the 30-day
 * rule and the re-check before a turn), the private daily cap, the passes a member's turns carry, and that a member's
 * private turn never acts. Both fixture families: MEMBER_GP's chat keeps an old-shaped id, MEMBER_NG's is a digest.
 *
 * Reading as a member (bindReads, canRead) is another part's; here the reader is bound the way the contract says it is,
 * from memberReads, so this test checks the dispatch, the passes and the effects around it.
 */
test('a member\'s private chat: admission, its groups, the daily cap, its passes, and nothing but reading',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-member-private-')),key='member-private:'+Date.now();
  const policy=groupsPolicy({group_ids:[...GP_GROUP_IDS,...NG_GROUP_IDS]});
  const refusals:Record<string,any>[]=[],turns:Record<string,any>[]=[],asked:Record<string,any>[]=[];
  let status:(input:Record<string,unknown>)=>Record<string,unknown>|Promise<Record<string,unknown>>=()=>({state:'done',status:'in'});
  const runtime:FakeCall=async(operation,input)=>{
    if(operation==='guard.detect')return {literals:[]};
    if(operation==='telegram.refusal'){refusals.push(input);return {state:'done'};}
    if(operation==='telegram.member_status'){asked.push(input);return status(input);}
    if(operation==='run.start'){turns.push(input);return {state:'done',stage:'assistant'};}
    if(operation==='run.resume')return {state:'done'};
    return {state:'done'};
  };
  const call=runtime as RuntimeCall;
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>policy,groupReplies:{mode:'addressed',names:['Nocheh']},
    runtime,memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  // Reading as a member is bound as the contract says (another part writes it): the chat's reads from memberReads, and
  // of the archive only that member's own chat. Every other reader reads as before.
  const bindReads=s.access.bindReads.bind(s.access),canRead=s.access.canRead.bind(s.access);
  s.access.bindReads=async(principal:Reader)=>{
    if(principal.member===undefined)return bindReads(principal);
    const reads=principal.scope?await memberReads(stores.control,principal.scope):null;
    if(!reads||reads.member!==principal.member)throw new HttpError(409,memberChatClosed);
    return {...principal,reads:readSet({home:reads.chat,whole:reads.groups.map(group=>group.chat)}),memberChat:reads.chat};
  };
  s.access.canRead=async(principal,reference,binding,options)=>{
    if(principal.memberChat===undefined)return canRead(principal,reference,binding,options);
    return sourceChat(await s.access.archive.verify(reference))===principal.memberChat;
  };
  let restore=installMembersForTest(fixtureMemberDirectory());
  const use=(directory:MemberDirectory)=>{restore();restore=installMembersForTest(directory);};
  const bot=String(Date.now()).slice(-9);let update=0;
  /** One live Telegram message in chat `telegram` (a Telegram id) from `from`. Only a message the test dispatches carries
   * its update id: a turn waits for an earlier update in its chat that has not started. */
  const capture=async(telegram:string,from:string,text:string,type='private',ordered=false,extra:Record<string,unknown>={})=>{
    const n=++update,message={message_id:n,date:1700000000+n,chat:{id:Number(telegram),type},from:{id:Number(from),is_bot:false,first_name:'Someone'},text,...extra};
    return (await s.capture.capture({version:1,key:`telegram:${bot}:update:${n}`,origin:'live',kind:'telegram_update',bot_id:bot,scope:telegram,
      source_id:String(n),revision:'1',occurred_at:null,text,payload:ordered?{update_id:n,message}:{message}} as Envelope)).source.reference;
  };
  const epoch=async(family:string)=>({owner:'inngest' as const,epoch:Number((await stores.control.query('SELECT epoch FROM workflow_owners WHERE family=$1',[family])).rows[0].epoch)});
  const dispatch=async(telegram:string,from:string,text:string,type='private',extra:Record<string,unknown>={})=>{
    const source=await capture(telegram,from,text,type,true,extra);
    await s.preparation.run(source.id,async()=>{throw Error('unexpected download');},'fixture',s.detect,await epoch('preparation'));
    await s.telegram.run(source.id,await epoch('telegram'));
    const row=(await stores.control.query('SELECT state,error_code FROM dispatches WHERE event_id=$1',[source.id])).rows[0];
    const turn=turns.find(item=>item.event_id===source.id);
    return {id:source.id,state:row?.state as string,error_code:row?.error_code as string|null,turn:!!turn,claims:turn?claimsOf(String(turn.archive_credential)):null,
      reply:turn?.reply as {line:string;text:string;by:string;id:string}|undefined,body:turn};
  };
  const claimsOf=(credential:string)=>JSON.parse(Buffer.from(credential.split('.')[1]!,'base64url').toString()) as Record<string,unknown>;
  /** Sets when Telegram last confirmed an account's row in a group, `days` ago. */
  const confirmed=async(account:string,chat:string,days:number,state:'in'|'left'='in')=>stores.control.query(`UPDATE chat_memberships SET state=$3,
    checked_at=now()-make_interval(secs=>$4::float8*86400) WHERE account_id=$1 AND chat_id=$2`,[account,chat,state,days]);
  const groupsOf=async(chat:string)=>(await memberReads(stores.control,chat))?.groups.map(group=>group.chat)??null;
  const revision=async()=>Number((await stores.control.query('SELECT revision FROM member_directory_state WHERE singleton')).rows[0].revision);
  try {
    await seedChats(stores.control,fixtureChats([...GP_GROUP_IDS,...NG_GROUP_IDS]));await seedMembers(stores.control);
    await stores.control.query('DELETE FROM member_turns WHERE member_id=ANY($1::text[])',[[MEMBER_GP_ID,MEMBER_NG_ID]]);
    await stores.control.query(`UPDATE owner_prompts SET texts='{}'::jsonb WHERE singleton`);
    await s.guards.reconcile();await s.guards.setMode('on');

    // The groups a member's private chat reads: served, not switched off, and Telegram's newest row says 'in' and was
    // confirmed within 30 days. MEMBER_GP: GP1 in, GP2 left, GP3 switched off, UNSERVED not served.
    for(const chat of [GP1,GP3,UNSERVED])await confirmed(MEMBER_GP_ACCOUNT,chat,1/24);
    await confirmed(MEMBER_GP_ACCOUNT,GP2,1/24,'left');
    assert.deepEqual(await memberReads(stores.control,MEMBER_GP_CHAT).then(reads=>reads&&{...reads,groups:reads.groups.map(group=>group.chat),stale:reads.stale.map(group=>group.chat)}),
      {member:MEMBER_GP_ID,chat:MEMBER_GP_CHAT,groups:[GP1],stale:[]});
    await confirmed(MEMBER_GP_ACCOUNT,GP1,29);assert.deepEqual(await groupsOf(MEMBER_GP_CHAT),[GP1],'29 days: still in');
    await confirmed(MEMBER_GP_ACCOUNT,GP1,31);assert.deepEqual(await groupsOf(MEMBER_GP_CHAT),[],'31 days: left out');
    await stores.control.query('UPDATE chat_memberships SET checked_at=NULL WHERE account_id=$1 AND chat_id=$2',[MEMBER_GP_ACCOUNT,GP1]);
    assert.deepEqual(await groupsOf(MEMBER_GP_CHAT),[],'never confirmed: left out');
    // MEMBER_NG: NG1 (switched on) and NG2 (no switch row, so on), sorted by chat id.
    await confirmed(MEMBER_NG_ACCOUNT,NG1,1/24);await confirmed(MEMBER_NG_ACCOUNT,NG2,2);
    assert.deepEqual(await groupsOf(MEMBER_NG_CHAT),[NG1,NG2].sort());
    // Nobody else's chat is a member chat: private chat off, a stranger, the owner, a group, an unknown chat.
    for(const chat of [MEMBER_GP_OFF_CHAT,BOB_CHAT,OWNER,GP1,NG1,'9876'])assert.equal(await memberReads(stores.control,chat),null,chat);
    // Paused, or private chat off, closes it at once, whatever the directory of this process says.
    for(const change of ["state='paused'",'private_chat=false']) {
      await stores.control.query(`UPDATE members SET ${change} WHERE id=$1`,[MEMBER_NG_ID]);
      assert.equal(await memberReads(stores.control,MEMBER_NG_CHAT),null,change);
      await stores.control.query(`UPDATE members SET state='active',private_chat=true WHERE id=$1`,[MEMBER_NG_ID]);
    }

    // Asked again: only groups confirmed more than six hours ago (NG2), for the account seen there, at its current id.
    // Telegram's 'left' writes left, as checked, and moves the member revision; the group is gone at once.
    const before=await revision();status=()=>({state:'done',status:'left'});
    let reads=(await memberReads(stores.control,MEMBER_NG_CHAT))!;
    assert.deepEqual(await recheckMemberGroups(stores.control,call,reads),{past:[],moved:true});
    assert.deepEqual(asked.at(-1),{chat_id:NG2_TG,user_id:MEMBER_NG});assert.equal(asked.length,1);
    const row=async(chat:string)=>(await stores.control.query('SELECT state,source,checked_at>now()-interval \'1 minute\' AS fresh FROM chat_memberships WHERE account_id=$1 AND chat_id=$2',
      [MEMBER_NG_ACCOUNT,chat])).rows[0];
    assert.deepEqual(await row(NG2),{state:'left',source:'checked',fresh:true});
    assert.equal(await revision(),before+1);assert.deepEqual(await groupsOf(MEMBER_NG_CHAT),[NG1]);
    // A failed call or an answer it cannot read changes nothing; 'in' confirms it again, with no revision move.
    await confirmed(MEMBER_NG_ACCOUNT,NG2,2);reads=(await memberReads(stores.control,MEMBER_NG_CHAT))!;
    for(const answer of [()=>{throw new HttpError(503,'telegram_unavailable');},()=>({state:'not_started'}),()=>({state:'done',status:'maybe'})]) {
      status=answer;assert.deepEqual(await recheckMemberGroups(stores.control,call,reads),{past:[],moved:false});
      assert.deepEqual(await row(NG2),{state:'in',source:'checked',fresh:false});
    }
    status=()=>({state:'done',status:'in'});const steady=await revision();
    assert.deepEqual(await recheckMemberGroups(stores.control,call,reads),{past:[],moved:false});
    assert.deepEqual(await row(NG2),{state:'in',source:'checked',fresh:true});assert.equal(await revision(),steady);
    // A group last confirmed more than 30 days ago is not read, but is asked again too; Telegram's 'in' brings it back.
    await confirmed(MEMBER_NG_ACCOUNT,NG2,31);reads=(await memberReads(stores.control,MEMBER_NG_CHAT))!;
    assert.deepEqual([reads.groups.map(group=>group.chat),reads.stale.map(group=>group.chat)],[[NG1],[NG2]]);
    asked.splice(0);assert.deepEqual(await recheckMemberGroups(stores.control,call,reads),{past:[],moved:false});
    assert.deepEqual(asked,[{chat_id:NG2_TG,user_id:MEMBER_NG}]);assert.deepEqual(await groupsOf(MEMBER_NG_CHAT),[NG1,NG2].sort());
    // A leave written while Telegram was asked stays: the late 'in' answer is for a row that no longer says so.
    await confirmed(MEMBER_NG_ACCOUNT,NG2,2);reads=(await memberReads(stores.control,MEMBER_NG_CHAT))!;
    status=async()=>{
      await stores.control.query(`UPDATE chat_memberships SET state='left',source='event',checked_at=now() WHERE account_id=$1 AND chat_id=$2`,[MEMBER_NG_ACCOUNT,NG2]);
      return {state:'done',status:'in'};
    };
    assert.deepEqual(await recheckMemberGroups(stores.control,call,reads),{past:[],moved:false});
    assert.deepEqual(await row(NG2),{state:'left',source:'event',fresh:true});assert.deepEqual(await groupsOf(MEMBER_NG_CHAT),[NG1]);
    // Groups Telegram does not answer move behind the others: with room for one check, a failed one lets the next one
    // be asked on the following turn, and the one not asked is left out of that turn.
    await confirmed(MEMBER_NG_ACCOUNT,NG1,3);await confirmed(MEMBER_NG_ACCOUNT,NG2,2);reads=(await memberReads(stores.control,MEMBER_NG_CHAT))!;
    status=()=>({state:'not_started'});asked.splice(0);
    assert.deepEqual(await recheckMemberGroups(stores.control,call,reads,Date.now(),1),{past:[NG2],moved:false});
    assert.deepEqual(await recheckMemberGroups(stores.control,call,reads,Date.now(),1),{past:[NG1],moved:false});
    assert.deepEqual(asked.map(input=>input.chat_id),[NG1_TG,NG2_TG]);
    await confirmed(MEMBER_NG_ACCOUNT,NG1,1/24);await confirmed(MEMBER_NG_ACCOUNT,NG2,2);status=()=>({state:'done',status:'in'});

    // Preparation: a member's open private chat is prepared like the owner's; private chat off, and a stranger, are not.
    const operations=storageWorkflowOperations(s,async()=>{throw Error('unexpected download');});
    const prepared=async(telegram:string,from:string)=>(await operations.preparation!((await capture(telegram,from,'hello')).id,await epoch('preparation'))).waiting_reason;
    assert.notEqual(await prepared(MEMBER_NG,MEMBER_NG),'not_allowed');assert.notEqual(await prepared(MEMBER_GP,MEMBER_GP),'not_allowed');
    assert.equal(await prepared(MEMBER_GP_OFF,MEMBER_GP_OFF),'not_allowed');assert.equal(await prepared(BOB,BOB),'not_allowed');

    // Admission. Private chat off, a stranger, a paused member and a removed one get the fixed private reply (the bot
    // sends it at most once a day) and no turn.
    const refused=async(label:string,chat:string,from:string,changed:MemberDirectory|null)=>{
      if(changed)use(changed);const count=refusals.length,result=await dispatch(chat,from,'Hi Nocheh');use(fixtureMemberDirectory());
      assert.deepEqual([result.state,result.error_code,result.turn,refusals.length],['suppressed','not_allowed',false,count+1],label);
      assert.deepEqual([refusals.at(-1)!.private,refusals.at(-1)!.once,refusals.at(-1)!.reply,refusals.at(-1)!.user_id],[true,undefined,notAllowedPrivateReply,from],label);
    };
    await refused('private chat off',MEMBER_GP_OFF,MEMBER_GP_OFF,null);
    await refused('a stranger',BOB,BOB,null);
    await refused('paused',MEMBER_NG,MEMBER_NG,fixtureMemberDirectory({[MEMBER_NG_ID]:{state:'paused'}}));
    await refused('private chat switched off',MEMBER_NG,MEMBER_NG,fixtureMemberDirectory({[MEMBER_NG_ID]:{private_chat:false}}));
    const fixture=fixtureMembers();
    await refused('removed',MEMBER_NG,MEMBER_NG,memberDirectory({...fixture,members:fixture.members.filter(item=>item.id!==MEMBER_NG_ID),
      accounts:fixture.accounts.filter(item=>item.member_id!==MEMBER_NG_ID),chats:fixture.chats.filter(item=>item.member_id!==MEMBER_NG_ID)}));
    // Admitted in the directory, but closed in storage by the time it binds: the fixed reply too, never a turn.
    await stores.control.query(`UPDATE members SET state='paused' WHERE id=$1`,[MEMBER_NG_ID]);
    try{await refused('paused in storage',MEMBER_NG,MEMBER_NG,null);}
    finally{await stores.control.query(`UPDATE members SET state='active' WHERE id=$1`,[MEMBER_NG_ID]);}

    // An active member with private chat on: every message is a turn, with no addressing, after their stale groups are
    // asked again. The pass is a member pass for their own chat, with their lane, and no project.
    await confirmed(MEMBER_NG_ACCOUNT,NG2,2);const calls=asked.length;
    const mine=await dispatch(MEMBER_NG,MEMBER_NG,'what is new in my groups?');
    assert.equal(mine.turn,true);assert.equal(asked.length,calls+1,'NG2 is asked again first');
    assert.deepEqual({scope:mine.claims!.scope,space:mine.claims!.space,member:mine.claims!.member,lane:mine.claims!.lane,project:mine.claims!.project,
      answer:mine.claims!.answer,member_read:mine.claims!.member_read},
      {scope:MEMBER_NG_CHAT,space:MEMBER_NG_CHAT,member:MEMBER_NG_ID,lane:MEMBER_NG_ID,project:undefined,answer:undefined,member_read:undefined});
    // In the old-shaped family too. GP1, never confirmed so not read, is asked as well, and Telegram's 'in' brings it back.
    assert.deepEqual(await groupsOf(MEMBER_GP_CHAT),[]);
    assert.deepEqual([(await dispatch(MEMBER_GP,MEMBER_GP,'anything for me?')).claims?.member,await groupsOf(MEMBER_GP_CHAT)],[MEMBER_GP_ID,[GP1]]);
    // Their group turns carry their lane but never a member claim; the owner's carry neither.
    const group=await dispatch(NG1_TG,MEMBER_NG,'Nocheh, what is open?','supergroup');
    assert.deepEqual([group.turn,group.claims!.scope,group.claims!.lane,group.claims!.member],[true,NG1,MEMBER_NG_ID,undefined]);
    const owners=await dispatch(NG1_TG,OWNER,'Nocheh, and for me?','supergroup');
    assert.deepEqual([owners.turn,owners.claims!.lane,owners.claims!.member],[true,undefined,undefined]);
    const ownChat=await dispatch(OWNER,OWNER,'hello');
    assert.deepEqual([ownChat.turn,ownChat.claims!.scope,ownChat.claims!.lane,ownChat.claims!.member],[true,null,undefined,undefined]);

    // The reply block (ADR-0261) in a member's private chat is built as that member reads (ADR-0262): Nocheh's answer in
    // their own chat, with its text, and a message of a group they read; never the owner's private chat nor another
    // member's, and never a Telegram ID. In the owner's chat, a reply to Nocheh's answer to an ask about a member gives
    // no block, so that member's words never reach the owner's turn, its notes or what it learns.
    const said=async(telegram:string,text:string,send_class:string)=>{
      const n=++update,message={message_id:n,date:1700000000+n,chat:{id:Number(telegram),type:'private'},from:{id:Number(bot),is_bot:true,first_name:'Nocheh'},text};
      const source=(await s.capture.capture({version:1,key:`${key}:sent:${n}`,origin:'live',kind:'telegram_delivered_message',bot_id:bot,scope:telegram,
        source_id:String(n),revision:'1',occurred_at:String(message.date),text,payload:{message,send_class}} as Envelope)).source.reference;
      await s.guards.prepare(source,'fixture',s.detect);return {id:source.id,message};
    };
    const written=async(telegram:string,from:string,text:string,type:string)=>{
      const source=await capture(telegram,from,text,type);await s.guards.prepare(source,'fixture',s.detect);
      return {id:source.id,external:{chat:{id:Number(telegram),type},message_id:update}};
    };
    const noIds=(value:unknown)=>{const text=JSON.stringify(value);for(const id of [MEMBER_NG,MEMBER_GP,OWNER,NG1_TG,bot])assert.ok(!text.includes(id),'no Telegram ID: '+id);};
    const shift=await said(MEMBER_NG,'Your shift starts at 09:00.','reply');
    const toShift=await dispatch(MEMBER_NG,MEMBER_NG,'source?','private',{reply_to_message:shift.message});
    assert.equal(toShift.claims!.member,MEMBER_NG_ID);
    assert.deepEqual([toShift.reply?.by,toShift.reply?.text,toShift.reply?.id],['nocheh','Your shift starts at 09:00.',shift.id]);
    assert.ok(toShift.reply!.line.startsWith('[Replying to, by=nocheh: Nocheh, Nocheh\'s reply · this chat · ')&&toShift.reply!.line.endsWith(`(source nocheh:event:${shift.id})`),
      toShift.reply!.line);
    assert.equal(toShift.body!.speaker,undefined);noIds(toShift.reply);
    const inGroup=await written(NG1_TG,MEMBER_NG,'Lunch moves to 13:00','supergroup');
    const toGroup=await dispatch(MEMBER_NG,MEMBER_NG,'is that still true?','private',{external_reply:inGroup.external});
    assert.deepEqual([toGroup.reply?.by,toGroup.reply?.id],['person',inGroup.id],'a group the member reads');noIds(toGroup.reply);
    const ownerWords=await written(OWNER,OWNER,'The owner\'s private plan','private');
    const otherMember=await written(MEMBER_GP,MEMBER_GP,'Mira\'s private words','private');
    for(const [why,target] of [['the owner\'s private chat',ownerWords],['another member\'s private chat',otherMember]] as const) {
      const turn=await dispatch(MEMBER_NG,MEMBER_NG,'and this?','private',{external_reply:target.external});
      assert.equal(turn.turn,true,why);assert.equal(turn.reply,undefined,why);
      assert.ok(!JSON.stringify(turn.body).includes(target.id),why);
    }
    const answered=await said(OWNER,'From Nils\'s private chat: they start at 09:00.','member_read');
    const toAsk=await dispatch(OWNER,OWNER,'why?','private',{reply_to_message:answered.message});
    assert.deepEqual([toAsk.turn,toAsk.reply],[true,undefined]);
    assert.ok(!JSON.stringify(toAsk.body!.reply??null).includes('09:00')&&!JSON.stringify(toAsk.body).includes(answered.id),'no block, no id of the ask\'s answer');
    const plain=await said(OWNER,'Your flight is on Friday.','reply');
    assert.deepEqual((await dispatch(OWNER,OWNER,'source?','private',{reply_to_message:plain.message})).reply?.id,plain.id,'the owner\'s own reply still has its block');

    // The daily cap counts private and group turns together; over it, the private daily-limit reply (at most once a
    // day, `once`) and no turn.
    await stores.control.query('DELETE FROM member_turns WHERE member_id=$1',[MEMBER_NG_ID]);
    use(memberDirectory({...fixtureMembers(),daily_messages:2}));
    assert.equal((await dispatch(NG1_TG,MEMBER_NG,'Nocheh, one','supergroup')).turn,true);
    assert.equal((await dispatch(MEMBER_NG,MEMBER_NG,'two')).turn,true);
    const count=refusals.length,over=await dispatch(MEMBER_NG,MEMBER_NG,'three');
    assert.deepEqual([over.state,over.error_code,over.turn,refusals.length],['suppressed','member_daily_limit',false,count+1]);
    assert.deepEqual({...refusals.at(-1),event_id:undefined,message_id:undefined},{event_id:undefined,message_id:undefined,chat_id:MEMBER_NG,user_id:MEMBER_NG,
      private:true,once:'daily_limit',reply:memberPrivateDailyLimitReply});
    await stores.control.query(`UPDATE owner_prompts SET texts='{"telegram.member_private_daily_limit":"Enough for today."}'::jsonb WHERE singleton`);
    await dispatch(MEMBER_NG,MEMBER_NG,'four');assert.equal(refusals.at(-1)!.reply,'Enough for today.','the owner\'s own wording');
    await stores.control.query(`UPDATE owner_prompts SET texts='{}'::jsonb WHERE singleton`);
    use(fixtureMemberDirectory());

    // Nothing but reading: a member's private turn posts nothing, starts no job and runs no tool, and nothing is
    // recorded; neither does any turn in a private chat that is not the owner's without a member bound to it.
    const binding=await s.guards.state();
    const turn=(chat:string,extra:Partial<Reader>={}):Reader=>({admin:false,scope:chat,space:chat,turnEvent:mine.id,generation:binding.generation,
      guard_epoch:binding.epoch,revision:binding.epoch,...extra});
    const counts=async()=>Promise.all(['telegram_action_requests','background_jobs','controlled_actions'].map(async table=>
      Number((await stores.control.query(`SELECT count(*) FROM ${table}`)).rows[0].count)));
    const recorded=await counts();
    for(const principal of [turn(MEMBER_NG_CHAT,{member:MEMBER_NG_ID}),turn(MEMBER_NG_CHAT),turn(BOB_CHAT)]) {
      await assert.rejects(s.telegramActions.request(principal,{destination:'current',text:'Post this'}),{status:403,code:'member_private_read_only'});
      await assert.rejects(s.telegramActions.request(principal,{destination:NG1,text:'Post this'}),{status:403,code:'member_private_read_only'});
      await assert.rejects(s.jobs.start(principal,{title:'A job',instruction:'Read it.'}),{status:403,code:'member_private_read_only'});
      await assert.rejects(s.controlledActions.propose(principal,{kind:'browser',arguments:{url:'https://example.com/'}}),{status:403,code:'member_private_read_only'});
      await assert.rejects(s.telegramActions.destinations(principal),{status:403,code:'group_turn_required'});
    }
    assert.deepEqual(await counts(),recorded);

    // A pass for a private chat that is not the owner's is signed only as its own member's, bound to that chat.
    const audience=s.prepared.audience,secret=digest(key),later=Date.now()+60000;
    for(const [why,principal] of [['a stranger\'s chat',{scope:BOB_CHAT,space:BOB_CHAT}],['a member chat without its member',{scope:MEMBER_NG_CHAT,space:MEMBER_NG_CHAT}],
      ['a member claim not bound',{scope:MEMBER_NG_CHAT,space:MEMBER_NG_CHAT,member:MEMBER_NG_ID}],
      ['bound to another chat',{scope:MEMBER_NG_CHAT,space:MEMBER_NG_CHAT,member:MEMBER_NG_ID,memberChat:MEMBER_GP_CHAT,reads:readSet({home:MEMBER_NG_CHAT})}],
      ['a member claim in a group',{scope:NG1,space:NG1,member:MEMBER_NG_ID,memberChat:NG1,reads:readSet({home:NG1})}],
      ['an owner pass in a member chat',{scope:null,space:MEMBER_NG_CHAT}]] as const)
      await assert.rejects(audience.turn(secret,principal as Reader,mine.id,later),{status:409,code:memberChatClosed},why);
    const signed=claimsOf(await audience.turn(secret,{scope:MEMBER_NG_CHAT,space:MEMBER_NG_CHAT,member:MEMBER_NG_ID,memberChat:MEMBER_NG_CHAT,
      reads:readSet({home:MEMBER_NG_CHAT,whole:[NG1]}),lane:'f'.repeat(64)},mine.id,later));
    assert.deepEqual([signed.member,signed.lane],[MEMBER_NG_ID,undefined],'a lane that is not the member\'s own is left out');
    const groupPass=claimsOf(await audience.turn(secret,{scope:GP1,space:GP1,lane:MEMBER_GP_ID},mine.id,later));
    assert.deepEqual([groupPass.lane,groupPass.member],[MEMBER_GP_ID,undefined]);
    const ownerPass=claimsOf(await audience.turn(secret,{scope:null,space:OWNER,lane:MEMBER_GP_ID},mine.id,later));
    assert.equal(ownerPass.lane,undefined,'the owner\'s pass carries no lane');
  }finally{restore();await stores.close();await rm(root,{recursive:true,force:true});}
});

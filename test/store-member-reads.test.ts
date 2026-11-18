import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {installChatsForTest} from '../src/chats.js';
import {installMembersForTest} from '../src/members.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {MEMBER_READ_STALE_DAYS,memberAskReads,memberReads} from '../src/stores/member-reads.js';
import {startMembers,type MemberDirectoryLoader} from '../src/stores/members.js';
import {readSetGroups} from '../src/spaces.js';
import {fixtureServices} from './fixture-brain.js';
import {BOB,BOB_CHAT,GP1,GP2,GP3,GP4,GP_GROUP_IDS,MEMBER_GP,MEMBER_GP_ACCOUNT,MEMBER_GP_CHAT,MEMBER_GP_ID,MEMBER_GP_OFF_CHAT,MEMBER_NG,MEMBER_NG_CHAT,
  MEMBER_NG_ID,MEMBER_NG_OFF_CHAT,NG1,NG2,NG_GROUP_IDS,OWNER,P1,P2,fixtureChats,fixtureDirectory,seedChats,seedGroups,seedMembers} from './fixture-groups.js';

// A member's own private chat with Nocheh (step 4, ADR-0262), in both fixture families: what it reads, resolved in SQL
// from the store as it is now; what each reader may read of it; that it is never learned; and its tasks, read only and
// one project at a time (D14). MEMBER_GP's chat is old-shaped, MEMBER_NG's has a digest id.
const fixture=async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),served=[...GP_GROUP_IDS,...NG_GROUP_IDS];
  await seedChats(stores.control,fixtureChats(served));await seedMembers(stores.control);await seedGroups(stores.control);
  // Telegram confirmed every membership a day ago; the seed writes none of checked_at.
  await stores.control.query("UPDATE chat_memberships SET checked_at=now()-interval '1 day' WHERE checked_at IS NULL");
  return {stores,served};
};
const ago=(db:Pick<pg.Pool,'query'>,chat:string,days:number)=>db.query(`UPDATE chat_memberships SET checked_at=now()-make_interval(days=>$3::int),since=now()-make_interval(days=>$3::int)
  WHERE chat_id=$1 AND account_id=$2`,[chat,MEMBER_GP_ACCOUNT,days]);
const groupsOf=(found:Awaited<ReturnType<typeof memberReads>>)=>found?.groups.map(group=>group.chat)??null;

test('a member chat reads the served groups the member joined and has on, confirmed within 30 days; anything else closes it',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const {stores,served}=await fixture(),db=stores.control,restore=installChatsForTest(fixtureDirectory(served));
  try {
    // MEMBER_GP: GP1 in and on; GP2 left; GP3 switched off; UNSERVED not served; GP4 never seen.
    const gp=await memberReads(db,MEMBER_GP_CHAT,OWNER);
    assert.deepEqual([gp?.member,gp?.chat,groupsOf(gp)],[MEMBER_GP_ID,MEMBER_GP_CHAT,[GP1]]);
    assert.ok(gp!.groups[0]!.checked_at instanceof Date);
    // MEMBER_NG: NG1 on, NG2 with no switch row (no row counts as on).
    const ng=await memberReads(db,MEMBER_NG_CHAT,OWNER);
    assert.deepEqual([ng?.member,ng?.chat,groupsOf(ng)],[MEMBER_NG_ID,MEMBER_NG_CHAT,[NG1,NG2].sort()]);

    // A membership confirmed 29 days ago still counts; 31 days ago it does not; never confirmed it does not.
    await ago(db,GP1,MEMBER_READ_STALE_DAYS-1);assert.deepEqual(groupsOf(await memberReads(db,MEMBER_GP_CHAT,OWNER)),[GP1]);
    await ago(db,GP1,MEMBER_READ_STALE_DAYS+1);assert.deepEqual(groupsOf(await memberReads(db,MEMBER_GP_CHAT,OWNER)),[],'stale: left out, chat still open');
    await db.query('UPDATE chat_memberships SET checked_at=NULL WHERE chat_id=$1 AND account_id=$2',[GP1,MEMBER_GP_ACCOUNT]);
    assert.deepEqual(groupsOf(await memberReads(db,MEMBER_GP_CHAT,OWNER)),[]);
    await ago(db,GP1,1);
    // Switched off in GP1, or GP1 no longer served: left out at the next request.
    await db.query('UPDATE member_chats SET enabled=false WHERE member_id=$1 AND chat_id=$2',[MEMBER_GP_ID,GP1]);
    assert.deepEqual(groupsOf(await memberReads(db,MEMBER_GP_CHAT,OWNER)),[]);
    await db.query('UPDATE member_chats SET enabled=true WHERE member_id=$1 AND chat_id=$2',[MEMBER_GP_ID,GP1]);
    await db.query("UPDATE chats SET state='off' WHERE id=$1",[GP1]);
    assert.deepEqual(groupsOf(await memberReads(db,MEMBER_GP_CHAT,OWNER)),[]);
    await db.query("UPDATE chats SET state='active' WHERE id=$1",[GP1]);
    assert.deepEqual(groupsOf(await memberReads(db,MEMBER_GP_CHAT,OWNER)),[GP1]);

    // Paused, or private chat off: the whole chat closes. Group talk off does not close it.
    for(const [change,closed] of [["state='paused'",true],['private_chat=false',true],['group_talk=false',false]] as const) {
      await db.query(`UPDATE members SET ${change} WHERE id=$1`,[MEMBER_GP_ID]);
      assert.equal(await memberReads(db,MEMBER_GP_CHAT,OWNER)===null,closed,change);
      await db.query("UPDATE members SET state='active',private_chat=true,group_talk=true WHERE id=$1",[MEMBER_GP_ID]);
    }
    // Private chat off from the start, a stranger, the owner's own chat, a group: closed. No owner chat: closed.
    for(const chat of [MEMBER_GP_OFF_CHAT,MEMBER_NG_OFF_CHAT,BOB_CHAT,OWNER,GP1,NG1])assert.equal(await memberReads(db,chat,OWNER),null,chat);
    assert.equal(await memberReads(db,MEMBER_GP_CHAT,null),null);
    // A chat whose account is the owner's chat account is never a member's, even if a member row were linked to it.
    assert.equal(await memberReads(db,MEMBER_GP_CHAT,MEMBER_GP_CHAT),null);

    // The owner's ask about a member reads that member's chat while it runs and is in time; nothing else.
    const ask='a'.repeat(32),event=digest('fixture:ask:1');
    await db.query(`INSERT INTO owner_member_asks(id,owner_event,member_id,question,state,expires_at) VALUES($1,$2,$3,'What did they say?','running',now()+interval '1 hour')`,
      [ask,event,MEMBER_NG_ID]);
    assert.deepEqual(await memberAskReads(db,ask,OWNER),{ask,event,member:MEMBER_NG_ID,chat:MEMBER_NG_CHAT});
    for(const change of ["state='queued'","expires_at=now()-interval '1 minute'"]) {
      await db.query(`UPDATE owner_member_asks SET ${change} WHERE id=$1`,[ask]);
      assert.equal(await memberAskReads(db,ask,OWNER),null,change);
      await db.query("UPDATE owner_member_asks SET state='running',expires_at=now()+interval '1 hour' WHERE id=$1",[ask]);
    }
    await db.query('UPDATE members SET private_chat=false WHERE id=$1',[MEMBER_NG_ID]);
    assert.equal(await memberAskReads(db,ask,OWNER),null,'private chat off: the ask reads nothing');
    await db.query('UPDATE members SET private_chat=true WHERE id=$1',[MEMBER_NG_ID]);
    assert.equal(await memberAskReads(db,'b'.repeat(32),OWNER),null,'an unknown ask');
    await db.query('DELETE FROM owner_member_asks WHERE id=$1',[ask]);
  } finally {restore();await stores.close();}
});

test('a member chat is bound, read, kept from the owner\'s own turns and never learned; its tasks are read only, one project at a time',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const {stores,served}=await fixture(),root=await mkdtemp(join(tmpdir(),'nocheh-member-reads-')),key='member-reads:'+Date.now();
  const policy={enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:served},owner:Reader={admin:true,scope:null};
  const restoreChats=installChatsForTest(fixtureDirectory(served));
  const restoreMembers=installMembersForTest({members:[],accounts:[],chats:[],presence:[],owner_account:null});
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>policy,
    runtime:async operation=>{if(operation==='guard.detect')return {literals:[]};throw Error('runtime_not_expected');},memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  let serial=0,loader:MemberDirectoryLoader|null=null;
  const capture=async(raw:string,from:string,text:string,type:'private'|'supergroup')=>{
    const label=String(++serial),value:Envelope={version:1,key:key+':'+label,origin:'live',kind:'telegram_update',bot_id:key,scope:raw,source_id:label,revision:'1',occurred_at:null,text,
      payload:{message:{message_id:serial,date:1700000000,chat:{id:Number(raw),type,is_forum:false},from:{id:Number(from),first_name:'Mira'},text}}};
    const source=(await s.capture.capture(value)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  const turn=async(source:{id:string},chat:string,claims:Partial<Reader>={}):Promise<Reader>=>{
    const binding=await s.guards.state();
    return {admin:false,scope:chat,space:chat,turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch,...claims};
  };
  try {
    // GP4 joins P2 and MEMBER_GP joined it: their chat reads GP1 (P1) and GP4 (P2).
    await stores.control.query("UPDATE project_assignments SET project_id=$2 WHERE space_id=$1",[GP4,P2]).then(async result=>{
      if(!result.rowCount)await stores.control.query("INSERT INTO project_assignments(space_id,project_id,mode,revision) VALUES($1,$2,'assigned',1)",[GP4,P2]);});
    await stores.control.query(`INSERT INTO chat_memberships(chat_id,account_id,state,source,checked_at) VALUES($1,$2,'in','checked',now()) ON CONFLICT(chat_id,account_id) DO UPDATE SET state='in',checked_at=now()`,
      [GP4,MEMBER_GP_ACCOUNT]);
    loader=await startMembers(stores.control,()=>policy);
    await s.guards.reconcile();await s.guards.setMode('on');
    const binding=await s.guards.state();

    for(const [raw,chat,member,person] of [[MEMBER_GP,MEMBER_GP_CHAT,MEMBER_GP_ID,MEMBER_GP],[MEMBER_NG,MEMBER_NG_CHAT,MEMBER_NG_ID,MEMBER_NG]] as const) {
      const said=await capture(raw,person,'Synthetic private note '+person,'private'),inBob=await capture(BOB,BOB,'Synthetic stranger note','private');
      // Bound: their own chat, as its home, with the groups memberReads gives; anything that does not match is refused.
      const bound=await s.access.bindReads(await turn(said,chat,{member}));
      assert.equal(bound.memberChat,chat);
      assert.deepEqual(readSetGroups(bound.reads!),chat===MEMBER_GP_CHAT?[GP1,GP4].sort():[NG1,NG2].sort());
      for(const [why,claims] of Object.entries({'another member':{member:member===MEMBER_GP_ID?MEMBER_NG_ID:MEMBER_GP_ID},'no turn':{member,turnEvent:undefined},
        'another chat\'s member':{member,scope:BOB_CHAT,space:BOB_CHAT},'the owner\'s chat':{member,scope:OWNER,space:OWNER}}))
        await assert.rejects(s.access.bindReads({...await turn(said,chat),...claims} as Reader),{status:409,code:'member_chat_closed'},why);

      // Who reads what was said there: the member's own bound turn and the owner on the dashboard; never the owner's own
      // turns, a group, another member or a stranger's chat.
      assert.equal(await s.access.canRead(bound,said,binding),true,'their own chat');
      assert.equal(await s.access.canRead(owner,said,binding),true,'the owner on the dashboard');
      assert.equal(await s.access.canRead({admin:false,scope:null,space:OWNER},said,binding),false,'the owner\'s own turn');
      assert.equal(await s.access.canRead({admin:false,scope:GP1,space:GP1},said,binding),false,'a group');
      assert.equal(await s.access.canRead(bound,inBob,binding),false,'a stranger\'s private chat');
      const {memberChat:_,...unbound}=bound;assert.equal(await s.access.canRead(unbound,said,binding),false,'unbound');

      // Never learned, and the owner's yes can't change that.
      assert.equal(await s.access.canLearn(said,binding),false);
      await assert.rejects(s.access.setConsent(owner,said,{enabled:true,expected_revision:0,operation_id:key+':consent:'+person}),{status:409,code:'learning_consent_member_chat'});
      const consent=await s.access.consent(owner,said);assert.deepEqual([consent.effective,consent.consentable],[false,false]);
    }

    // The owner's ask about a member (4b): bound to that member's chat, it reads that chat and the owner's own question
    // that asked it; never another member's chat, a group, or anything else in the owner's chat.
    {
      const question=await capture(OWNER,OWNER,'What did Mira say?','private'),earlier=await capture(OWNER,OWNER,'Synthetic owner note','private');
      const mira=await capture(MEMBER_GP,MEMBER_GP,'Synthetic note from Mira','private'),nils=await capture(MEMBER_NG,MEMBER_NG,'Synthetic note from Nils','private');
      const inGroup=await capture(GP1,MEMBER_GP,'Synthetic group note','supergroup'),ask='9'.repeat(32);
      await stores.control.query(`INSERT INTO owner_member_asks(id,owner_event,member_id,question,state,started_at,expires_at)
        VALUES($1,$2,$3,'What did Mira say?','running',now(),now()+interval '1 hour')`,[ask,question.id,MEMBER_GP_ID]);
      const asked=await s.access.bindReads(await turn(question,OWNER,{memberRead:ask}));
      assert.deepEqual([asked.memberChat,readSetGroups(asked.reads!)],[MEMBER_GP_CHAT,[]]);
      for(const [why,source,allowed] of [['the member\'s chat',mira,true],['the owner\'s question',question,true],['another member\'s chat',nils,false],
        ['a group',inGroup,false],['the owner\'s chat otherwise',earlier,false]] as const)
        assert.equal(await s.access.canRead(asked,source,binding),allowed,why);
      // Only the turn of the message that asked it.
      await assert.rejects(s.access.bindReads(await turn(earlier,OWNER,{memberRead:ask})),{status:409,code:'member_chat_closed'},'another turn');
      await stores.control.query(`UPDATE owner_member_asks SET state='answered',answered_at=now() WHERE id=$1`,[ask]);
      await assert.rejects(s.access.bindReads(await turn(question,OWNER,{memberRead:ask})),{status:409,code:'member_chat_closed'},'an answered ask reads nothing');
    }

    // Tasks (D14): a list in each of P1 and P2, and one in GP2, which MEMBER_GP left.
    const groupTask=async(raw:string,title:string)=>s.tasks.chatCreate(await turn(await capture(raw,OWNER,'Add '+title,'supergroup'),raw),{title});
    const inGp1=await groupTask(GP1,'Book the hall'),inGp4=await groupTask(GP4,'Print the flyers'),inGp2=await groupTask(GP2,'Hire the band');
    const said=await capture(MEMBER_GP,MEMBER_GP,'What is left?','private'),bound=await s.access.bindReads(await turn(said,MEMBER_GP_CHAT,{member:MEMBER_GP_ID}));
    await assert.rejects(s.tasks.chatList(bound),(error:any)=>{
      assert.equal(error.status,400);assert.equal(error.code,'task_project_required');
      assert.deepEqual(error.details.projects,[{id:P1,name:'P1'},{id:P2,name:'P2'}].sort((a,b)=>a.id<b.id?-1:1));return true;});
    assert.deepEqual((await s.tasks.chatList(bound,{scope:P1})).tasks.map((task:any)=>task.id),[inGp1.id],'P1: GP1 only, not GP2 they left');
    assert.deepEqual((await s.tasks.chatList(bound,{scope:P2})).tasks.map((task:any)=>task.id),[inGp4.id]);
    await assert.rejects(s.tasks.chatList(bound,{scope:'personal'}),{status:403,code:'task_scope_denied'});
    assert.equal((await s.tasks.chatGet(bound,inGp1.id)).title,'Book the hall');
    await assert.rejects(s.tasks.chatGet(bound,inGp2.id),{status:404,code:'task_not_found'});
    await assert.rejects(s.tasks.chatCreate(bound,{title:'Hire a band'}),{status:403,code:'task_read_only'});
    await assert.rejects(s.tasks.chatUpdate(bound,inGp1.id,{expected_revision:inGp1.revision,state:'done'}),{status:403,code:'task_read_only'});
    await assert.rejects(s.tasks.chatComment(bound,inGp1.id,{text:'Booked'}),{status:403,code:'task_read_only'});
    // An unbound member turn can't even read its own source: refused before any view.
    await assert.rejects(s.tasks.chatList(await turn(said,MEMBER_GP_CHAT,{member:MEMBER_GP_ID})),{status:403,code:'turn_source_denied'});
    void GP3;
  } finally {loader?.stop();restoreMembers();restoreChats();await stores.close();await rm(root,{recursive:true,force:true});}
});

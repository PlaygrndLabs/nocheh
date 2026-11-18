import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readOnlyReader,conversationScope,type AssistantPolicy} from '../src/assistant-policy.js';
import {installChatsForTest,servedChats} from '../src/chats.js';
import {installMembersForTest,memberDirectory} from '../src/members.js';
import {memberPrivate,readSet} from '../src/spaces.js';
import {MEMBER_READ_STALE_DAYS,MEMBER_RECHECK_HOURS,MEMBER_RECHECK_LIMIT,memberRechecks,memberStatus} from '../src/stores/member-reads.js';
import {readsWithin} from '../src/stores/telegram-turn.js';
import {BOB,BOB_CHAT,GP1,GP1_TOPIC,GP2,GP_GROUP_IDS,MEMBER_GP,MEMBER_GP_CHAT,MEMBER_GP_ID,MEMBER_GP_OFF,MEMBER_GP_OFF_CHAT,MEMBER_NG,MEMBER_NG_CHAT,
  MEMBER_NG_ID,MEMBER_NG_OFF,MEMBER_NG_OFF_CHAT,NG1,NG1_TG,NG2,NG_GROUP_IDS,OWNER,fixtureDirectory,fixtureMemberDirectory,fixtureMembers} from './fixture-groups.js';

// Step 4 (ADR-0262): who is admitted to talk to Nocheh in their own private chat, what a member's turn may not do, and
// how its groups are asked again. Both fixture families: MEMBER_GP's chat keeps its old-shaped id, MEMBER_NG's is a digest.
const served=[...GP_GROUP_IDS,...NG_GROUP_IDS];
installChatsForTest(fixtureDirectory(served));
const policy:AssistantPolicy={enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:served,topic_memory:'group'};
/** A private message from `user` in the private chat whose Telegram id is `chat`. */
const dm=(chat:string,user:string,extra:Record<string,unknown>={})=>({update_id:1,message:{message_id:7,date:1700000000,chat:{id:Number(chat),type:'private'},
  from:{id:Number(user),is_bot:false,first_name:'Someone'},text:'hello',...extra}});

test('a member is admitted in their own private chat while active with private chat on, whatever their group talk; nobody else is',()=>{
  const restore=installMembersForTest(fixtureMemberDirectory());
  try {
    assert.deepEqual(conversationScope(policy,dm(MEMBER_GP,MEMBER_GP),MEMBER_GP),{owner:false,chat_id:MEMBER_GP_CHAT,user_id:MEMBER_GP,member:MEMBER_GP_ID});
    assert.deepEqual(conversationScope(policy,dm(MEMBER_NG,MEMBER_NG),MEMBER_NG),{owner:false,chat_id:MEMBER_NG_CHAT,user_id:MEMBER_NG,member:MEMBER_NG_ID});
    assert.equal(memberPrivate(MEMBER_GP_CHAT),true);assert.equal(memberPrivate(MEMBER_NG_CHAT),true);
    // Private chat off, a stranger, and someone else's chat: the fixed reply's path (null).
    for(const [why,chat,user] of [['private chat off (old-shaped)',MEMBER_GP_OFF,MEMBER_GP_OFF],['private chat off (digest)',MEMBER_NG_OFF,MEMBER_NG_OFF],
      ['a stranger',BOB,BOB],['a member writing as someone else\'s chat',MEMBER_GP,MEMBER_NG],['a chat with no row','9876','9876']] as const)
      assert.equal(conversationScope(policy,dm(chat,user),chat),null,why);
    assert.equal(memberPrivate(MEMBER_GP_OFF_CHAT),false);assert.equal(memberPrivate(MEMBER_NG_OFF_CHAT),false);assert.equal(memberPrivate(BOB_CHAT),false);
    // A bot, edits and a chat that is not where the update says it is are never admitted.
    assert.equal(conversationScope(policy,{update_id:1,message:{...dm(MEMBER_GP,MEMBER_GP).message,from:{id:Number(MEMBER_GP),is_bot:true}}},MEMBER_GP),null);
    assert.equal(conversationScope(policy,{update_id:1,edited_message:dm(MEMBER_GP,MEMBER_GP).message},MEMBER_GP),null);
    assert.throws(()=>conversationScope(policy,dm(MEMBER_GP,MEMBER_GP),MEMBER_NG),{code:'source_scope_mismatch'});
    // The owner's own chat stays the owner's, and the owner is never a member.
    assert.equal(conversationScope(policy,dm(OWNER,OWNER),OWNER)?.owner,true);
    assert.equal(conversationScope(policy,dm(OWNER,OWNER),OWNER)?.member,undefined);
    // Nocheh off answers nobody.
    assert.equal(conversationScope({...policy,enabled:false},dm(MEMBER_GP,MEMBER_GP),MEMBER_GP),null);
  }finally{restore();}
  for(const [why,changes] of [['paused',{state:'paused' as const}],['private chat off',{private_chat:false}]] as const) {
    const off=installMembersForTest(fixtureMemberDirectory({[MEMBER_GP_ID]:changes}));
    try{assert.equal(conversationScope(policy,dm(MEMBER_GP,MEMBER_GP),MEMBER_GP),null,why);}finally{off();}
  }
  // Removed: no members row any more.
  const fixture=fixtureMembers();
  const removed=installMembersForTest(memberDirectory({...fixture,members:fixture.members.filter(row=>row.id!==MEMBER_NG_ID),
    accounts:fixture.accounts.filter(row=>row.member_id!==MEMBER_NG_ID),chats:fixture.chats.filter(row=>row.member_id!==MEMBER_NG_ID)}));
  try{assert.equal(conversationScope(policy,dm(MEMBER_NG,MEMBER_NG),MEMBER_NG),null,'removed');}finally{removed();}
  // Group talk off and every group switched off still leave the private chat open (design: group talk does not count).
  const quiet=installMembersForTest(memberDirectory({...fixtureMembers({[MEMBER_NG_ID]:{group_talk:false}}),
    chats:[{member_id:MEMBER_NG_ID,chat_id:NG1,enabled:false},{member_id:MEMBER_NG_ID,chat_id:NG2,enabled:false}]}));
  try {
    assert.equal(conversationScope(policy,dm(MEMBER_NG,MEMBER_NG),MEMBER_NG)?.member,MEMBER_NG_ID);
    assert.equal(conversationScope(policy,{update_id:1,message:{message_id:8,chat:{id:Number(NG1_TG),type:'supergroup'},from:{id:Number(MEMBER_NG),is_bot:false},text:'hi'}},NG1_TG),
      null,'but not in their groups');
  }finally{quiet();}
});

test('a bound reader, and any turn in a private chat that is not the owner\'s, may only read: one code each, every other reader none',()=>{
  assert.equal(readOnlyReader({scope:OWNER,space:OWNER,answer:'a'.repeat(32)}),'private_answer_read_only');
  assert.equal(readOnlyReader({scope:MEMBER_GP_CHAT,space:MEMBER_GP_CHAT,member:MEMBER_GP_ID}),'member_private_read_only');
  assert.equal(readOnlyReader({scope:OWNER,space:OWNER,memberRead:'c'.repeat(32)}),'member_private_read_only');
  // Fail closed: a member's or a stranger's chat without a member bound to it.
  for(const chat of [MEMBER_NG_CHAT,MEMBER_GP_OFF_CHAT,BOB_CHAT])assert.equal(readOnlyReader({scope:chat,space:chat}),'member_private_read_only',chat);
  for(const [why,principal] of [['the owner',{scope:null,space:OWNER}],['a group',{scope:GP1,space:GP1}],['a topic',{scope:GP1,space:GP1_TOPIC}],
    ['a digest group',{scope:NG1,space:NG1}]] as const)assert.equal(readOnlyReader(principal),null,why);
});

test('the served list marks each open member private chat, never as served, and only when the member directory is asked',()=>{
  const restore=installMembersForTest(fixtureMemberDirectory());
  try {
    const directory=fixtureDirectory(served),owner={app:'telegram' as const,external:OWNER};
    const marked=(list:ReturnType<typeof servedChats>)=>list.chats.filter(chat=>chat.member_private).map(chat=>chat.id).sort();
    const list=servedChats(directory,owner,id=>memberPrivate(id,directory));
    assert.deepEqual(marked(list),[MEMBER_GP_CHAT,MEMBER_NG_CHAT].sort());
    for(const chat of list.chats.filter(item=>item.member_private))assert.deepEqual([chat.kind,chat.state],['private','off']);
    assert.ok(!list.chats.some(chat=>[BOB_CHAT,MEMBER_GP_OFF_CHAT,MEMBER_NG_OFF_CHAT].includes(chat.id)),'strangers and private-off members are not listed');
    assert.deepEqual(marked(servedChats(directory,owner)),[],'without the member directory no chat is marked');
    assert.equal(servedChats(directory,owner).chats.length,list.chats.length-2);
    const off=installMembersForTest(fixtureMemberDirectory({[MEMBER_GP_ID]:{private_chat:false},[MEMBER_NG_ID]:{state:'paused'}}));
    try{assert.deepEqual(marked(servedChats(directory,owner,id=>memberPrivate(id,directory))),[]);}finally{off();}
  }finally{restore();}
});

test('before a private turn the oldest groups past six hours are asked again, at most ten, and the rest are left out',()=>{
  const now=Date.UTC(2026,0,10),hours=(n:number)=>new Date(now-n*3600000);
  const groups=Array.from({length:14},(_,n)=>({chat:'g'+String(n).padStart(2,'0'),checked_at:hours(n<2?1:MEMBER_RECHECK_HOURS+n)}));
  const {ask,past}=memberRechecks({groups},now);
  assert.equal(ask.length,MEMBER_RECHECK_LIMIT);
  assert.deepEqual(ask,['g13','g12','g11','g10','g09','g08','g07','g06','g05','g04'],'oldest first');
  assert.deepEqual(past,['g03','g02']);
  assert.deepEqual(memberRechecks({groups:groups.slice(0,2)},now),{ask:[],past:[]},'groups confirmed within six hours are not asked');
  // Stale groups (past 30 days, or never confirmed as the epoch) are asked too, oldest first, under the same cap; they are
  // not read, so never left out.
  const stale=[{chat:'s1',checked_at:hours(24*31)},{chat:'s0',checked_at:new Date(0)}];
  assert.deepEqual(memberRechecks({groups:groups.slice(0,2),stale},now),{ask:['s0','s1'],past:[]});
  assert.deepEqual(memberRechecks({groups,stale},now).ask.slice(0,3),['s0','s1','g13']);
  assert.deepEqual(memberRechecks({groups,stale},now).past,['g05','g04','g03','g02']);
  // Groups asked lately without an answer move behind the rest, so the ones past the cap get their turn.
  const failing=new Set(['g13','g12','g11','g10','g09','g08','g07','g06','g05','g04']);
  assert.deepEqual(memberRechecks({groups},now,chat=>failing.has(chat)?now-60000:undefined),
    {ask:['g03','g02','g13','g12','g11','g10','g09','g08','g07','g06'],past:['g05','g04']});
  assert.equal(MEMBER_READ_STALE_DAYS,30);
  // Telegram's answer as the bot gives it; anything else changes nothing.
  assert.equal(memberStatus({state:'done',status:'in'}),'in');assert.equal(memberStatus({state:'done',status:'left'}),'left');
  assert.equal(memberStatus({status:'left'}),'left');
  for(const answer of [{state:'not_started',status:'left'},{state:'done',status:'kicked'},{state:'done'},null,'left',[]])assert.equal(memberStatus(answer),null,JSON.stringify(answer));
});

test('a member turn still holds when it may read more than it was given, never when it may read less',()=>{
  const given=readSet({home:MEMBER_GP_CHAT,whole:[GP1]}),more=readSet({home:MEMBER_GP_CHAT,whole:[GP1,GP2]});
  assert.equal(readsWithin(given,more),true);assert.equal(readsWithin(given,given),true);
  assert.equal(readsWithin(more,given),false,'a group left since');
  assert.equal(readsWithin(given,readSet({home:MEMBER_NG_CHAT,whole:[GP1]})),false,'another chat');
  assert.equal(readsWithin(readSet({home:MEMBER_GP_CHAT,exact:[GP1_TOPIC]}),given),true,'a topic of a group it reads whole');
});

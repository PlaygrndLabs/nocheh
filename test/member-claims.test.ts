import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import {boundReader,boundReaderReadOnly,memberClaimId,memberReadId,reader,turnToken,type Reader} from '../src/access.js';
import {installChatsForTest} from '../src/chats.js';
import {installMembersForTest,memberDirectory} from '../src/members.js';
import {memberChangeRequest} from '../src/stores/member-api.js';
import {memberChatClosed,memberReads} from '../src/stores/member-reads.js';
import {memberPrivateTextKeys} from '../src/member-wire.js';
import {memberPrivateDailyLimitReply,membersLocalLaws,notAllowedPrivateReply,promptKeys,promptPlaceholders,promptProblem} from '../src/prompts.js';
import {modelSourceWords} from '../src/source-labels.js';
import {servicesFile} from './services-file.js';
import {inReadSet,memberPrivate,otherPrivate,readSet,readSetIds,readSetParam,servedGroup} from '../src/spaces.js';
import {BOB_ACCOUNT,BOB_CHAT,GP1,GP1_TOPIC,GP4,GP_GROUP_IDS,MEMBER_GP_ACCOUNT,MEMBER_GP_CHAT,MEMBER_GP_ID,MEMBER_GP_OFF_ACCOUNT,MEMBER_GP_OFF_CHAT,
  MEMBER_GP_OFF_ID,MEMBER_NG_ACCOUNT,MEMBER_NG_CHAT,MEMBER_NG_ID,MEMBER_NG_OFF_CHAT,MEMBER_NG_OFF_ID,NG1,NG1_TOPIC,NG2,NG_GROUP_IDS,OWNER,OWNER_ACCOUNT,
  UNSERVED,fixtureChats,fixtureDirectory,fixtureMemberDirectory} from './fixture-groups.js';

// Step 4 (member private chat) and 4b (the owner asks about a member): the member, lane and member_read claims, the
// server-only memberChat, and the helpers that tell a member's private chat apart. Both fixture families.
const served=[...GP_GROUP_IDS,...NG_GROUP_IDS];
installChatsForTest(fixtureDirectory(served));

const secret='synthetic-service-token-only-for-tests',event='e'.repeat(64),later=()=>Date.now()+60000;
const member='d'.repeat(64),ask='c'.repeat(32),answer='a'.repeat(32);
const request=(token:string)=>({headers:{authorization:'Bearer '+token}}) as unknown as IncomingMessage;
const signed=(prefix:'turn'|'scope',claims:Record<string,unknown>)=>{
  const body=Buffer.from(JSON.stringify({expires:later(),audience:prefix==='turn'?'nocheh-assistant':'nocheh-archive',...claims})).toString('base64url');
  return `${prefix}.${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
};
const refused=(token:string,why:string)=>assert.throws(()=>reader(request(token),secret),{code:'invalid_scope_token'},why);
/** A turn pass whose scope and space are `chat`. */
const at=(chat:string|null,claims:Record<string,unknown>)=>signed('turn',{scope:chat,event_id:event,space:chat??OWNER,revision:1,...claims});

test('a member claim is read only from a turn pass for a private chat that is not the owner\'s, in both families',()=>{
  for(const chat of [MEMBER_GP_CHAT,MEMBER_NG_CHAT,MEMBER_GP_OFF_CHAT,MEMBER_NG_OFF_CHAT,BOB_CHAT]) {
    const parsed=reader(request(turnToken(secret,chat,later(),event,{space:chat,revision:1,guard_epoch:1,member})),secret);
    assert.deepEqual(parsed,{scope:chat,admin:false,turnEvent:event,space:chat,revision:1,guard_epoch:1,brain:'hermes',member},chat);
    assert.equal(boundReader(parsed),'member');
  }
  for(const value of ['D'.repeat(64),'d'.repeat(63),'d'.repeat(65),'d'.repeat(32),'g'.repeat(64),'',64,null])
    refused(at(MEMBER_GP_CHAT,{member:value}),String(value));
  // Never the owner's chat, an owner pass, a group or a topic, a pass without its space, an unknown chat or a scope pass.
  for(const [why,claims] of Object.entries({
    'the owner\'s chat':{scope:OWNER,space:OWNER,revision:1},'an owner pass':{scope:null,space:OWNER,revision:1},
    'a group pass':{scope:GP1,space:GP1,revision:1},'a topic pass':{scope:GP1,space:GP1_TOPIC,revision:1},
    'a digest group pass':{scope:NG1,space:NG1,revision:1},'a digest topic pass':{scope:NG1,space:NG1_TOPIC,revision:1},
    'a pass without a space':{scope:MEMBER_GP_CHAT},'another chat as its space':{scope:MEMBER_GP_CHAT,space:MEMBER_NG_CHAT,revision:1},
    'a chat with no row':{scope:'9999',space:'9999',revision:1},'a desktop import':{scope:'desktop:personal_chat:9',space:'desktop:personal_chat:9',revision:1},
  }))refused(signed('turn',{event_id:event,member,...claims}),why);
  refused(signed('scope',{scope:MEMBER_GP_CHAT,member}),'a scope pass');
});

test('a lane is checked for shape and dropped: it never reaches the reader and grants nothing',()=>{
  // A member's group pass and private pass may carry their lane; the reader is the same as without it.
  const group=reader(request(turnToken(secret,GP1,later(),event,{space:GP1,revision:1,lane:member})),secret);
  assert.deepEqual(group,reader(request(turnToken(secret,GP1,later(),event,{space:GP1,revision:1})),secret));
  assert.equal('lane' in group,false);assert.equal(boundReader(group),null);
  const own=reader(request(turnToken(secret,MEMBER_NG_CHAT,later(),event,{space:MEMBER_NG_CHAT,revision:1,member,lane:member})),secret);
  assert.equal('lane' in own,false);assert.equal(own.member,member);
  // A group pass with a lane reads only its group: a lane naming a member never makes it a member pass.
  assert.equal(group.scope,GP1);assert.equal(group.member,undefined);
  for(const value of ['D'.repeat(64),'d'.repeat(63),'',1,{}])refused(at(GP1,{lane:value}),String(value));
  refused(signed('scope',{scope:GP1,lane:member}),'a scope pass carries no lane');
  // A group pass naming a member is refused, lane or not.
  refused(at(GP1,{member,lane:member}),'member in a group');
});

test('a member_read claim is read only from a turn pass for the owner\'s private chat, as an answer is',()=>{
  const parsed=reader(request(turnToken(secret,OWNER,later(),event,{space:OWNER,revision:1,memberRead:ask})),secret);
  assert.deepEqual(parsed,{scope:OWNER,admin:false,turnEvent:event,space:OWNER,revision:1,brain:'hermes',memberRead:ask});
  assert.equal(boundReader(parsed),'memberRead');
  assert.ok(memberReadId.test(ask));assert.ok(memberClaimId.test(member));
  for(const value of ['C'.repeat(32),'c'.repeat(31),'c'.repeat(64),'',32])refused(at(OWNER,{member_read:value}),String(value));
  for(const [why,claims] of Object.entries({
    'an owner pass':{scope:null,space:OWNER,revision:1},'a member\'s chat':{scope:MEMBER_GP_CHAT,space:MEMBER_GP_CHAT,revision:1},
    'a stranger\'s chat':{scope:BOB_CHAT,space:BOB_CHAT,revision:1},'a group pass':{scope:GP1,space:GP1,revision:1},
    'a topic of the owner\'s chat':{scope:OWNER,space:OWNER+'/topic/5',revision:1},'a pass without a space':{scope:OWNER},
  }))refused(signed('turn',{event_id:event,member_read:ask,...claims}),why);
  refused(signed('scope',{scope:OWNER,member_read:ask}),'a scope pass');
  // A pass is at most one bound reader.
  refused(at(OWNER,{member_read:ask,answer}),'an answer and an ask');
  refused(at(MEMBER_GP_CHAT,{member,member_read:ask}),'a member and an ask');
});

test('memberChat and reads never come from a pass, under any spelling',()=>{
  for(const [chat,claims] of [[MEMBER_GP_CHAT,{member}],[OWNER,{member_read:ask}],[OWNER,{answer}],[GP1,{}]] as const)
    for(const extra of [{member_chat:MEMBER_GP_CHAT},{memberChat:MEMBER_GP_CHAT},{reads:{home:GP1,exact:[],whole:[GP1],project:null}},{memberRead:ask},{member_chat:null}])
      refused(at(chat,{...claims,...extra}),chat+' '+Object.keys(extra)[0]);
  // The Reader field is the server's alone: a parsed reader never has one.
  const parsed=reader(request(turnToken(secret,MEMBER_GP_CHAT,later(),event,{space:MEMBER_GP_CHAT,revision:1,member})),secret);
  assert.equal('memberChat' in parsed,false);
});

test('boundReader names the one bound reader a reader is, and passes without one read as before',()=>{
  assert.equal(boundReader({}),null);
  assert.deepEqual(boundReaderReadOnly,{answer:'private_answer_read_only',member:'member_private_read_only',memberRead:'member_private_read_only'});
  assert.equal(boundReader({admin:true,scope:null} as Reader),null);
  assert.equal(boundReader({answer}),'answer');assert.equal(boundReader({member}),'member');assert.equal(boundReader({memberRead:ask}),'memberRead');
  // A hand-built reader with more than one claim is still bound (never null).
  assert.notEqual(boundReader({member,memberRead:ask}),null);
  for(const chat of [null,GP1,GP1_TOPIC,NG1,MEMBER_GP_CHAT])
    assert.equal(boundReader(reader(request(turnToken(secret,chat,later(),event,chat===null?undefined:{space:chat,revision:1})),secret)),null,String(chat));
});

test('otherPrivate is every private chat but the owner\'s, and memberPrivate only a member\'s own chat with private chat on',()=>{
  const restore=installMembersForTest(fixtureMemberDirectory());
  try {
    for(const chat of [MEMBER_GP_CHAT,MEMBER_NG_CHAT,MEMBER_GP_OFF_CHAT,MEMBER_NG_OFF_CHAT,BOB_CHAT])assert.equal(otherPrivate(chat),true,chat);
    for(const chat of [OWNER,GP1,GP1_TOPIC,GP4,UNSERVED,NG1,NG1_TOPIC,NG2,'9999','desktop:personal_chat:9',null,undefined,''])
      assert.equal(otherPrivate(chat),false,String(chat));
    // A member's private chat is never served: it stays out of every group helper.
    for(const chat of [MEMBER_GP_CHAT,MEMBER_NG_CHAT])assert.equal(servedGroup(chat),false);
    assert.deepEqual([MEMBER_GP_CHAT,MEMBER_NG_CHAT].map(chat=>memberPrivate(chat)),[true,true]);
    for(const chat of [MEMBER_GP_OFF_CHAT,MEMBER_NG_OFF_CHAT,BOB_CHAT,OWNER,GP1,NG1,'9999',null])assert.equal(memberPrivate(chat),false,String(chat));
    // Paused, private chat switched off, removed (no member), or a directory that holds no member: closed.
    assert.equal(memberPrivate(MEMBER_GP_CHAT,undefined,fixtureMemberDirectory({[MEMBER_GP_ID]:{state:'paused'}})),false);
    assert.equal(memberPrivate(MEMBER_NG_CHAT,undefined,fixtureMemberDirectory({[MEMBER_NG_ID]:{private_chat:false}})),false);
    assert.equal(memberPrivate(MEMBER_GP_OFF_CHAT,undefined,fixtureMemberDirectory({[MEMBER_GP_OFF_ID]:{private_chat:true}})),true);
    // Group talk off does not stop private chat.
    assert.equal(memberPrivate(MEMBER_GP_CHAT,undefined,fixtureMemberDirectory({[MEMBER_GP_ID]:{group_talk:false}})),true);
  } finally{restore();}
  assert.equal(memberPrivate(MEMBER_GP_CHAT),false,'the process\'s default directory holds no member');
});

test('privateTalks is a member\'s own switch: active and private chat on, never the owner, independent of group talk',()=>{
  const directory=fixtureMemberDirectory();
  assert.deepEqual([MEMBER_GP_ACCOUNT,MEMBER_NG_ACCOUNT,MEMBER_GP_OFF_ACCOUNT,OWNER_ACCOUNT,BOB_ACCOUNT,'',null,undefined].map(account=>directory.privateTalks(account)),
    [true,true,false,false,false,false,false,false]);
  assert.deepEqual(directory.all().map(item=>[item.id,item.privateChat]),
    [[MEMBER_GP_ID,true],[MEMBER_NG_ID,true],[MEMBER_GP_OFF_ID,false],[MEMBER_NG_OFF_ID,false]].sort((a,b)=>a[0]!<b[0]!?-1:1));
  assert.equal(fixtureMemberDirectory({[MEMBER_GP_ID]:{state:'paused'}}).privateTalks(MEMBER_GP_ACCOUNT),false);
  assert.equal(fixtureMemberDirectory({[MEMBER_GP_ID]:{group_talk:false}}).privateTalks(MEMBER_GP_ACCOUNT),true);
  assert.equal(fixtureMemberDirectory({[MEMBER_NG_ID]:{private_chat:false}}).privateTalks(MEMBER_NG_ACCOUNT),false);
  // The private-off members reach no group, so the person destinations stay the members who reach one.
  assert.deepEqual([...directory.accounts(fixtureDirectory(served)).keys()].sort(),[MEMBER_GP_ACCOUNT,MEMBER_NG_ACCOUNT].sort());
  // A row without the switch, or with a value that is not true or false, is no directory.
  const rows=fixtureMemberDirectory().all();assert.equal(rows.length,4);
  assert.throws(()=>memberDirectory({members:[{id:MEMBER_GP_ID,state:'active',group_talk:true,group_jobs:true,group_post_other:true,group_tools:true,tasks:'write'} as never],
    accounts:[],chats:[],presence:[],owner_account:OWNER_ACCOUNT}),/invalid_member_directory:member_row/);
});

test('a read set still drops every private chat: the owner\'s, members\' own, strangers\' and unknown ones',()=>{
  const privates=[OWNER,MEMBER_GP_CHAT,MEMBER_NG_CHAT,MEMBER_GP_OFF_CHAT,MEMBER_NG_OFF_CHAT,BOB_CHAT,'9999'];
  const set=readSet({home:MEMBER_GP_CHAT,exact:[...privates,GP1_TOPIC],whole:[...privates,NG1]});
  assert.deepEqual(set,{home:MEMBER_GP_CHAT,exact:[GP1_TOPIC],whole:[NG1],project:null},'only groups and their topics stay');
  for(const chat of privates)assert.equal(inReadSet(set,chat),false,chat);
  // Even a set built by hand, skipping readSet, never reads one, nor does its SQL parameter name one.
  const hand={home:MEMBER_GP_CHAT,exact:privates,whole:privates,project:null};
  for(const chat of privates)assert.equal(inReadSet(hand,chat),false,chat);
  assert.deepEqual(readSetIds(hand),[]);assert.deepEqual(readSetParam(hand),[]);
  for(const chat of privates)assert.ok(!readSetParam(set).some(entry=>entry.endsWith(':'+chat)),chat);
  // The chat fixtures hold each member's private chat, off as every private chat but the owner's is.
  const rows=fixtureChats(served).chats.filter(row=>[MEMBER_GP_CHAT,MEMBER_NG_CHAT,MEMBER_GP_OFF_CHAT,MEMBER_NG_OFF_CHAT].includes(row.id));
  assert.deepEqual(rows.map(row=>[row.kind,row.state]),Array(4).fill(['private','off']));
});

test('step 4\'s texts are editable keys with defaults, and the members\' private chat switch is a member change',()=>{
  assert.deepEqual(memberPrivateTextKeys,{reply:'reply.member',privateDailyLimit:'telegram.member_private_daily_limit',
    notAllowedPrivate:'telegram.not_allowed_private',localLaws:'members.local_laws'});
  for(const key of Object.values(memberPrivateTextKeys)){assert.ok((promptKeys as readonly string[]).includes(key),key);assert.equal(promptPlaceholders[key as never],undefined,key);}
  assert.match(notAllowedPrivateReply,/its owner and the people they add/);
  assert.match(memberPrivateDailyLimitReply,/limit/);assert.match(membersLocalLaws,/local laws/);
  assert.doesNotMatch(membersLocalLaws+memberPrivateDailyLimitReply+notAllowedPrivateReply,/\bteam\b/i,'owner-facing words say member');
  for(const text of [memberPrivateDailyLimitReply,membersLocalLaws,notAllowedPrivateReply])assert.equal(promptProblem('members.local_laws',text),null);
  // reply.member is a reply rule, so its default is the brain's, as every reply.* text is.
  const hermes=readFileSync(servicesFile('services/hermes/prompts.py'),'utf8'),rules=hermes.match(/'reply\.member': \(([\s\S]*?)\),\n/)?.[1]??'';
  assert.match(rules,/the owner can read it/,'the truthful rule');
  assert.doesNotMatch(rules,/memory_recall|knowledge|owner_read/,'no notes tool and no owner tools in a member\'s chat');
  assert.equal(modelSourceWords.places.member,'“{name}”\'s private chat');
  // The switch on the Members page.
  assert.deepEqual(memberChangeRequest({operation_id:'op',changes:{private_chat:false}}),{operation_id:'op',changes:{private_chat:false}});
  for(const value of ['off',null,0])assert.throws(()=>memberChangeRequest({operation_id:'op',changes:{private_chat:value}}),{code:'invalid_member_request'},String(value));
});

test('a chat that is not a private chat of someone other than the owner is closed before any query, and a member chat the database does not open is closed',async()=>{
  const none={query:async()=>{throw Error('no query for a chat that cannot be a member chat');}} as never;
  for(const chat of [OWNER,GP1,GP1_TOPIC,NG1,'9876'])assert.equal(await memberReads(none,chat),null,chat);
  const asked:string[]=[],empty={query:async(_sql:string,params:unknown[])=>{asked.push(String(params[0]));return {rows:[]};}} as never;
  for(const chat of [MEMBER_GP_CHAT,MEMBER_NG_CHAT,BOB_CHAT])assert.equal(await memberReads(empty,chat),null,chat);
  assert.deepEqual(asked,[MEMBER_GP_CHAT,MEMBER_NG_CHAT,BOB_CHAT]);
  assert.equal(memberChatClosed,'member_chat_closed');
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canonical,digest} from '../src/archive.js';
import {accountIdFor,installChatsForTest} from '../src/chats.js';
import {freshMembers,installMembers,installMembersForTest,memberDirectory,memberIdFor,members,setMemberLoader,type MemberSnapshot} from '../src/members.js';
import {groupToolsTextLabels,memberChangedReason,memberTextKeys} from '../src/member-wire.js';
import {memberAddRequest,memberChangeRequest,memberRemoveRequest,memberSettingsRequest} from '../src/stores/member-api.js';
import {isProxyAccount} from '../src/chats-telegram-updates.js';
import {BOB_ACCOUNT,BOB_CHAT,GP1,GP1_TOPIC,GP2,GP3,GP4,GP_GROUP_IDS,MEMBER_GP,MEMBER_GP_ACCOUNT,MEMBER_GP_ID,MEMBER_NG_ACCOUNT,MEMBER_NG_ID,NG1,NG1_TOPIC,NG2,
  NG_GROUP_IDS,OWNER_ACCOUNT,UNSERVED,fixtureDirectory,fixtureMemberDirectory,fixtureMembers} from './fixture-groups.js';

const served=fixtureDirectory([...GP_GROUP_IDS,...NG_GROUP_IDS]);
const permissions=['jobs','post','tools'] as const;
/** Every question the directory answers for one account and chat, in one line. */
const answers=(directory:ReturnType<typeof memberDirectory>,account:string,chat:string)=>({talks:directory.talks(account,chat,served),
  may:permissions.filter(permission=>directory.may(account,chat,permission,served)),reaches:directory.reaches(account,chat,null,served)});

test('a member id is digest(canonical([member, account])) of its first account',()=>{
  assert.equal(memberIdFor(MEMBER_GP_ACCOUNT),digest(canonical(['member',MEMBER_GP_ACCOUNT])));
  assert.notEqual(memberIdFor(MEMBER_GP_ACCOUNT),memberIdFor(MEMBER_NG_ACCOUNT));
  for(const bad of [MEMBER_GP,'A'.repeat(64),'',MEMBER_GP_ACCOUNT+'0'])assert.throws(()=>memberIdFor(bad),{code:'invalid_account_reference'},bad);
});

test('the owner is admitted in every served group and is never a member, even when the owner\'s account is linked to one',()=>{
  const linked=fixtureMembers({[MEMBER_GP_ID]:{state:'paused',group_talk:false}});
  const directory=memberDirectory({...linked,accounts:[...linked.accounts,{account_id:OWNER_ACCOUNT,member_id:MEMBER_GP_ID}]});
  for(const chat of [GP1,GP1_TOPIC,GP2,GP3,GP4,NG1,NG1_TOPIC,NG2])
    assert.deepEqual(answers(directory,OWNER_ACCOUNT,chat),{talks:true,may:[...permissions],reaches:true},chat);
  for(const chat of [UNSERVED,BOB_CHAT,'-1001000000077',''])assert.deepEqual(answers(directory,OWNER_ACCOUNT,chat),{talks:false,may:[],reaches:false},chat);
  assert.equal(directory.memberOf(OWNER_ACCOUNT),null,'the owner\'s account is no member\'s');
  assert.deepEqual(directory.get(MEMBER_GP_ID)?.accounts,[MEMBER_GP_ACCOUNT],'and is left out of the member\'s accounts');
  assert.equal(directory.tasks(OWNER_ACCOUNT),'write');
  assert.ok(!directory.accounts(served).has(OWNER_ACCOUNT),'nor is the owner a person destination');
  assert.equal(directory.ownerAccount,OWNER_ACCOUNT);
});

test('a member talks in served groups whose switch is on or that have no row; a topic follows its group',()=>{
  const directory=fixtureMemberDirectory();
  assert.deepEqual(answers(directory,MEMBER_GP_ACCOUNT,GP1),{talks:true,may:[...permissions],reaches:true});
  assert.deepEqual(answers(directory,MEMBER_GP_ACCOUNT,GP1_TOPIC),{talks:true,may:[...permissions],reaches:true},'a topic is its group');
  assert.deepEqual(answers(directory,MEMBER_GP_ACCOUNT,GP2),{talks:true,may:[...permissions],reaches:false},'Telegram says they left: talk, but no reach');
  assert.deepEqual(answers(directory,MEMBER_GP_ACCOUNT,GP3),{talks:false,may:[],reaches:false},'switched off, though Telegram says in');
  assert.deepEqual(answers(directory,MEMBER_GP_ACCOUNT,GP4),{talks:true,may:[...permissions],reaches:false},'no row counts as on; no Telegram row, no reach');
  assert.deepEqual(answers(directory,MEMBER_GP_ACCOUNT,UNSERVED),{talks:false,may:[],reaches:false},'a group Nocheh does not serve');
  for(const chat of [BOB_CHAT,'-1001000000077','',GP1+'x'])assert.deepEqual(answers(directory,MEMBER_GP_ACCOUNT,chat),{talks:false,may:[],reaches:false},chat);
  assert.deepEqual(answers(directory,MEMBER_NG_ACCOUNT,NG1_TOPIC),{talks:true,may:[...permissions],reaches:true});
  assert.deepEqual(answers(directory,MEMBER_NG_ACCOUNT,NG2),{talks:true,may:[...permissions],reaches:true},'New here: Telegram says in, no row');
  assert.deepEqual(answers(directory,MEMBER_NG_ACCOUNT,GP1),{talks:true,may:[...permissions],reaches:false},
    'no row there either: talk follows a live message, which proves presence; nothing else reaches it');
  // Talk never reads Telegram's rows; reach always does.
  const noRows=memberDirectory({...fixtureMembers(),presence:[]});
  assert.deepEqual(answers(noRows,MEMBER_GP_ACCOUNT,GP1),{talks:true,may:[...permissions],reaches:false});
  const allLeft=memberDirectory({...fixtureMembers(),presence:fixtureMembers().presence.map(row=>({...row,state:'left' as const}))});
  assert.deepEqual(answers(allLeft,MEMBER_NG_ACCOUNT,NG1),{talks:true,may:[...permissions],reaches:false});
  // A stranger, an unknown account and nothing at all are refused everywhere.
  for(const account of [BOB_ACCOUNT,accountIdFor('telegram','703'),'',null,undefined])
    for(const chat of [GP1,GP4,NG1])assert.deepEqual({talks:directory.talks(account,chat,served),reaches:directory.reaches(account,chat,'post',served)},{talks:false,reaches:false});
});

test('a paused member, or one with talk off, can do nothing; talk back on restores the sub-permissions as they were',()=>{
  const paused=fixtureMemberDirectory({[MEMBER_GP_ID]:{state:'paused'}});
  for(const chat of [GP1,GP2,GP4])assert.deepEqual(answers(paused,MEMBER_GP_ACCOUNT,chat),{talks:false,may:[],reaches:false},chat);
  assert.equal(paused.tasks(MEMBER_GP_ACCOUNT),'write','the stored setting stays');
  assert.deepEqual(answers(paused,MEMBER_NG_ACCOUNT,NG1),{talks:true,may:[...permissions],reaches:true},'another member is not touched');
  const off=fixtureMemberDirectory({[MEMBER_GP_ID]:{group_talk:false,group_post_other:false}});
  assert.deepEqual(answers(off,MEMBER_GP_ACCOUNT,GP1),{talks:false,may:[],reaches:false},'every sub-permission is off with talk');
  assert.deepEqual({jobs:off.get(MEMBER_GP_ID)?.jobs,post:off.get(MEMBER_GP_ID)?.post,tools:off.get(MEMBER_GP_ID)?.tools},{jobs:true,post:false,tools:true},
    'but each keeps its own value');
  const on=fixtureMemberDirectory({[MEMBER_GP_ID]:{group_post_other:false}});
  assert.deepEqual(answers(on,MEMBER_GP_ACCOUNT,GP1),{talks:true,may:['jobs','tools'],reaches:true},'talk back on: the kept values are back');
  assert.equal(on.reaches(MEMBER_GP_ACCOUNT,GP1,'post',served),false,'reach with a permission needs that permission');
  assert.equal(on.reaches(MEMBER_GP_ACCOUNT,GP1,'jobs',served),true);
  for(const permission of permissions) {
    const one=fixtureMemberDirectory({[MEMBER_NG_ID]:{[permission==='jobs'?'group_jobs':permission==='post'?'group_post_other':'group_tools']:false}});
    assert.deepEqual(answers(one,MEMBER_NG_ACCOUNT,NG1).may,permissions.filter(other=>other!==permission),permission);
  }
});

test('tasks gives the member\'s setting, write for the owner and null for anyone else',()=>{
  const directory=fixtureMemberDirectory({[MEMBER_NG_ID]:{tasks:'read'}});
  assert.deepEqual([directory.tasks(MEMBER_GP_ACCOUNT),directory.tasks(MEMBER_NG_ACCOUNT),directory.tasks(OWNER_ACCOUNT),directory.tasks(BOB_ACCOUNT),directory.tasks(null)],
    ['write','read','write',null,null]);
});

test('accounts lists only members who reach a served group, with those groups',()=>{
  const directory=fixtureMemberDirectory();
  assert.deepEqual(directory.accounts(served),new Map([[MEMBER_GP_ACCOUNT,[GP1]],[MEMBER_NG_ACCOUNT,[NG1,NG2].sort()]]));
  assert.equal(directory.accounts(served),directory.accounts(served),'kept for the same chat directory');
  assert.deepEqual([...fixtureMemberDirectory({[MEMBER_GP_ID]:{state:'paused'}}).accounts(served).keys()],[MEMBER_NG_ACCOUNT]);
  assert.deepEqual([...fixtureMemberDirectory().accounts(fixtureDirectory()).keys()],[MEMBER_GP_ACCOUNT],'NG groups not served: no reach there');
  // Without a directory argument it reads the installed chat directory.
  const restore=installChatsForTest(served);
  try {assert.deepEqual([...directory.accounts().keys()].sort(),[MEMBER_GP_ACCOUNT,MEMBER_NG_ACCOUNT].sort());assert.equal(directory.talks(MEMBER_NG_ACCOUNT,NG2),true);}
  finally{restore();}
});

test('an empty directory refuses everyone but the owner, and a process that never loads one admits no member',()=>{
  const empty=memberDirectory({members:[],accounts:[],chats:[],presence:[],owner_account:OWNER_ACCOUNT});
  assert.deepEqual(answers(empty,OWNER_ACCOUNT,GP1),{talks:true,may:[...permissions],reaches:true});
  for(const account of [MEMBER_GP_ACCOUNT,MEMBER_NG_ACCOUNT,BOB_ACCOUNT])for(const chat of [GP1,NG1])
    assert.deepEqual(answers(empty,account,chat),{talks:false,may:[],reaches:false});
  assert.equal(empty.accounts(served).size,0);assert.equal(empty.dailyMessages,200);assert.equal(empty.revision,0);
  // The process default knows no owner either: every caller checks the owner first.
  for(const account of [MEMBER_GP_ACCOUNT,OWNER_ACCOUNT])assert.equal(members().talks(account,GP1,served),false);
  assert.equal(members().accounts(served).size,0);
});

test('installing members: the test installer puts the previous directory back, and freshMembers asks the loader first',async()=>{
  const before=members(),fixture=fixtureMemberDirectory();
  const restore=installMembersForTest(fixture);
  try {
    assert.equal(members(),fixture);
    assert.equal(await freshMembers(),fixture,'no loader: the installed directory');
    let asked=0;const next=fixtureMemberDirectory({[MEMBER_GP_ID]:{state:'paused'}});
    setMemberLoader({async current(){asked++;installMembers(next);}});
    assert.equal(await freshMembers(),next);assert.equal(asked,1);
    const snapshot:MemberSnapshot={...fixtureMembers(),revision:7,daily_messages:50};
    const installed=installMembers(snapshot);
    assert.deepEqual([installed.revision,installed.dailyMessages],[7,50]);
  } finally{restore();}
  assert.equal(members(),before);
  assert.equal(await freshMembers(),before,'the test installer\'s loader is put back too');
});

test('a snapshot that breaks the schema\'s rules is refused, so it is never installed',()=>{
  const base=fixtureMembers(),bad:[string,MemberSnapshot][]=[
    ['member_id',{...base,members:[...base.members,{...base.members[0]!}]}],
    ['member_id',{...base,members:[{...base.members[0]!,id:'x'}]}],
    ['member_row',{...base,members:[{...base.members[0]!,state:'removed' as never}]}],
    ['member_row',{...base,members:[{...base.members[0]!,tasks:'none' as never}]}],
    ['member_account',{...base,accounts:[{account_id:BOB_ACCOUNT,member_id:'f'.repeat(64)}]}],
    ['member_account_duplicate',{...base,accounts:[...base.accounts,{account_id:MEMBER_GP_ACCOUNT,member_id:MEMBER_NG_ID}]}],
    ['member_chat',{...base,chats:[{member_id:MEMBER_GP_ID,chat_id:'',enabled:true}]}],
    ['member_chat_duplicate',{...base,chats:[...base.chats,{member_id:MEMBER_GP_ID,chat_id:GP1,enabled:false}]}],
    ['member_presence',{...base,presence:[{account_id:MEMBER_GP_ACCOUNT,chat_id:GP1,state:'joined' as never}]}],
    ['member_presence_duplicate',{...base,presence:[...base.presence,{account_id:MEMBER_GP_ACCOUNT,chat_id:GP1,state:'left'}]}],
    ['daily_messages',{...base,daily_messages:0}],['daily_messages',{...base,daily_messages:10001}],['revision',{...base,revision:-1}],
    ['owner_account',{...base,owner_account:'123'}],
  ];
  for(const [reason,snapshot] of bad)assert.throws(()=>memberDirectory(snapshot),{message:'invalid_member_directory:'+reason},reason);
});

test('the Members routes check each body\'s shape before the repository sees it',async()=>{
  const groups={[GP1]:true,[GP2]:false};
  assert.deepEqual(memberAddRequest({operation_id:'op-1',account_id:MEMBER_GP_ACCOUNT,groups}),{operation_id:'op-1',account_id:MEMBER_GP_ACCOUNT,telegram_id:null,groups});
  assert.deepEqual(memberAddRequest({operation_id:'op-2',telegram_id:'703',groups:{[NG1]:true}}),{operation_id:'op-2',account_id:null,telegram_id:'703',groups:{[NG1]:true}});
  for(const [body,code] of [
    [{operation_id:'op',account_id:MEMBER_GP_ACCOUNT,telegram_id:'703',groups},'invalid_member_request'],[{operation_id:'op',groups},'invalid_member_request'],
    [{operation_id:'op',account_id:'703',groups},'invalid_member_request'],[{operation_id:'op',telegram_id:'-703',groups},'invalid_member_request'],
    [{operation_id:'op',telegram_id:703,groups},'invalid_member_request'],[{operation_id:'op',account_id:MEMBER_GP_ACCOUNT,groups:{[GP1]:false}},'member_group_required'],
    [{operation_id:'op',account_id:MEMBER_GP_ACCOUNT,groups:{}},'member_group_required'],[{operation_id:'op',account_id:MEMBER_GP_ACCOUNT,groups:{[GP1]:'yes'}},'invalid_member_groups'],
    [{operation_id:'op',account_id:MEMBER_GP_ACCOUNT,groups:{'not a chat':true}},'invalid_member_groups'],[{operation_id:'op',account_id:MEMBER_GP_ACCOUNT,groups:[GP1]},'expected_object'],
    [{operation_id:'',account_id:MEMBER_GP_ACCOUNT,groups},'operation_id_required'],[{account_id:MEMBER_GP_ACCOUNT,groups},'invalid_string'],
    [{operation_id:'op',account_id:MEMBER_GP_ACCOUNT,groups,name:'x'},'unknown_member_field'],
  ] as const)assert.throws(()=>memberAddRequest(body),{code},JSON.stringify(body));
  assert.deepEqual(memberChangeRequest({operation_id:'op-3',changes:{state:'paused',talk:false,jobs:true,post:false,tools:true,tasks:'read',groups:{[GP3]:true}}}),
    {operation_id:'op-3',changes:{state:'paused',talk:false,jobs:true,post:false,tools:true,tasks:'read',groups:{[GP3]:true}}});
  assert.deepEqual(memberChangeRequest({operation_id:'op-4',changes:{groups:{[NG2]:false}}}),{operation_id:'op-4',changes:{groups:{[NG2]:false}}});
  for(const [body,code] of [[{operation_id:'op',changes:{}},'member_change_empty'],[{operation_id:'op',changes:{groups:{}}},'member_change_empty'],
    [{operation_id:'op',changes:{state:'removed'}},'invalid_member_request'],[{operation_id:'op',changes:{tasks:'none'}},'invalid_member_request'],
    [{operation_id:'op',changes:{talk:'on'}},'invalid_member_request'],[{operation_id:'op',changes:{owner:true}},'unknown_member_field'],
    [{operation_id:'op',changes:{talk:true},extra:1},'unknown_member_field'],[{operation_id:'op'},'expected_object']] as const)
    assert.throws(()=>memberChangeRequest(body),{code},JSON.stringify(body));
  assert.deepEqual(memberRemoveRequest({operation_id:'op-5'}),{operation_id:'op-5'});
  assert.throws(()=>memberRemoveRequest({operation_id:'op',id:MEMBER_GP_ID}),{code:'unknown_member_field'});
  assert.deepEqual(memberSettingsRequest({operation_id:'op-6',daily_messages:1}),{operation_id:'op-6',daily_messages:1});
  assert.deepEqual(memberSettingsRequest({operation_id:'op-7',daily_messages:10000}),{operation_id:'op-7',daily_messages:10000});
  for(const value of [0,10001,1.5,'200',null])assert.throws(()=>memberSettingsRequest({operation_id:'op',daily_messages:value}),{code:'invalid_daily_messages'},String(value));
});

test('the new editable text names, and the proxy accounts that are never a member',()=>{
  assert.deepEqual(memberTextKeys,{dailyLimit:'telegram.member_daily_limit',groupTools:'telegram.group_tools_texts'});
  assert.deepEqual(groupToolsTextLabels,['allowed_follow_up','allowed']);assert.equal(memberChangedReason,'reason_member_changed');
  assert.deepEqual(['1087968824','136817688','777000',MEMBER_GP].map(isProxyAccount),[true,true,true,false]);
});

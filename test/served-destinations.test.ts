import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {accountIdFor,chatDirectory,chatIdFor,chatShortId,conversationFields,installChatsForTest,type ChatDirectory} from '../src/chats.js';
import {allowedAccounts,allowedIn,servedDestination} from '../src/destinations.js';
import {BOB,BOB_CHAT,GP1,GP1_TOPIC,GP2,GP3,NG2,NG2_TG,OWNER,UNSERVED,fixtureChats,fixtureDirectory,legacyDirectory} from './fixture-groups.js';
import {grantMembers,type GrantOptions,type GroupGrants} from './fixture-member-grants.js';

// Synthetic people: Bob (BOB) and Cara, someone with a private chat but no account row.
const CARA='789',CARA_CHAT=chatIdFor('telegram',CARA);
const policy:Pick<AssistantPolicy,'owner_id'>={owner_id:OWNER};
/** GP1 and NG2 served; GP2, GP3, GP4 and UNSERVED off; Cara's private chat has no account. */
function directory():ChatDirectory {
  const fixture=fixtureChats([GP1,NG2_TG]);
  return chatDirectory({...fixture,chats:[...fixture.chats,{id:CARA_CHAT,app:'telegram',kind:'private',parent_id:null,topic_key:null,state:'off',title:'Cara',account_id:null}],
    ids:[...fixture.ids,{app:'telegram',external_id:CARA,chat_id:CARA_CHAT,state:'current'}]});
}
/** Runs `check` with the members the lists make installed (step 3), then puts the previous directory back. */
function withMembers(grants:GroupGrants,options:GrantOptions,check:()=>void):void {
  const restore=grantMembers(grants,{owner:OWNER,...options});
  try{check();}finally{restore();}
}

test('a send goes only to the owner, a served group or topic, or the private chat of a member who reaches a served group',()=>{
  const d=directory(),legacy=legacyDirectory([OWNER+'/topic/5',GP1,UNSERVED,UNSERVED+'/topic/3'],{owner:OWNER,served:[GP1]});
  assert.deepEqual(servedDestination(policy,OWNER,d),{kind:'owner'});
  assert.deepEqual(servedDestination(policy,OWNER+'/topic/5',legacy),{kind:'owner'},'a topic of the owner\'s chat is the owner\'s');
  assert.deepEqual(servedDestination(policy,GP1,d),{kind:'group',group:GP1});
  assert.deepEqual(servedDestination(policy,GP1_TOPIC,d),{kind:'group',group:GP1},'a topic follows its group');
  assert.deepEqual(servedDestination(policy,NG2,d),{kind:'group',group:NG2});
  const unknown=createHash('sha256').update('made-up chat').digest('hex');
  for(const [id,dir,why] of [[GP2,d,'an off group'],[UNSERVED,d,'an unserved group'],[UNSERVED+'/topic/3',legacy,'a topic of an unserved group'],
    [BOB_CHAT,d,'a stranger\'s private chat'],[unknown,d,'an id no row names'],[CARA_CHAT,d,'a private chat with no account']] as const)
    assert.equal(servedDestination(policy,id,dir),null,why);
  // Cara is a member who reaches GP1, but her private chat names no account, so it is still not a destination.
  withMembers({[GP1]:{granted:[CARA]}},{},()=>assert.equal(servedDestination(policy,CARA_CHAT,d),null));
});

test('a member\'s private chat is served while they reach a served group, and lists those groups (step 3)',()=>{
  const d=directory(),bob=accountIdFor('telegram',BOB);
  withMembers({[GP1]:{granted:[BOB]}},{},()=>assert.deepEqual(servedDestination(policy,BOB_CHAT,d),{kind:'person',account:bob,groups:[GP1]}));
  withMembers({[GP2]:{granted:[BOB]}},{},()=>assert.equal(servedDestination(policy,BOB_CHAT,d),null,'on only in an off group, never seen in GP1'));
  withMembers({[GP1]:{granted:[BOB],denied:[BOB]}},{},()=>assert.equal(servedDestination(policy,BOB_CHAT,d),null,'switched off'));
  withMembers({[GP1]:{granted:[BOB]}},{changes:{[BOB]:{state:'paused'}}},()=>assert.equal(servedDestination(policy,BOB_CHAT,d),null,'paused'));
  withMembers({[GP1]:{granted:[BOB]}},{changes:{[BOB]:{group_talk:false}}},()=>assert.equal(servedDestination(policy,BOB_CHAT,d),null,'talk off'));
  withMembers({[GP1]:{granted:[BOB]}},{left:{[BOB]:[GP1]}},()=>assert.equal(servedDestination(policy,BOB_CHAT,d),null,'Telegram saw them leave'));
  // An upgraded group is one chat: its switch and Telegram's row are the chat's, whichever id Telegram used.
  withMembers({[NG2]:{granted:[BOB]}},{},()=>assert.deepEqual(servedDestination(policy,BOB_CHAT,d),{kind:'person',account:bob,groups:[NG2]}));
  withMembers({[GP1]:{granted:[BOB]},[NG2]:{granted:[BOB]},[GP3]:{granted:[BOB]}},{},
    ()=>assert.deepEqual(servedDestination(policy,BOB_CHAT,d),{kind:'person',account:bob,groups:[GP1,NG2].sort()},'served groups only, sorted'));
  // The owner's own chat is never a person's, even where a directory has no owner chat and the owner is linked to a member.
  const ownerless=chatDirectory({...fixtureChats([GP1]),owner_chat:null});
  withMembers({[GP1]:{granted:[OWNER]}},{owner:null},()=>assert.equal(servedDestination(policy,OWNER,ownerless),null));
});

test('allowedIn is reaches: the member\'s switch, the permission named and Telegram\'s newest row in that group (step 3)',()=>{
  const d=directory(),restore=installChatsForTest(d);
  try {
    withMembers({[GP1]:{granted:[BOB,'901'],denied:['901']},[GP2]:{granted:[BOB]},[NG2]:{granted:[BOB]}},{},()=>{
      for(const [user,group,expected] of [[BOB,GP1,true],[BOB,GP1_TOPIC,true],[BOB,NG2,true],[BOB,GP2,false],[BOB,UNSERVED,false],
        ['901',GP1,false],['902',GP1,false],[OWNER,GP1,true],[OWNER,GP2,false]] as const) {
        assert.equal(allowedIn(group,user,null,d),expected,`${user} in ${group}`);
        assert.equal(allowedIn(group,user),expected,`${user} in ${group}, by the installed directory`);
      }
      for(const permission of ['jobs','post','tools'] as const)assert.equal(allowedIn(GP1,BOB,permission,d),true,permission);
    });
    withMembers({[GP1]:{granted:[BOB]}},{changes:{[BOB]:{group_jobs:false}}},()=>{
      assert.equal(allowedIn(GP1,BOB,'jobs'),false,'the permission off');assert.equal(allowedIn(GP1,BOB),true,'talk alone');
    });
    withMembers({[GP1]:{granted:[BOB]}},{left:{[BOB]:[GP1]}},()=>assert.equal(allowedIn(GP1,BOB),false,'left'));
    withMembers({},{},()=>assert.equal(allowedIn(GP1,BOB),false,'no member'));
  }finally{restore();}
});

test('allowed accounts are worked out once per chat directory and member directory',()=>{
  const d=directory();
  withMembers({[GP1]:{granted:[BOB]}},{},()=>{
    const map=allowedAccounts(d);
    assert.deepEqual([...map],[[accountIdFor('telegram',BOB),[GP1]]]);
    assert.equal(allowedAccounts(d),map,'the same Map for the same directories');
    assert.notEqual(allowedAccounts(fixtureDirectory([GP1])),map,'a new chat directory is worked out again');
    withMembers({},{},()=>assert.deepEqual([...allowedAccounts(d)],[],'and so is a new member directory'));
  });
});

test('account ids are the same digests with the memo, and a bad reference still throws',()=>{
  const expected=createHash('sha256').update(JSON.stringify(['account','telegram','',BOB])).digest('hex');
  assert.equal(accountIdFor('telegram',BOB),expected);assert.equal(accountIdFor('telegram',BOB),expected,'a second call reads the memo');
  assert.notEqual(accountIdFor('slack','U0EXAMPLE','T0EXAMPLE'),accountIdFor('slack','U0EXAMPLE','T0OTHER'));
  for(let i=0;i<2;i++)assert.throws(()=>accountIdFor('telegram','not an id'),/invalid_account_reference/);
});

test('a chat\'s short id is a hash of its id, the same on the dashboard as on a card',()=>{
  const d=directory();
  assert.equal(conversationFields(d,GP1).short_id,chatShortId(GP1));
  assert.match(chatShortId(GP1),/^[a-f0-9]{4}$/);assert.notEqual(chatShortId(GP1),chatShortId(GP2));
  assert.equal(chatShortId(GP1),createHash('sha256').update(JSON.stringify(['chat-label-v1',GP1])).digest('hex').slice(0,4));
  const unknown=createHash('sha256').update('made-up chat').digest('hex');
  assert.equal(conversationFields(d,unknown).short_id,chatShortId(unknown),'an unknown chat has one too');
});

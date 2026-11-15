import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {groupAccessFor,type AssistantPolicy,type GroupAccess} from '../src/assistant-policy.js';
import {accountIdFor,chatDirectory,chatIdFor,chatShortId,conversationFields,installChatsForTest,type ChatDirectory} from '../src/chats.js';
import {allowedAccounts,allowedIn,servedDestination} from '../src/destinations.js';
import {BOB,BOB_CHAT,GP1,GP1_TOPIC,GP2,GP3,NG2,NG2_OLD_TG,NG2_TG,OWNER,UNSERVED,fixtureChats,fixtureDirectory,legacyDirectory} from './fixture-groups.js';

// Synthetic people: Bob (BOB) and Cara, someone with a private chat but no account row.
const CARA='789',CARA_CHAT=chatIdFor('telegram',CARA);
const policy=(group_access:AssistantPolicy['group_access']={}):Pick<AssistantPolicy,'group_access'|'owner_id'>=>({owner_id:OWNER,group_access});
/** GP1 and NG2 served; GP2, GP3, GP4 and UNSERVED off; Cara's private chat has no account. */
function directory():ChatDirectory {
  const fixture=fixtureChats([GP1,NG2_TG]);
  return chatDirectory({...fixture,chats:[...fixture.chats,{id:CARA_CHAT,app:'telegram',kind:'private',parent_id:null,topic_key:null,state:'off',title:'Cara',account_id:null}],
    ids:[...fixture.ids,{app:'telegram',external_id:CARA,chat_id:CARA_CHAT,state:'current'}]});
}

test('a send goes only to the owner, a served group or topic, or a person allowed in a served group',()=>{
  const d=directory(),legacy=legacyDirectory([OWNER+'/topic/5',GP1,UNSERVED,UNSERVED+'/topic/3'],{owner:OWNER,served:[GP1]});
  assert.deepEqual(servedDestination(policy(),OWNER,d),{kind:'owner'});
  assert.deepEqual(servedDestination(policy(),OWNER+'/topic/5',legacy),{kind:'owner'},'a topic of the owner\'s chat is the owner\'s');
  assert.deepEqual(servedDestination(policy(),GP1,d),{kind:'group',group:GP1});
  assert.deepEqual(servedDestination(policy(),GP1_TOPIC,d),{kind:'group',group:GP1},'a topic follows its group');
  assert.deepEqual(servedDestination(policy(),NG2,d),{kind:'group',group:NG2});
  const unknown=createHash('sha256').update('made-up chat').digest('hex');
  for(const [id,dir,why] of [[GP2,d,'an off group'],[UNSERVED,d,'an unserved group'],[UNSERVED+'/topic/3',legacy,'a topic of an unserved group'],
    [BOB_CHAT,d,'a stranger\'s private chat'],[unknown,d,'an id no row names'],[CARA_CHAT,d,'a private chat with no account']] as const)
    assert.equal(servedDestination(policy(),id,dir),null,why);
  // Cara is granted, but her private chat names no account, so it is still not a destination.
  assert.equal(servedDestination(policy({[GP1]:{granted:[CARA],denied:[]}}),CARA_CHAT,d),null);
});

test('a person\'s private chat is served while they are allowed in a served group, and lists those groups',()=>{
  const d=directory(),bob=accountIdFor('telegram',BOB);
  assert.deepEqual(servedDestination(policy({[GP1]:{granted:[BOB],denied:[]}}),BOB_CHAT,d),{kind:'person',account:bob,groups:[GP1]});
  assert.equal(servedDestination(policy({[GP2]:{granted:[BOB],denied:[]}}),BOB_CHAT,d),null,'granted only in an off group');
  assert.equal(servedDestination(policy({[GP1]:{granted:[BOB],denied:[BOB]}}),BOB_CHAT,d),null,'denied wins');
  // An upgraded group keeps its lists under both Telegram ids: denied under the old one wins over granted under the new.
  assert.deepEqual(servedDestination(policy({[NG2_OLD_TG]:{granted:[BOB],denied:[]}}),BOB_CHAT,d),{kind:'person',account:bob,groups:[NG2]});
  assert.equal(servedDestination(policy({[NG2_TG]:{granted:[BOB],denied:[]},[NG2_OLD_TG]:{granted:[],denied:[BOB]}}),BOB_CHAT,d),null);
  const both=policy({[GP1]:{granted:[BOB],denied:[]},[NG2_TG]:{granted:[BOB],denied:[]},[GP3]:{granted:[BOB],denied:[]}});
  assert.deepEqual(servedDestination(both,BOB_CHAT,d),{kind:'person',account:bob,groups:[GP1,NG2].sort()},'served groups only, sorted');
  // The owner's own chat is never a person's, even where a directory has no owner chat.
  const ownerless=chatDirectory({...fixtureChats([GP1]),owner_chat:null});
  assert.equal(servedDestination(policy(),OWNER,ownerless),null);
});

test('allowedIn reads the access lists only, as a job\'s requester check and the groups a person may ask in do',()=>{
  const access:Record<string,GroupAccess>={[GP1]:{granted:[BOB,'901'],denied:['901']},[GP2]:{granted:[BOB],denied:[]},[NG2_OLD_TG]:{granted:[BOB],denied:[]},[NG2_TG]:{granted:[],denied:['902']}};
  const d=directory(),restore=installChatsForTest(d);
  try {
    const full:AssistantPolicy={enabled:true,owner_id:OWNER,group_ids:[GP1,NG2_TG],group_access:access,owner_chat:OWNER};
    // The two checks as the stores make them today (background-jobs permitted, telegram-actions allowedGroups).
    const permitted=(scope:string,requester:string)=>{const a=groupAccessFor(full,scope);return !!a?.granted.includes(requester)&&!a.denied.includes(requester);};
    const listed=(chat:string,user:string)=>{const app=d.get(chat)!.app_ids,lists=(external:string)=>access[external];
      return app.some(id=>!!lists(id.external)?.granted.includes(user))&&!app.some(id=>!!lists(id.external)?.denied.includes(user));};
    for(const user of [OWNER,BOB,'901','902'])for(const group of [GP1,GP1_TOPIC,GP2,NG2,UNSERVED]) {
      assert.equal(allowedIn(full,group,user,d),permitted(group,user),`${user} in ${group}`);
      if(d.kind(group)==='group')assert.equal(allowedIn(full,group,user),listed(group,user),`${user} in ${group}, by the installed directory`);
    }
    assert.equal(allowedIn(full,GP2,BOB,d),true,'served is not asked: an off group keeps its lists');
    assert.equal(allowedIn(full,GP1,OWNER,d),false,'the owner is never in the lists');
  }finally{restore();}
});

test('allowed accounts are worked out once per directory and policy',()=>{
  const d=directory(),p=policy({[GP1]:{granted:[BOB,'not an id'],denied:[]}}),map=allowedAccounts(p,d);
  assert.deepEqual([...map],[[accountIdFor('telegram',BOB),[GP1]]],'an id no account can be made from is skipped');
  assert.equal(allowedAccounts(p,d),map,'the same Map for the same directory and policy');
  assert.notEqual(allowedAccounts({...p},d),map,'a new policy is worked out again');
  assert.notEqual(allowedAccounts(p,fixtureDirectory([GP1])),map,'so is a new directory');
  p.group_access={};assert.deepEqual([...allowedAccounts(p,d)],[],'and lists put in place of the old ones');
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

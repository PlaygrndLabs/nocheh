import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {settings} from './fixture-settings.js';
import {initialize} from '../src/database.js';
import {digest,ingest,type Envelope} from '../src/archive.js';
import {immutableFile} from '../src/storage.js';
import {allowedSender,assistantPolicy,conversationScope,notesSender,outsideChat,settleTelegramChat,telegramDeliveryAllowed,type AssistantPolicy} from '../src/assistant-policy.js';
import {installChats,installChatsForTest,setChatLoader} from '../src/chats.js';
import {BOB,BOB_CHAT,GP1,GP2,GP3,GP4,GP_GROUP_IDS,MEMBER_GP,MEMBER_GP_ID,MEMBER_NG,MEMBER_NG_ID,NG1,NG1_TG,NG2,NG2_OLD_TG,NG2_TG,NG_GROUP_IDS,OWNER,UNSERVED,fixtureDirectory,fixtureMemberDirectory,fixtureMembers,policyDirectory} from './fixture-groups.js';
import {installMembersForTest,memberDirectory} from '../src/members.js';
import {grantMembers} from './fixture-member-grants.js';
import {prepareArchiveFiles} from '../src/preparation.js';
import {dispatchCommitted,storedTranscripts} from '../src/assistant.js';
import {fixtureBrain} from './fixture-brain.js';
import {preparationStatus} from '../src/workflows/preparation-status.js';
import {requestAction,controlReply,executeApproved} from '../src/actions.js';

const policy={enabled:true,owner_id:'123',group_ids:['-20','-30']};
// The chats these tests use, as the seeder makes their rows from the policy (ADR-0252).
installChatsForTest(policyDirectory(policy,['456','-99']));
const update=(chat:number,user:number,type='group')=>({update_id:1,message:{message_id:7,chat:{id:chat,type},from:{id:user,is_bot:false},text:'exact Aws 😃\r\n '}});
test('only owner private messages receive owner scope; selected groups stay group-local even for the owner',()=>{
  assert.equal(conversationScope(policy,update(123,123,'private'),'123')?.owner,true);
  assert.equal(conversationScope(policy,update(-20,123),'-20')?.owner,false);
  assert.equal(conversationScope(policy,update(123,456,'private'),'123'),null);
  assert.equal(conversationScope(policy,update(-99,123),'-99'),null);
  assert.equal(conversationScope(policy,{edited_message:update(-20,123).message},'-20'),null);
  assert.throws(()=>conversationScope(policy,update(-20,123),'-30'),{code:'source_scope_mismatch'});
});

test('in a group the owner and the members who talk there are answered: a stranger, a group switched off for a member, a pause and talk off are not (step 3)',()=>{
  assert.equal(conversationScope(policy,update(-20,456),'-20'),null,'a stranger');
  // A member with no row for a group talks there: a group the owner never switched counts as on.
  let restore=grantMembers({'-20':{granted:['456']}},{owner:'123'});
  try {
    assert.equal(conversationScope(policy,update(-20,456),'-20')?.user_id,'456');
    assert.equal(conversationScope(policy,update(-30,456),'-30')?.user_id,'456','no row for that group: on');
  }finally{restore();}
  restore=grantMembers({'-20':{granted:['456']}},{owner:'123',groups:['-30']});
  try {
    assert.equal(conversationScope(policy,update(-30,456),'-30'),null,'the group switched off for them');
    assert.equal(conversationScope(policy,update(-20,123),'-20')?.owner,false,'the owner first, never a member');
  }finally{restore();}
  for(const change of [{state:'paused' as const},{group_talk:false}]) {
    const off=grantMembers({'-20':{granted:['456']}},{owner:'123',changes:{'456':change}});
    try{assert.equal(conversationScope(policy,update(-20,456),'-20'),null,JSON.stringify(change));}finally{off();}
  }
});

test('a chat is answered by its chat row: digest chats, upgraded groups and access under an old id (ADR-0252)',()=>{
  const restore=installChatsForTest(fixtureDirectory([...GP_GROUP_IDS,...NG_GROUP_IDS]));
  try {
    const served:AssistantPolicy={enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:[...GP_GROUP_IDS,...NG_GROUP_IDS]};
    // A group first seen after step 2b is answered under its Nocheh id, never its Telegram id.
    assert.deepEqual(conversationScope(served,update(Number(NG1_TG),123,'supergroup'),NG1_TG),{owner:false,chat_id:NG1,user_id:'123'});
    assert.deepEqual(conversationScope(served,update(Number(GP1),123,'supergroup'),GP1),{owner:false,chat_id:GP1,user_id:'123'});
    // An upgraded group is one chat under its current and its old Telegram id.
    for(const raw of [NG2_TG,NG2_OLD_TG])assert.equal(conversationScope(served,update(Number(raw),123,'supergroup'),raw)?.chat_id,NG2,raw);
    // A member talks in the upgraded group under either Telegram id: their switch is the chat's, not an id's (step 3).
    const people=installMembersForTest(fixtureMemberDirectory());
    try {
      for(const raw of [NG2_TG,NG2_OLD_TG])assert.equal(conversationScope(served,update(Number(raw),Number(MEMBER_NG),'supergroup'),raw)?.user_id,MEMBER_NG,raw);
      assert.equal(conversationScope(served,update(Number(GP3),Number(MEMBER_GP),'supergroup'),GP3),null,'a group switched off for them');
      assert.equal(conversationScope(served,update(Number(NG2_TG),Number(BOB),'supergroup'),NG2_TG),null,'a stranger');
    }finally{people();}
    // A group with no row, or one the owner does not serve, is answered nowhere; neither is Bob's own private chat.
    assert.equal(conversationScope(served,update(-1009999999999,123,'supergroup'),'-1009999999999'),null);
    const unserved={...served,group_ids:[...GP_GROUP_IDS]};
    restore();installChatsForTest(fixtureDirectory(unserved.group_ids));
    assert.equal(conversationScope(unserved,update(Number(NG1_TG),123,'supergroup'),NG1_TG),null);
    assert.equal(conversationScope(served,update(Number(BOB),Number(BOB),'private'),BOB),null);
    assert.equal(conversationScope(served,update(123,123,'private'),'123')?.owner,true);
    // Delivery compares Nocheh chats: a digest group's turn may answer its own original only.
    installChatsForTest(fixtureDirectory(served.group_ids));
    const source={origin:'live',channel:'telegram',kind:'telegram_update',scope:NG1_TG,payload:Buffer.from(JSON.stringify(update(Number(NG1_TG),123,'supergroup')))};
    assert.equal(telegramDeliveryAllowed(served,{scope:NG1},source),true);
    assert.equal(telegramDeliveryAllowed(served,{scope:NG1_TG},source),false,'a Telegram id is no Nocheh chat');
    // Outside chats: a private chat with anyone but the owner, an unserved group, and any chat with no row.
    const live=(scope:string)=>({origin:'live',channel:'telegram',kind:'telegram_update',scope});
    for(const scope of [OWNER,GP1,NG1_TG,NG2_OLD_TG,NG2_TG,'system'])assert.equal(outsideChat(served,live(scope)),false,scope);
    for(const scope of [BOB,'-1009999999999','789'])assert.equal(outsideChat(served,live(scope)),true,scope);
    installChatsForTest(fixtureDirectory(unserved.group_ids));
    assert.equal(outsideChat(unserved,live(NG1_TG)),true,'an unserved digest group');
    assert.equal(BOB_CHAT.length,64);
  }finally{installChatsForTest(policyDirectory(policy,['456','-99']));}
});

test('a chat recorded a moment ago is looked up again before its message is judged outside or its turn refused',async()=>{
  // '-40' is served and was recorded by a capture that committed, but this process has not loaded it yet.
  const served={...policy,group_ids:[...policy.group_ids,'-40']},later=policyDirectory(served,['456','-99']);
  const restore=installChatsForTest(policyDirectory(policy,['456','-99']));let looked=0;
  setChatLoader({epoch(){},miss(){},current:async()=>{looked++;installChats(later);return later;}});
  try {
    const live=(scope:string)=>({origin:'live',channel:'telegram',kind:'telegram_update',scope});
    assert.equal(outsideChat(served,live('-40')),true,'unknown to this process: outside, if judged now');
    assert.equal(conversationScope(served,update(-40,123),'-40'),null);
    await settleTelegramChat(live('-40'));
    assert.equal(looked,1);assert.equal(outsideChat(served,live('-40')),false);assert.equal(conversationScope(served,update(-40,123),'-40')?.chat_id,'-40');
    // A chat this process holds, and an original that names no chat, are not looked up again.
    await settleTelegramChat(live('-40'));await settleTelegramChat(live('system'));await settleTelegramChat({channel:'browser',scope:'-41'});
    assert.equal(looked,1);
    // A chat still unknown after the second look stays outside (fail closed).
    await settleTelegramChat(live('-41'));assert.equal(looked,2);assert.equal(outsideChat(served,live('-41')),true);
  }finally{setChatLoader(null);restore();}
});

test('an allowed sender is the owner or a member who talks in that served group, in new and edited messages alike (step 3)',()=>{
  const edited=(chat:number,user:number)=>({update_id:2,edited_message:{...update(chat,user).message,edit_date:9}});
  assert.equal(allowedSender(policy,update(123,123,'private'),'123'),true,'the owner in their private chat');
  assert.equal(allowedSender(policy,update(-20,123),'-20'),true,'the owner in a group');
  assert.equal(allowedSender(policy,edited(-20,123),'-20'),true,'the owner\'s edit');
  assert.equal(allowedSender(policy,update(-20,456),'-20'),false,'not a member');
  let people=grantMembers({'-20':{granted:['456']}},{owner:'123',groups:['-30']});
  try {
    assert.equal(allowedSender(policy,update(-20,456),'-20'),true,'a member');
    assert.equal(allowedSender(policy,edited(-20,456),'-20'),true,'a member\'s edit');
    assert.equal(allowedSender(policy,update(-30,456),'-30'),false,'switched off in that group');
  }finally{people();}
  people=grantMembers({'-20':{granted:['456']}},{owner:'123',changes:{'456':{state:'paused'}}});
  try{assert.equal(allowedSender(policy,update(-20,456),'-20'),false,'a paused member');}finally{people();}
  people=grantMembers({'-20':{granted:['456']}},{owner:'123'});
  // A group no longer served: the directory, which follows chats.state, no longer serves it (ADR-0252, ADR-0253).
  const unselected={...policy,group_ids:['-30']},restore=installChatsForTest(policyDirectory(unselected,['-20','456','-99']));
  try{assert.equal(allowedSender(unselected,update(-20,456),'-20'),false,'a group no longer selected');}finally{restore();people();}
  assert.equal(allowedSender(policy,update(123,456,'private'),'123'),false,'a stranger in private');
  // Telegram's stand-ins for an anonymous admin and for a channel posting in the group.
  const anonymous={update_id:3,message:{message_id:8,chat:{id:-20,type:'supergroup'},from:{id:1000001,is_bot:true},sender_chat:{id:-20,type:'supergroup'}}};
  const channel={update_id:4,message:{message_id:9,chat:{id:-20,type:'supergroup'},from:{id:1000002,is_bot:true},sender_chat:{id:-1005,type:'channel'}}};
  assert.equal(allowedSender(policy,anonymous,'-20'),false,'an anonymous admin, who may be the owner');
  assert.equal(allowedSender(policy,channel,'-20'),false,'a channel post');
  assert.equal(allowedSender(policy,{update_id:5,message:{...update(-20,123).message,sender_chat:{id:-1005,type:'channel'}}},'-20'),false,'a post in a channel\'s name, even from the owner');
  assert.equal(allowedSender(policy,{update_id:6,message:{...update(-20,123).message,from:{id:123,is_bot:true}}},'-20'),false,'a bot');
  assert.equal(allowedSender(policy,{update_id:7,channel_post:{message_id:1,chat:{id:-20,type:'channel'}}},'-20'),false,'another kind of update');
  assert.equal(allowedSender(policy,{update_id:8,message:{message_id:1,chat:{id:-20,type:'group'}}},'-20'),false,'no sender');
  assert.equal(allowedSender(policy,update(-20,123),'-30'),false,'a message from another chat');
  assert.equal(allowedSender(policy,null,'-20'),false);
  assert.equal(allowedSender({...policy,enabled:false},update(-20,123),'-20'),true,'it does not depend on replies being on');
});

test('a reaction\'s sender is who reacted: the owner or a member who talks there, never a reaction in a chat\'s name or a count (step 3)',()=>{
  const reaction=(chat:number,type:string,who:Record<string,unknown>)=>({update_id:9,message_reaction:{chat:{id:chat,type},message_id:7,date:1,
    old_reaction:[],new_reaction:[{type:'emoji',emoji:'\u{1f44d}'}],...who}});
  assert.equal(allowedSender(policy,reaction(123,'private',{user:{id:123,is_bot:false}}),'123'),true,'the owner in their private chat');
  assert.equal(allowedSender(policy,reaction(-20,'supergroup',{user:{id:123,is_bot:false}}),'-20'),true,'the owner in a group');
  assert.equal(allowedSender(policy,reaction(-20,'supergroup',{user:{id:456,is_bot:false}}),'-20'),false,'not a member');
  let people=grantMembers({'-20':{granted:['456']}},{owner:'123',groups:['-30']});
  try {
    assert.equal(allowedSender(policy,reaction(-20,'supergroup',{user:{id:456,is_bot:false}}),'-20'),true,'a member');
    assert.equal(allowedSender(policy,reaction(-30,'supergroup',{user:{id:456,is_bot:false}}),'-30'),false,'switched off in that group');
  }finally{people();}
  people=grantMembers({'-20':{granted:['456']}},{owner:'123',changes:{'456':{state:'paused'}}});
  try{assert.equal(allowedSender(policy,reaction(-20,'supergroup',{user:{id:456,is_bot:false}}),'-20'),false,'a paused member');}finally{people();}
  assert.equal(allowedSender(policy,reaction(123,'private',{user:{id:456,is_bot:false}}),'123'),false,'a stranger in private');
  assert.equal(allowedSender(policy,reaction(-20,'supergroup',{actor_chat:{id:-20,type:'supergroup'}}),'-20'),false,'a reaction in the group\'s own name, which may be the owner');
  assert.equal(allowedSender(policy,reaction(-20,'supergroup',{user:{id:123,is_bot:false},actor_chat:{id:-20,type:'supergroup'}}),'-20'),false,'a chat\'s name wins over a user');
  assert.equal(allowedSender(policy,reaction(-20,'supergroup',{}),'-20'),false,'no one named');
  assert.equal(allowedSender(policy,reaction(-20,'supergroup',{user:{id:123,is_bot:true}}),'-20'),false,'a bot');
  assert.equal(allowedSender(policy,reaction(-20,'supergroup',{user:{id:123,is_bot:false}}),'-30'),false,'a reaction from another chat');
  assert.equal(allowedSender(policy,{update_id:10,message_reaction_count:{chat:{id:-20,type:'supergroup'},message_id:7,date:1,reactions:[]}},'-20'),false,'counts name no one');
});

test('the owner\'s notes take a Telegram update only from an allowed sender, Nocheh\'s own messages and the web chat always, and nothing else',()=>{
  const event=(kind:string,payload:unknown,scope='-20',channel='telegram')=>({channel,kind,scope,payload});
  assert.equal(notesSender(policy,event('telegram_update',update(-20,123))),'review','the owner in a group');
  assert.equal(notesSender(policy,event('telegram_update',update(123,123,'private'),'123')),'review','the owner in their private chat');
  const people=grantMembers({'-20':{granted:['456']}},{owner:'123'});
  try{assert.equal(notesSender(policy,event('telegram_update',update(-20,456))),'review','a member who talks there');}finally{people();}
  assert.equal(notesSender(policy,event('telegram_update',update(-20,456))),'sender_not_allowed','not a member');
  assert.equal(notesSender(policy,event('telegram_update',{update_id:2,edited_message:{...update(-20,456).message,edit_date:9}})),'sender_not_allowed','their edit');
  assert.equal(notesSender(policy,event('telegram_update',{update_id:3,message_reaction:{chat:{id:-20,type:'supergroup'},user:{id:456,is_bot:false},message_id:7,date:1,
    old_reaction:[],new_reaction:[]}})),'sender_not_allowed','their reaction');
  assert.equal(notesSender(policy,event('telegram_update',{update_id:4,message:{message_id:8,chat:{id:-20,type:'supergroup'},from:{id:1000001,is_bot:true},
    sender_chat:{id:-20,type:'supergroup'}}})),'sender_not_allowed','an anonymous admin');
  assert.equal(notesSender(policy,event('telegram_delivered_message',{message:{message_id:9,chat:{id:-20,type:'supergroup'}}})),'review','Nocheh\'s own message');
  assert.equal(notesSender(policy,event('browser_input',{text:'hi'},'123','browser')),'review','the owner\'s web chat');
  assert.equal(notesSender(policy,event('browser_delivered_message',{},'123','browser')),'review','Nocheh\'s answer there');
  for(const [kind,channel] of [['telegram_desktop_message','telegram'],['telegram_wire','telegram'],['browser_input','telegram'],['telegram_update','browser'],
    ['scheduled_result','scheduler'],['future_kind','telegram']])
    assert.equal(notesSender(policy,event(kind!,update(-20,123),'-20',channel)),'sender_not_allowed',kind+' '+channel);
});

test('an allowed sender is judged in the chat the directory finds: digest groups and an upgraded group under either id (ADR-0252, step 3)',()=>{
  installChatsForTest(fixtureDirectory([...GP_GROUP_IDS,...NG_GROUP_IDS]));
  const people=installMembersForTest(fixtureMemberDirectory());
  try {
    const served:AssistantPolicy={enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:[...GP_GROUP_IDS,...NG_GROUP_IDS]};
    const voice=(chat:string,user:string,type='supergroup')=>({update_id:1,message:{message_id:7,chat:{id:Number(chat),type},from:{id:Number(user),is_bot:false},voice:{file_id:'v1',duration:1200}}});
    // Members talk in old-shaped groups, a digest group, and an upgraded group under its new and its old Telegram id.
    for(const raw of [GP1,GP2,GP4])assert.equal(allowedSender(served,voice(raw,MEMBER_GP),raw),true,raw);
    for(const raw of [NG1_TG,NG2_TG,NG2_OLD_TG])assert.equal(allowedSender(served,voice(raw,MEMBER_NG),raw),true,raw);
    assert.equal(allowedSender(served,voice(GP3,MEMBER_GP),GP3),false,'a group switched off for them');
    assert.equal(allowedSender(served,voice(GP1,BOB),GP1),false,'a stranger');
    // A switch off for the upgraded group holds under both of its Telegram ids: it is the chat's, not an id's.
    const fixture=fixtureMembers(),off=installMembersForTest(memberDirectory({...fixture,chats:[...fixture.chats,{member_id:MEMBER_NG_ID,chat_id:NG2,enabled:false}]}));
    try{for(const raw of [NG2_TG,NG2_OLD_TG])assert.equal(allowedSender(served,voice(raw,MEMBER_NG),raw),false,raw);}finally{off();}
    // A paused member talks nowhere.
    const paused=installMembersForTest(fixtureMemberDirectory({[MEMBER_GP_ID]:{state:'paused'}}));
    try{assert.equal(allowedSender(served,voice(GP1,MEMBER_GP),GP1),false,'paused');}finally{paused();}
    // A group the directory does not serve, or has no row for, allows only the owner (fail closed).
    const stray='-1009999999999';
    assert.equal(allowedSender(served,voice(UNSERVED,MEMBER_GP),UNSERVED),false,'a group the directory does not serve');
    assert.equal(allowedSender(served,voice(stray,MEMBER_GP),stray),false,'a group with no row');
    assert.equal(allowedSender(served,voice(stray,OWNER),stray),true,'the owner, wherever they write');
    assert.equal(allowedSender(served,voice(MEMBER_GP,MEMBER_GP,'private'),MEMBER_GP),false,'a member in their own private chat');
    // The directory, which follows chats.state, decides what is served: a digest group it no longer serves.
    installChatsForTest(fixtureDirectory([...GP_GROUP_IDS]));
    assert.equal(allowedSender(served,voice(NG1_TG,MEMBER_NG),NG1_TG),false,'a digest group no longer served');
    assert.equal(allowedSender(served,voice(GP1,MEMBER_GP),GP1),true);
    assert.equal(NG1.length,64);assert.equal(NG2.length,64);
  }finally{people();installChatsForTest(policyDirectory(policy,['456','-99']));}
});

test('who may talk in groups is never configured: a policy file\'s or the environment\'s group access and group list are not read (step 3)',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'nocheh-policy-')),saved={...process.env};
  try {
    // ADR-0253: the owner adds Nocheh to a group or turns it on in Chats; servedPolicy derives group_ids from chats.state.
    // Step 3: the owner's members decide who talks; the policy holds no list of people, not even the owner listed in one.
    const file=join(folder,'policy.json');
    for(const access of [{'-20':{granted:['123'],denied:[]}},{'-1001234567890':{granted:['456'],denied:[]}},{'group':{granted:'x'}}]) {
      await writeFile(file,JSON.stringify({...policy,group_access:access}));
      const read=assistantPolicy(file);
      assert.deepEqual(read.group_ids,[],'a policy file\'s group_ids is ignored');
      assert.equal('group_access' in read,false,JSON.stringify(access));
    }
    Object.assign(process.env,{TELEGRAM_ENABLED:'true',TELEGRAM_OWNER_ID:'123',TELEGRAM_GROUP_IDS:'-20,not a list',TELEGRAM_GROUP_ACCESS:'not even JSON'});
    assert.deepEqual(assistantPolicy(),{enabled:true,owner_id:'123',group_ids:[],topic_memory:'group',owner_chat:'123'},'neither TELEGRAM_GROUP_IDS nor TELEGRAM_GROUP_ACCESS is read');
  }finally{
    for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);
    await rm(folder,{recursive:true,force:true});
  }
});

test('final Telegram delivery checks the original sender again: a member paused or switched off after the turn started is not answered (step 3)',()=>{
  const source={origin:'live',channel:'telegram',kind:'telegram_update',scope:'-20',payload:Buffer.from(JSON.stringify(update(-20,456)))};
  assert.equal(telegramDeliveryAllowed(policy,{scope:'-20'},source),false,'not a member');
  let people=grantMembers({'-20':{granted:['456']}},{owner:'123'});
  try {
    assert.equal(telegramDeliveryAllowed(policy,{scope:'-20'},source),true);
    assert.equal(telegramDeliveryAllowed(policy,{scope:null},source),false);
    assert.equal(telegramDeliveryAllowed(policy,{scope:'-20'},{...source,origin:'import'}),false);
    assert.equal(telegramDeliveryAllowed(policy,{scope:'-20'},null),false);
    assert.equal(telegramDeliveryAllowed(policy,{scope:null},{...source,channel:'browser'}),true);
  }finally{people();}
  for(const change of [{changes:{'456':{state:'paused' as const}}},{changes:{'456':{group_talk:false}}},{groups:['-20'],grants:{}}]) {
    people=grantMembers(change.grants??{'-20':{granted:['456']}},{owner:'123',...change});
    try{assert.equal(telegramDeliveryAllowed(policy,{scope:'-20'},source),false,JSON.stringify(change));}finally{people();}
  }
  // The owner's own message in a group never depends on the member directory.
  const own={...source,payload:Buffer.from(JSON.stringify(update(-20,123)))};
  assert.equal(telegramDeliveryAllowed(policy,{scope:'-20'},own),true);
});

test('real PostgreSQL: action proposals require a bound turn; only a captured owner DM can approve exact immutable arguments',{skip:!process.env.PGHOST},async()=>{
  const config=settings(),connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:config.databasePassword};
  const admin=new pg.Pool(connection),namespace=`actions_${Date.now()}`;
  await admin.query(`CREATE SCHEMA ${namespace}`);const pool=new pg.Pool({...connection,options:`-c search_path=${namespace}`});
  const input:Envelope={version:1,key:'action:source',origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'-20',source_id:'1',revision:'1',occurred_at:null,text:'Please contact another chat',payload:update(-20,456)};
  try {
    await initialize(pool);const source=await ingest(pool,input);
    await assert.rejects(requestAction(pool,{scope:'-20',admin:false},{destination:'777',text:'Synthetic external message'}),{code:'assistant_turn_required'});
    await assert.rejects(requestAction(pool,{scope:'-30',admin:false,turnEvent:source.id},{destination:'777',text:'Synthetic external message'}),{code:'action_scope_denied'});
    const action=await requestAction(pool,{scope:'-20',admin:false,turnEvent:source.id},{destination:'777',text:'Synthetic external message'});
    let sends=0;await executeApproved(pool,async()=>{sends++;return {state:'done'};},undefined,{owner:'inngest',epoch:1});assert.equal(sends,0);
    const group=await ingest(pool,{...input,key:'action:group-approval',payload:{...update(-20,123),message:{...update(-20,123).message,text:'/approve '+action.id}}});
    assert.match((await controlReply(pool,policy,group.id))!,/Only the owner/);
    assert.equal((await pool.query('SELECT state FROM action_requests')).rows[0].state,'proposed');
    const ownerMessage={...update(123,123,'private'),message:{...update(123,123,'private').message,text:'/approve '+action.id}};
    const historical=await ingest(pool,{...input,key:'action:historical-approval',origin:'import',scope:'123',payload:ownerMessage});
    assert.equal(await controlReply(pool,policy,historical.id),null);
    // A forwarded command is never run, even one the owner forwards from their own earlier message (ADR-0250).
    const forwarded=await ingest(pool,{...input,key:'action:forwarded-approval',scope:'123',payload:{...ownerMessage,message:{...ownerMessage.message,forward_origin:{type:'user',sender_user:{id:123},date:1}}}});
    assert.equal(await controlReply(pool,policy,forwarded.id),'Forwarded commands are ignored. Type it or use the card.');
    assert.equal((await pool.query('SELECT state FROM action_requests')).rows[0].state,'proposed');
    const owner=await ingest(pool,{...input,key:'action:owner-approval',scope:'123',payload:ownerMessage});
    const approved=await controlReply(pool,policy,owner.id);assert.match(approved!,/approved/);
    assert.equal(await controlReply(pool,policy,owner.id),approved);
    await executeApproved(pool,async(path,body)=>{assert.equal(path,'action.execute');assert.deepEqual(body,{id:action.id,destination:'777',text:'Synthetic external message'});sends++;return {state:'done'};},undefined,{owner:'inngest',epoch:1});
    await executeApproved(pool,async()=>{sends++;return {state:'done'};},undefined,{owner:'inngest',epoch:1});assert.equal(sends,1);
    assert.equal(await controlReply(pool,policy,owner.id),approved,'decision replay remains idempotent after delivery');
    assert.equal((await pool.query('SELECT state FROM action_requests')).rows[0].state,'done');
    const uncertain=await requestAction(pool,{scope:'-20',admin:false,turnEvent:source.id},{destination:'777',text:'Another synthetic message'});
    const decision=await ingest(pool,{...input,key:'action:second-approval',scope:'123',payload:{...ownerMessage,message:{...ownerMessage.message,text:'/approve '+uncertain.id}}});
    await controlReply(pool,policy,decision.id);
    let attempts=0;
    await executeApproved(pool,async()=>{attempts++;throw Error('receipt response lost');},undefined,{owner:'inngest',epoch:1});
    await executeApproved(pool,async()=>{attempts++;throw Error('must wait before fetching receipt');},undefined,{owner:'inngest',epoch:1});
    assert.equal(attempts,1);
    await pool.query("UPDATE action_requests SET updated_at=now()-interval '31 seconds' WHERE id=$1",[uncertain.id]);
    await executeApproved(pool,async(_path,body)=>{attempts++;assert.equal((body as {id:string}).id,uncertain.id);return {state:'ambiguous'};},undefined,{owner:'inngest',epoch:1});
    await executeApproved(pool,async()=>{throw Error('ambiguous action must not resend');},undefined,{owner:'inngest',epoch:1});
    assert.equal(attempts,2);
  } finally {await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();}
});

test('real PostgreSQL: voice is archived untranscribed and never blocks dispatch; uncertain RPC reuses receipt identity, history never replies',{skip:!process.env.PGHOST},async()=>{
  const config={...settings(),assistant:{...policy,group_access:{'-20':{granted:['456'],denied:[]}}}};
  const connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:config.databasePassword};
  const admin=new pg.Pool(connection),namespace=`assistant_${Date.now()}`;
  await admin.query(`CREATE SCHEMA ${namespace}`);
  const pool=new pg.Pool({...connection,options:`-c search_path=${namespace}`});
  const root=await mkdtemp(join(tmpdir(),'nocheh-assistant-'));config.dataDir=root;
  const value:Envelope={version:1,key:'telegram:fixture:update:1',origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'-20',source_id:'7',revision:'1',occurred_at:'1700000000',text:null,
    payload:{update_id:1,message:{message_id:7,chat:{id:-20,type:'group'},from:{id:123,is_bot:false},voice:{file_id:'voice1'}}}};
  try {
    await initialize(pool);const event=await ingest(pool,value);let calls=0;
    await dispatchCommitted(pool,config,fixtureBrain(async()=>{calls++;throw Error('not ready');}),undefined,{owner:'inngest',epoch:1});assert.equal(calls,0);
    const audio=Buffer.from('synthetic Ogg bytes');
    await immutableFile(join(root,'files'),digest(audio),audio);
    await pool.query("UPDATE artifacts SET state='ready',file_hash=$1,byte_size=$2",[digest(audio),audio.length]);
    await pool.query('UPDATE dispatches SET next_attempt=now()');
    let firstAttempt=0;
    await prepareArchiveFiles(pool,root,event.id,{owner:'inngest',epoch:1});
    await dispatchCommitted(pool,config,fixtureBrain(async(path,body)=>{
      calls++;
      assert.equal(path,'run.start');assert.equal(body.asynchronous,true);
      const request=body as {attempt:number;archive_credential:string;transcripts:string[]};firstAttempt=request.attempt;
      assert.deepEqual(request.transcripts,[]);
      const claims=JSON.parse(Buffer.from(request.archive_credential.split('.')[1]!,'base64url').toString());assert.equal(claims.scope,'-20');
      assert.equal((await pool.query('SELECT count(*) FROM derived_artifacts')).rows[0].count,'1');
      throw Error('response lost after possible delivery');
    }),undefined,{owner:'inngest',epoch:1});
    assert.equal((await pool.query('SELECT state FROM dispatches')).rows[0].state,'running');
    await pool.query('UPDATE dispatches SET next_attempt=now()');
    await dispatchCommitted(pool,config,fixtureBrain(async(path,body)=>{assert.equal(path,'run.resume');assert.equal((body as {attempt:number}).attempt,firstAttempt);return {state:'done'};}),undefined,{owner:'inngest',epoch:1});
    assert.equal((await pool.query('SELECT content FROM derived_artifacts')).rows[0].content.toString(),'Voice note archived; transcription is not available.');
    assert.equal((await pool.query('SELECT original_text FROM events')).rows[0].original_text,null);
    await ingest(pool,{...value,key:'historical:voice1',origin:'import'});
    await dispatchCommitted(pool,config,fixtureBrain(async()=>{throw Error('history must not dispatch');}),undefined,{owner:'inngest',epoch:1});
    assert.equal((await pool.query('SELECT state FROM dispatches WHERE event_id=$1',[event.id])).rows[0].state,'done');
    assert.equal(calls,1);
    const other={...value,key:'telegram:fixture:update:2',text:'other',payload:update(-20,456)};
    const second=await ingest(pool,other);
    await dispatchCommitted(pool,config,fixtureBrain(async()=>({state:'ambiguous',error_code:'delivery_unconfirmed'})),undefined,{owner:'inngest',epoch:1});
    await dispatchCommitted(pool,config,fixtureBrain(async()=>{throw Error('ambiguous delivery must not resend');}),undefined,{owner:'inngest',epoch:1});
    assert.equal((await pool.query('SELECT state FROM dispatches WHERE event_id=$1',[second.id])).rows[0].state,'ambiguous');
    const ungranted=await ingest(pool,{...other,key:'telegram:fixture:update:ungranted',payload:update(-20,789)});
    await dispatchCommitted(pool,config,fixtureBrain(async()=>{throw Error('a person who is no member must not reach Hermes');}),undefined,{owner:'inngest',epoch:1});
    assert.equal((await pool.query('SELECT state FROM dispatches WHERE event_id=$1',[ungranted.id])).rows[0].state,'suppressed');
    const malformed=await ingest(pool,{...other,key:'telegram:fixture:update:3',payload:update(-30,456)});
    const later=await ingest(pool,{...other,key:'telegram:fixture:update:4'});
    await dispatchCommitted(pool,config,fixtureBrain(async()=>{throw Error('invalid scope must not reach Hermes');}),undefined,{owner:'inngest',epoch:1});
    assert.equal((await pool.query('SELECT error_code FROM dispatches WHERE event_id=$1',[malformed.id])).rows[0].error_code,'invalid_source_message');
    await dispatchCommitted(pool,config,fixtureBrain(async()=>({state:'done'})),undefined,{owner:'inngest',epoch:1});
    assert.equal((await pool.query('SELECT state FROM dispatches WHERE event_id=$1',[later.id])).rows[0].state,'done');
    const quiet=await ingest(pool,{...value,key:'telegram:fixture:quiet-voice',source_id:'quiet-voice',payload:{update_id:9,message:{message_id:9,chat:{id:-20,type:'group'},from:{id:123,is_bot:false},voice:{file_id:'quiet'}}}});
    await pool.query("UPDATE artifacts SET state='ready',file_hash=$2,byte_size=$3 WHERE event_id=$1",[quiet.id,digest(audio),audio.length]);
    assert.deepEqual(await storedTranscripts(pool,quiet.id),[],'a voice note without a reading never holds a reply back');
    assert.equal((await preparationStatus(pool,quiet.id)).stage,'transcription');
    await prepareArchiveFiles(pool,root,quiet.id,{owner:'inngest',epoch:1});
    assert.notEqual((await preparationStatus(pool,quiet.id)).stage,'transcription');
    assert.equal((await pool.query("SELECT kind FROM derived_artifacts WHERE event_id=$1",[quiet.id])).rows[0].kind,'extraction_status');
  } finally {await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();await rm(root,{recursive:true,force:true});}
});

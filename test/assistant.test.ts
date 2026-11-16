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
import {allowedSender,assistantPolicy,conversationScope,groupAccessFor,notesSender,outsideChat,settleTelegramChat,telegramDeliveryAllowed,type AssistantPolicy} from '../src/assistant-policy.js';
import {installChats,installChatsForTest,setChatLoader} from '../src/chats.js';
import {BOB,BOB_CHAT,GP1,GP2,GP_GROUP_IDS,NG1,NG1_TG,NG2,NG2_OLD_TG,NG2_TG,NG_GROUP_IDS,OWNER,UNSERVED,fixtureDirectory,policyDirectory} from './fixture-groups.js';
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

test('group participants need an explicit grant and a deny overrides it',()=>{
  assert.equal(conversationScope(policy,update(-20,456),'-20'),null);
  const granted={...policy,group_access:{'-20':{granted:['456'],denied:[]}}};
  assert.equal(conversationScope(granted,update(-20,456),'-20')?.user_id,'456');
  assert.equal(conversationScope(granted,update(-30,456),'-30'),null);
  const denied={...policy,group_access:{'-20':{granted:['456'],denied:['456']}}};
  assert.equal(conversationScope(denied,update(-20,456),'-20'),null);
  assert.equal(conversationScope(denied,update(-20,123),'-20')?.owner,false);
});

test('a chat is answered by its chat row: digest chats, upgraded groups and access under an old id (ADR-0252)',()=>{
  const restore=installChatsForTest(fixtureDirectory([...GP_GROUP_IDS,...NG_GROUP_IDS]));
  try {
    const served:AssistantPolicy={enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:[...GP_GROUP_IDS,...NG_GROUP_IDS],group_access:{}};
    // A group first seen after step 2b is answered under its Nocheh id, never its Telegram id.
    assert.deepEqual(conversationScope(served,update(Number(NG1_TG),123,'supergroup'),NG1_TG),{owner:false,chat_id:NG1,user_id:'123'});
    assert.deepEqual(conversationScope(served,update(Number(GP1),123,'supergroup'),GP1),{owner:false,chat_id:GP1,user_id:'123'});
    // An upgraded group is one chat under its current and its old Telegram id.
    for(const raw of [NG2_TG,NG2_OLD_TG])assert.equal(conversationScope(served,update(Number(raw),123,'supergroup'),raw)?.chat_id,NG2,raw);
    // Access the owner gave under the group's old id still holds after the upgrade; a deny under either id wins.
    const granted={...served,group_access:{[NG2_OLD_TG]:{granted:[BOB],denied:[]}}};
    assert.deepEqual(groupAccessFor(granted,NG2),{granted:[BOB],denied:[]});
    assert.equal(conversationScope(granted,update(Number(NG2_TG),Number(BOB),'supergroup'),NG2_TG)?.user_id,BOB);
    assert.equal(conversationScope(granted,update(Number(NG1_TG),Number(BOB),'supergroup'),NG1_TG),null,'a grant is for its own group only');
    const denied={...served,group_access:{[NG2_OLD_TG]:{granted:[BOB],denied:[]},[NG2_TG]:{granted:[],denied:[BOB]}}};
    assert.equal(conversationScope(denied,update(Number(NG2_TG),Number(BOB),'supergroup'),NG2_TG),null);
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

test('an allowed sender is the owner or a granted, not denied person in that selected group, in new and edited messages alike',()=>{
  const granted={...policy,group_access:{'-20':{granted:['456'],denied:[]}}};
  const edited=(chat:number,user:number)=>({update_id:2,edited_message:{...update(chat,user).message,edit_date:9}});
  assert.equal(allowedSender(policy,update(123,123,'private'),'123'),true,'the owner in their private chat');
  assert.equal(allowedSender(policy,update(-20,123),'-20'),true,'the owner in a group');
  assert.equal(allowedSender(policy,edited(-20,123),'-20'),true,'the owner\'s edit');
  assert.equal(allowedSender(granted,update(-20,456),'-20'),true,'a granted person');
  assert.equal(allowedSender(granted,edited(-20,456),'-20'),true,'a granted person\'s edit');
  assert.equal(allowedSender(policy,update(-20,456),'-20'),false,'someone not granted');
  assert.equal(allowedSender(granted,update(-30,456),'-30'),false,'granted in another group only');
  assert.equal(allowedSender({...policy,group_access:{'-20':{granted:['456'],denied:['456']}}},update(-20,456),'-20'),false,'a deny wins');
  // A group no longer selected: the directory, which follows TELEGRAM_GROUP_IDS, no longer serves it (ADR-0252).
  const unselected={...granted,group_ids:['-30']},restore=installChatsForTest(policyDirectory(unselected,['-20','456','-99']));
  try{assert.equal(allowedSender(unselected,update(-20,456),'-20'),false,'a group no longer selected');}finally{restore();}
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

test('a reaction\'s sender is who reacted: the owner or a granted person, never a reaction in a chat\'s name or a count',()=>{
  const granted={...policy,group_access:{'-20':{granted:['456'],denied:[]}}};
  const reaction=(chat:number,type:string,who:Record<string,unknown>)=>({update_id:9,message_reaction:{chat:{id:chat,type},message_id:7,date:1,
    old_reaction:[],new_reaction:[{type:'emoji',emoji:'\u{1f44d}'}],...who}});
  assert.equal(allowedSender(policy,reaction(123,'private',{user:{id:123,is_bot:false}}),'123'),true,'the owner in their private chat');
  assert.equal(allowedSender(policy,reaction(-20,'supergroup',{user:{id:123,is_bot:false}}),'-20'),true,'the owner in a group');
  assert.equal(allowedSender(granted,reaction(-20,'supergroup',{user:{id:456,is_bot:false}}),'-20'),true,'a granted person');
  assert.equal(allowedSender(policy,reaction(-20,'supergroup',{user:{id:456,is_bot:false}}),'-20'),false,'someone not granted');
  assert.equal(allowedSender({...policy,group_access:{'-20':{granted:['456'],denied:['456']}}},reaction(-20,'supergroup',{user:{id:456,is_bot:false}}),'-20'),false,'a deny wins');
  assert.equal(allowedSender(policy,reaction(123,'private',{user:{id:456,is_bot:false}}),'123'),false,'a stranger in private');
  assert.equal(allowedSender(policy,reaction(-20,'supergroup',{actor_chat:{id:-20,type:'supergroup'}}),'-20'),false,'a reaction in the group\'s own name, which may be the owner');
  assert.equal(allowedSender(policy,reaction(-20,'supergroup',{user:{id:123,is_bot:false},actor_chat:{id:-20,type:'supergroup'}}),'-20'),false,'a chat\'s name wins over a user');
  assert.equal(allowedSender(policy,reaction(-20,'supergroup',{}),'-20'),false,'no one named');
  assert.equal(allowedSender(policy,reaction(-20,'supergroup',{user:{id:123,is_bot:true}}),'-20'),false,'a bot');
  assert.equal(allowedSender(policy,reaction(-20,'supergroup',{user:{id:123,is_bot:false}}),'-30'),false,'a reaction from another chat');
  assert.equal(allowedSender(policy,{update_id:10,message_reaction_count:{chat:{id:-20,type:'supergroup'},message_id:7,date:1,reactions:[]}},'-20'),false,'counts name no one');
});

test('the owner\'s notes take a Telegram update only from an allowed sender, Nocheh\'s own messages and the web chat always, and nothing else',()=>{
  const granted={...policy,group_access:{'-20':{granted:['456'],denied:[]}}};
  const event=(kind:string,payload:unknown,scope='-20',channel='telegram')=>({channel,kind,scope,payload});
  assert.equal(notesSender(policy,event('telegram_update',update(-20,123))),'review','the owner in a group');
  assert.equal(notesSender(policy,event('telegram_update',update(123,123,'private'),'123')),'review','the owner in their private chat');
  assert.equal(notesSender(granted,event('telegram_update',update(-20,456))),'review','a granted person');
  assert.equal(notesSender(policy,event('telegram_update',update(-20,456))),'sender_not_allowed','someone not granted');
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

test('an allowed sender is judged in the chat the directory finds: digest groups, upgraded groups and access under an old id (ADR-0252)',()=>{
  installChatsForTest(fixtureDirectory([...GP_GROUP_IDS,...NG_GROUP_IDS]));
  try {
    const served:AssistantPolicy={enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:[...GP_GROUP_IDS,...NG_GROUP_IDS],
      group_access:{[GP1]:{granted:[BOB],denied:[]},[NG1_TG]:{granted:[BOB],denied:[]},[NG2_OLD_TG]:{granted:[BOB],denied:[]}}};
    const voice=(chat:string,user:string,type='supergroup')=>({update_id:1,message:{message_id:7,chat:{id:Number(chat),type},from:{id:Number(user),is_bot:false},voice:{file_id:'v1',duration:1200}}});
    // Bob is allowed in an old-shaped group, a digest group, and an upgraded group under its new and its old Telegram id.
    for(const raw of [GP1,NG1_TG,NG2_TG,NG2_OLD_TG])assert.equal(allowedSender(served,voice(raw,BOB),raw),true,raw);
    assert.equal(allowedSender(served,voice(GP2,BOB),GP2),false,'granted in other groups only');
    // A deny under the upgraded group's new id wins over the grant under its old one, wherever the message comes from.
    const denied={...served,group_access:{...served.group_access,[NG2_TG]:{granted:[],denied:[BOB]}}};
    for(const raw of [NG2_TG,NG2_OLD_TG])assert.equal(allowedSender(denied,voice(raw,BOB),raw),false,raw);
    // A group the directory does not serve, or has no row for, allows only the owner (fail closed).
    const stray='-1009999999999',listed={...served,group_ids:[...served.group_ids,UNSERVED,stray],
      group_access:{...served.group_access,[UNSERVED]:{granted:[BOB],denied:[]},[stray]:{granted:[BOB],denied:[]}}};
    assert.equal(allowedSender(listed,voice(UNSERVED,BOB),UNSERVED),false,'a group the directory does not serve');
    assert.equal(allowedSender(listed,voice(stray,BOB),stray),false,'a group with no row');
    assert.equal(allowedSender(listed,voice(stray,OWNER),stray),true,'the owner, wherever they write');
    assert.equal(allowedSender(served,voice(BOB,BOB,'private'),BOB),false,'a member in their own private chat');
    // The directory, which follows TELEGRAM_GROUP_IDS, decides what is served: a digest group it no longer serves.
    installChatsForTest(fixtureDirectory([...GP_GROUP_IDS]));
    assert.equal(allowedSender(served,voice(NG1_TG,BOB),NG1_TG),false,'a digest group no longer served');
    assert.equal(allowedSender(served,voice(GP1,BOB),GP1),true);
    assert.equal(NG1.length,64);assert.equal(NG2.length,64);
  }finally{installChatsForTest(policyDirectory(policy,['456','-99']));}
});

test('the owner listed as a person allowed or denied in a group stops the services from starting',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'nocheh-policy-'));
  try {
    const file=join(folder,'policy.json');
    for(const access of [{'-20':{granted:['123'],denied:[]}},{'-20':{granted:[],denied:['123']}}]) {
      await writeFile(file,JSON.stringify({...policy,group_access:access}));
      assert.throws(()=>assistantPolicy(file),/Invalid TELEGRAM_GROUP_ACCESS/,JSON.stringify(access));
    }
    await writeFile(file,JSON.stringify({...policy,group_access:{'-20':{granted:['456'],denied:[]}}}));
    assert.deepEqual(assistantPolicy(file).group_access,{'-20':{granted:['456'],denied:[]}});
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('final Telegram delivery checks the original sender after grant revocation',()=>{
  const source={origin:'live',channel:'telegram',kind:'telegram_update',scope:'-20',payload:Buffer.from(JSON.stringify(update(-20,456)))};
  const granted={...policy,group_access:{'-20':{granted:['456'],denied:[]}}};
  assert.equal(telegramDeliveryAllowed(granted,{scope:'-20'},source),true);
  assert.equal(telegramDeliveryAllowed(policy,{scope:'-20'},source),false);
  assert.equal(telegramDeliveryAllowed(granted,{scope:null},source),false);
  assert.equal(telegramDeliveryAllowed(granted,{scope:'-20'},{...source,origin:'import'}),false);
  assert.equal(telegramDeliveryAllowed(granted,{scope:'-20'},null),false);
  assert.equal(telegramDeliveryAllowed(granted,{scope:null},{...source,channel:'browser'}),true);
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
    await dispatchCommitted(pool,config,fixtureBrain(async()=>{throw Error('ungranted participant must not reach Hermes');}),undefined,{owner:'inngest',epoch:1});
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

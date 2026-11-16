import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {IncomingMessage} from 'node:http';
import {createHmac} from 'node:crypto';
import {canonical,digest} from '../src/archive.js';
import {appBinding,reader,turnToken} from '../src/access.js';
import {assistantPolicy,ownerChat} from '../src/assistant-policy.js';
import {accountIdFor,chatDirectory,chatIdFor,chatShortId,chatIdListSql,chatIdPattern,chatIdSql,chats,connectionIdFor,conversationFields,installChats,
  installChatsForTest,isChatId,refreshChatsOnEpoch,servedChats,setChatLoader,topicKey,type ChatSnapshot} from '../src/chats.js';
import {isBotAccount,isTelegramAccount,isTelegramChat,legacyChat,parseTelegramLink,telegramTopicId} from '../src/chats-telegram.js';
import {telegramTopicId as spacesTopicId} from '../src/spaces.js';
import {BOB,BOB_CHAT,GP1,GP1_TOPIC,GP1_TOPIC_KEY,GP2,GP4,GP_GROUP_IDS,NG1,NG1_TG,NG1_TOPIC,NG1_TOPIC_KEY,NG2,NG2_OLD_TG,NG2_TG,NG_GROUP_IDS,OWNER,
  UNSERVED,fixtureChats,fixtureDirectory,groupsPolicy,legacyChats,legacyDirectory,policyDirectory} from './fixture-groups.js';

const served=[...GP_GROUP_IDS,...NG_GROUP_IDS];

test('a new chat id is a bot-free digest, stable and distinct per app, external id and topic',()=>{
  const id=chatIdFor('telegram',NG1_TG);
  assert.match(id,/^[a-f0-9]{64}$/);
  assert.equal(id,digest(canonical(['chat','telegram',NG1_TG])),'the formula is digest(canonical([...])) as the archive writes it');
  assert.equal(chatIdFor('telegram',NG1_TG,7),digest(canonical(['chat','telegram',NG1_TG,'topic','7'])));
  assert.equal(chatIdFor('telegram',NG1_TG,7),chatIdFor('telegram',NG1_TG,'7'),'a topic number and its text are one key');
  assert.equal(chatIdFor('telegram',NG1_TG),id,'stable');
  const others=[chatIdFor('telegram',NG2_TG),chatIdFor('telegram',NG1_TG,8),chatIdFor('telegram',NG1_TG,7),chatIdFor('slack',['T0EXAMPLE','C0EXAMPLE1']),
    chatIdFor('slack',['T0OTHER','C0EXAMPLE1'])];
  assert.equal(new Set([id,...others]).size,others.length+1,'distinct per app, team, chat and topic');
  assert.notEqual(chatIdFor('telegram',NG1_TG),NG1_TG,'never the raw id');
  for(const bad of [()=>chatIdFor('telegram',''),()=>chatIdFor('telegram','-1/topic/7'),()=>chatIdFor('telegram',['T0','C0']),
    ()=>chatIdFor('slack','C0EXAMPLE1'),()=>chatIdFor('discord' as never,'1'),()=>chatIdFor('telegram',NG1_TG,0),()=>chatIdFor('telegram',NG1_TG,'a/b'),
    // A Slack thread stays with its channel's messages: it is never a chat of its own.
    ()=>chatIdFor('slack',['T0EXAMPLE','C0EXAMPLE1'],'1700000000.000200')])
    assert.throws(bad,{status:400});
  assert.equal(topicKey(7),'7');assert.equal(topicKey('7'),'7');assert.throws(()=>topicKey(-1),{code:'invalid_topic_key'});
  assert.match(connectionIdFor('telegram'),/^[a-f0-9]{64}$/);assert.notEqual(connectionIdFor('telegram'),connectionIdFor('slack'));
  assert.equal(accountIdFor('telegram',OWNER),digest(canonical(['account','telegram','',OWNER])));
  assert.notEqual(accountIdFor('slack','U0EXAMPLE','T0EXAMPLE'),accountIdFor('slack','U0EXAMPLE','T0OTHER'));
});

test('one shared chat id check accepts digests and the frozen old shapes only',()=>{
  for(const ok of [NG1,GP1,GP1_TOPIC,OWNER,'-4000000000002','123/topic/5'])assert.ok(isChatId(ok),ok);
  for(const bad of ['owner','*','system','desktop:private_supergroup:1','','0','-0','01','-1001/topic/0','-1001/topic/','A'.repeat(64),NG1+'/topic/7',' '+GP1])
    assert.ok(!isChatId(bad),bad);
  assert.equal(chatIdPattern.test(NG1_TOPIC),true);
  assert.equal(chatIdSql('c.id'),String.raw`c.id ~ '^(?:[a-f0-9]{64}|-?[1-9][0-9]{0,18}(?:/topic/[1-9][0-9]{0,15})?)$'`,'the frozen shapes, never widened');
  assert.match(chatIdListSql('read_chats'),/^array_to_string\(read_chats,','\) ~ /);
  assert.throws(()=>chatIdSql('id; DROP TABLE chats'),/invalid_sql_column/);
});

test('only the Telegram adapter reads an old value, once, into what it names',()=>{
  assert.deepEqual(legacyChat(GP1),{id:GP1,kind:'group',external:GP1,topic_key:null,parent_id:null,chat_kind:'group'});
  assert.deepEqual(legacyChat(GP1_TOPIC),{id:GP1_TOPIC,kind:'topic',external:GP1,topic_key:'7',parent_id:GP1,chat_kind:'group'});
  assert.deepEqual(legacyChat(OWNER),{id:OWNER,kind:'private',external:OWNER,topic_key:null,parent_id:null,chat_kind:'private'});
  assert.equal(legacyChat('123/topic/5')?.chat_kind,'private','a topic of a private chat is private');
  for(const none of ['owner','*','system','desktop:private_supergroup:1',NG1,NG1_TOPIC,'',undefined,42])assert.equal(legacyChat(none),null,String(none));
  assert.deepEqual(parseTelegramLink('https://t.me/c/1000000001/7'),{external:'-1001000000001',parts:['7']});
  assert.deepEqual(parseTelegramLink('t.me/c/1000000001/7/99/'),{external:'-1001000000001',parts:['7','99']});
  for(const bad of ['https://t.me/nocheh_group/7','https://t.me/c/0/7','https://example.com/c/1/2',7])assert.equal(parseTelegramLink(bad),null);
  assert.ok(isTelegramChat(GP1)&&isTelegramChat(OWNER)&&!isTelegramChat(NG1)&&!isTelegramChat(GP1_TOPIC));
  assert.ok(isTelegramAccount(OWNER)&&!isTelegramAccount(GP1));
  // The bot an update came to is told by equality with the account the archive stored for it, and only a bot account is.
  const bot={id:9001,is_bot:true,first_name:'Nocheh'};
  assert.ok(isBotAccount(bot,'9001')&&isBotAccount({...bot,id:'9001'},'9001'));
  for(const [user,id] of [[bot,'9002'],[{...bot,is_bot:false},'9001'],[{...bot,is_bot:undefined},'9001'],[bot,'fixture'],[bot,''],[bot,null],[bot,9001],
    [{...bot,id:'09001'},'9001'],[{...bot,id:null},'null'],[null,'9001'],['9001','9001']] as const)assert.equal(isBotAccount(user,id),false,JSON.stringify([user,id]));
  assert.equal(spacesTopicId,telegramTopicId,'spaces.ts still exports the moved helper');
  assert.equal(telegramTopicId({chat:{type:'supergroup',is_forum:true},message_thread_id:7}),7);
  assert.equal(telegramTopicId({chat:{type:'supergroup'},message_thread_id:7}),undefined,'a reply chain is not a topic');
});

test('an id with no row is never a group: every answer fails closed',()=>{
  const directory=fixtureDirectory(served);
  for(const unknown of ['-1001000000077','-1001000000077/topic/7','77',chatIdFor('telegram','-1001000000077'),'owner','*','system','desktop:x',null,undefined,'']) {
    assert.equal(directory.get(unknown),null);assert.equal(directory.kind(unknown),null);
    assert.equal(directory.isGroup(unknown),false,'a Telegram-looking id with no row is private');assert.equal(directory.isPrivate(unknown),true);
    assert.equal(directory.groupOf(unknown),null);assert.equal(directory.parentOf(unknown),null);assert.equal(directory.served(unknown),false);
    assert.equal(directory.isOwner(unknown),false);assert.equal(directory.appIds(unknown),null);assert.deepEqual(directory.topicsOf(unknown),[]);
    if(typeof unknown==='string'){assert.deepEqual(directory.expand([unknown]),[]);assert.deepEqual(directory.rawScopes([unknown]),[]);}
  }
  assert.equal(directory.topicOf(GP1,99),null,'a missing topic row reads nothing');
  assert.equal(directory.resolve('telegram','-1001000000077'),null);assert.equal(directory.resolve('telegram',NG1_TG,99),null);
  const empty=chats();assert.equal(empty.all().length,0,'before anything is installed the process knows no chat');
  assert.equal(empty.isGroup(GP1),false);assert.equal(empty.ownerChat(),null);
});

test('old-shaped and digest chats classify alike, from their rows',()=>{
  const directory=fixtureDirectory(served);
  for(const [group,topic,key] of [[GP1,GP1_TOPIC,GP1_TOPIC_KEY],[NG1,NG1_TOPIC,NG1_TOPIC_KEY]] as const) {
    assert.equal(directory.kind(group),'group');assert.equal(directory.kind(topic),'topic');
    assert.ok(directory.isGroup(group)&&directory.isGroup(topic));assert.ok(!directory.isPrivate(topic));
    assert.equal(directory.groupOf(group),group);assert.equal(directory.groupOf(topic),group);
    assert.equal(directory.parentOf(topic),group);assert.equal(directory.parentOf(group),null);
    assert.deepEqual(directory.topicsOf(group),[topic]);assert.equal(directory.topicOf(group,key),topic);assert.equal(directory.topicOf(group,Number(key)),topic);
    assert.ok(directory.served(group)&&directory.served(topic));
    assert.deepEqual(directory.expand([group]),[group,topic].sort());assert.deepEqual(directory.expand([topic]),[topic]);
    assert.equal(directory.get(topic)?.is_forum,false);assert.equal(directory.get(group)?.is_forum,true);
  }
  for(const [chat,account] of [[OWNER,OWNER],[BOB_CHAT,BOB]] as const) {
    assert.equal(directory.kind(chat),'private');assert.ok(directory.isPrivate(chat));assert.equal(directory.groupOf(chat),null);
    assert.equal(directory.get(chat)?.account_id,accountIdFor('telegram',account));
  }
  assert.equal(directory.ownerChat(),OWNER);assert.ok(directory.isOwner(OWNER));assert.ok(!directory.isOwner(BOB_CHAT));
  assert.ok(directory.served(OWNER),'the owner chat is active');assert.ok(!directory.served(BOB_CHAT),'any other private chat is off');
  assert.ok(!directory.served(UNSERVED)&&directory.isGroup(UNSERVED),'a group Nocheh does not serve is still a group');
  const gpOnly=fixtureDirectory();
  assert.ok(gpOnly.served(GP4)&&!gpOnly.served(NG1)&&!gpOnly.served(NG1_TOPIC),'served follows TELEGRAM_GROUP_IDS (the 2b-1 bridge)');
  assert.equal(chatDirectory(fixtureChats(served)).all().length,directory.all().length);
});

test('a chat expands to all its raw ids, current and old, and the app finds it under each',()=>{
  const directory=fixtureDirectory(served);
  assert.deepEqual(directory.rawScopes([NG2]),[NG2_OLD_TG,NG2_TG].sort(),'an upgraded group reads under both ids');
  assert.deepEqual(directory.rawScopes([NG1_TOPIC]),[NG1_TG],'a topic is read under its group');
  assert.deepEqual(directory.rawScopes([GP1_TOPIC,GP2,OWNER]),[GP1,GP2,OWNER].sort());
  assert.deepEqual(directory.rawScopes([NG2],'slack'),[]);
  assert.deepEqual(directory.appIds(NG2),{app:'telegram',chat:NG2_TG,topic:null,old:[NG2_OLD_TG]},'sends go to the current id');
  assert.deepEqual(directory.appIds(NG1_TOPIC),{app:'telegram',chat:NG1_TG,topic:'7',old:[]});
  assert.deepEqual(directory.appIds(GP1_TOPIC),{app:'telegram',chat:GP1,topic:'7',old:[]});
  assert.equal(directory.resolve('telegram',NG2_OLD_TG),NG2);assert.equal(directory.resolve('telegram',NG2_TG),NG2);
  assert.equal(directory.resolve('telegram',NG1_TG,7),NG1_TOPIC);assert.equal(directory.resolve('telegram',GP1,'7'),GP1_TOPIC);
  assert.equal(directory.resolve('telegram',OWNER),OWNER);assert.equal(directory.resolve('slack',OWNER),null);
  assert.deepEqual(directory.get(NG2)?.app_ids,[{app:'telegram',external:NG2_TG,state:'current'},{app:'telegram',external:NG2_OLD_TG,state:'old'}]);
});

test('a topic\'s group is its row\'s parent, never read from its id',()=>{
  // Rows a parser would get wrong: an old-looking topic id under a different group, and a digest topic under an old group.
  const odd='-1001000000005/topic/7',digestTopic=chatIdFor('telegram','-1001000000006',9);
  const directory=chatDirectory({owner_chat:null,chats:[
    {id:'-1001000000006',app:'telegram',kind:'group',parent_id:null,topic_key:null,state:'active'},
    {id:odd,app:'telegram',kind:'topic',parent_id:'-1001000000006',topic_key:'7',state:'active'},
    {id:digestTopic,app:'telegram',kind:'topic',parent_id:'-1001000000006',topic_key:'9',state:'active'},
    {id:'42',app:'telegram',kind:'private',parent_id:null,topic_key:null,state:'off'},
    {id:'42/topic/3',app:'telegram',kind:'topic',parent_id:'42',topic_key:'3',state:'off'}],
    ids:[{app:'telegram',external_id:'-1001000000006',chat_id:'-1001000000006',state:'current'}]});
  assert.equal(directory.groupOf(odd),'-1001000000006');assert.equal(directory.parentOf(odd),'-1001000000006');
  assert.equal(directory.groupOf(digestTopic),'-1001000000006');
  assert.equal(directory.get('-1001000000005'),null,'the id\'s text names no chat');
  assert.deepEqual(directory.expand(['-1001000000006']),['-1001000000006',digestTopic,odd].sort());
  assert.equal(directory.isGroup('42/topic/3'),false,'a private chat\'s topic is private');assert.equal(directory.groupOf('42/topic/3'),null);
  assert.equal(directory.parentOf('42/topic/3'),'42');
  assert.equal(directory.appIds('42'),null,'a chat with no current app id has nowhere to send');
});

test('a snapshot that breaks the schema\'s rules is never installed',()=>{
  const base=fixtureChats();
  const broken:ChatSnapshot[]=[
    {...base,chats:[...base.chats,{id:'-1001000000055/topic/1',app:'telegram',kind:'topic',parent_id:'-1001000000055',topic_key:'1',state:'active'}]},
    {...base,chats:[...base.chats,{id:'-1001000000056',app:'telegram',kind:'topic',parent_id:null,topic_key:null,state:'active'}]},
    {...base,ids:[...base.ids,{app:'telegram',external_id:'-1001000000057',chat_id:GP1,state:'current'}]},
    {...base,ids:[...base.ids,{app:'telegram',external_id:'-1001000000058',chat_id:GP1_TOPIC,state:'old'}]},
    {...base,ids:[...base.ids,{app:'telegram',external_id:GP1,chat_id:GP2,state:'old'}]},
    {...base,chats:[...base.chats,{id:'owner',app:'telegram',kind:'private',parent_id:null,topic_key:null,state:'off'}]},
    {...base,chats:[...base.chats,{id:chatIdFor('telegram',GP1,7),app:'telegram',kind:'topic',parent_id:GP1,topic_key:'7',state:'active'}]},
  ];
  for(const snapshot of broken)assert.throws(()=>chatDirectory(snapshot),/invalid_chat_directory/);
  assert.equal(chatDirectory({...base,owner_chat:GP1}).ownerChat(),null,'the owner chat must be a private chat row');
});

test('the process directory is installed by its loader and reloads on a newer epoch or a miss',()=>{
  const calls:string[]=[];
  setChatLoader({epoch:epoch=>calls.push('epoch:'+epoch),miss:()=>calls.push('miss')});
  try{
    installChats({...fixtureChats(),epoch:5,revision:2});
    assert.equal(chats().epoch,5);assert.equal(chats().served(GP1),true);
    refreshChatsOnEpoch(5);refreshChatsOnEpoch(4);assert.deepEqual(calls,[],'the snapshot is current');
    refreshChatsOnEpoch(6);assert.deepEqual(calls,['epoch:6']);
    chats().get('-1001000000077');chats().get('owner');chats().resolve('telegram','-1001000000077');
    assert.deepEqual(calls,['epoch:6','miss','miss'],'a chat-looking miss asks the loader; a non-chat value does not');
    const restore=installChatsForTest(legacyDirectory(['-20']));
    assert.equal(chats().served('-20'),false);refreshChatsOnEpoch(9);chats().get('-77');
    assert.deepEqual(calls,['epoch:6','miss','miss'],'a test directory runs with no loader');
    restore();assert.equal(chats().epoch,5);
  }finally{setChatLoader(null);installChats({chats:[],ids:[],owner_chat:null});}
});

test('the dashboard and the Python services get their chat fields from the directory',()=>{
  const directory=fixtureDirectory(served);
  assert.deepEqual(conversationFields(directory,NG1_TOPIC),{kind:'topic',parent_space:NG1,topic_key:'7',
    app_ids:[{app:'telegram',external:NG1_TG,state:'current'}],is_forum:true,state:'active',owner:false,short_id:chatShortId(NG1_TOPIC)});
  assert.deepEqual(conversationFields(directory,OWNER),{kind:'private',parent_space:null,topic_key:null,app_ids:[{app:'telegram',external:OWNER,state:'current'}],
    is_forum:false,state:'active',owner:true,short_id:chatShortId(OWNER)});
  assert.deepEqual(conversationFields(directory,'-1001000000077'),{kind:'unknown',parent_space:null,topic_key:null,app_ids:[],is_forum:null,state:null,owner:false,short_id:chatShortId('-1001000000077')});
  const list=servedChats(fixtureDirectory(),{app:'telegram',external:OWNER});
  assert.equal(list.owner_chat,OWNER);assert.deepEqual(list.owner_account,{app:'telegram',external:OWNER});
  assert.deepEqual(list.chats.map(chat=>chat.id).sort(),[OWNER,GP1,GP1_TOPIC,GP_GROUP_IDS[1],GP_GROUP_IDS[2],GP4].sort(),'served chats and the owner chat only');
  assert.deepEqual(list.chats.find(chat=>chat.id===GP1_TOPIC),{id:GP1_TOPIC,app:'telegram',kind:'topic',parent_id:GP1,topic_key:'7',state:'active',app_ids:[]});
});

test('the owner\'s private chat is separate from the owner\'s account',()=>{
  const saved={...process.env};
  try{
    Object.assign(process.env,{TELEGRAM_ENABLED:'true',TELEGRAM_OWNER_ID:OWNER,TELEGRAM_GROUP_IDS:GP1,TELEGRAM_GROUP_ACCESS:'{}'});
    const policy=assistantPolicy();
    assert.equal(policy.owner_chat,OWNER,'2b-1 seeds the owner chat under the id it always had');assert.equal(ownerChat(policy),OWNER);
    assert.equal(ownerChat({owner_id:OWNER}),OWNER,'a policy from before step 2b');assert.equal(ownerChat({owner_id:OWNER,owner_chat:NG1}),NG1);
    delete process.env.TELEGRAM_OWNER_ID;process.env.TELEGRAM_ENABLED='false';assert.equal(assistantPolicy().owner_chat,null);
  }finally{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);}
  const policy=groupsPolicy();
  assert.equal(policy.owner_chat,OWNER);assert.equal(chats().ownerChat(),OWNER);assert.ok(chats().served(GP1)&&!chats().served(NG1));
  groupsPolicy({group_ids:[...GP_GROUP_IDS,...NG_GROUP_IDS]});assert.ok(chats().served(NG2),'groupsPolicy installs the directory its group_ids serve');
  groupsPolicy({owner_id:'789'});assert.equal(groupsPolicy({owner_id:'789'}).owner_chat,'789');
});

test('legacy fixtures make the rows the seeder would, and match the old-shaped family',()=>{
  const legacy=legacyDirectory([GP1_TOPIC,GP2,'*','owner','system','desktop:x',NG1,'42/topic/3'],{owner:OWNER,served:[GP1]});
  assert.equal(legacy.groupOf(GP1_TOPIC),GP1);assert.ok(legacy.served(GP1_TOPIC)&&!legacy.served(GP2));
  assert.equal(legacy.ownerChat(),OWNER);assert.equal(legacy.kind('42'),'private');assert.equal(legacy.parentOf('42/topic/3'),'42');
  assert.equal(legacy.get(NG1),null,'a digest is not an old value');assert.equal(legacy.get('*'),null);
  const fixture=fixtureDirectory(),same=(id:string)=>({kind:legacy.kind(id),group:legacy.groupOf(id),parent:legacy.parentOf(id)});
  for(const id of [GP1,GP1_TOPIC,GP2,OWNER])assert.deepEqual(same(id),{kind:fixture.kind(id),group:fixture.groupOf(id),parent:fixture.parentOf(id)},id);
  const fromPolicy=policyDirectory(groupsPolicy({group_ids:[GP1,UNSERVED]}),[GP1_TOPIC,'-20']);
  assert.ok(fromPolicy.served(UNSERVED)&&fromPolicy.served(GP1_TOPIC)&&!fromPolicy.served('-20')&&fromPolicy.isGroup('-20'));
  assert.equal(legacyChats([OWNER],{owner:OWNER}).accounts[0]?.external_id,OWNER);
});

test('a turn pass may carry an app binding, checked in shape only',()=>{
  const secret='synthetic-service-token-only-for-tests',now=Date.now(),event=digest('fixture:event');
  const request=(token:string)=>({headers:{authorization:'Bearer '+token}}) as unknown as IncomingMessage;
  // reader() still checks the space against the scope by the old shape until Part C moves that check onto the directory.
  const bound=reader(request(turnToken(secret,GP1,now+60000,event,{space:GP1_TOPIC,revision:1,app:{app:'telegram',chat:GP1,topic:'7'}})),secret,now);
  assert.deepEqual(bound.app,{app:'telegram',chat:GP1,topic:'7'});
  const plain=reader(request(turnToken(secret,GP1,now+60000,event,{space:GP1,revision:1})),secret,now);
  assert.equal(plain.app,undefined,'storage does not require it');
  for(const bad of [{app:'telegram',chat:GP1},{app:'telegram',chat:GP1,topic:7},{app:'discord',chat:GP1,topic:null},{app:'telegram',chat:GP1+'/topic/7',topic:null},
    {app:'telegram',chat:GP1,topic:null,extra:1}])
    assert.throws(()=>reader(request(turnToken(secret,GP1,now+60000,event,{space:GP1,revision:1,app:bad as never})),secret,now),{code:'invalid_scope_token'});
  assert.deepEqual(appBinding({app:'slack',chat:'C0EXAMPLE1',topic:'1700000000.000200'}),{app:'slack',chat:'C0EXAMPLE1',topic:'1700000000.000200'});
  const body=Buffer.from(JSON.stringify({scope:GP1,expires:now+60000,audience:'nocheh-archive',app:{app:'telegram',chat:GP1,topic:null}})).toString('base64url');
  assert.throws(()=>reader(request(`scope.${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`),secret,now),{code:'invalid_scope_token'},
    'only a turn pass carries one');
});

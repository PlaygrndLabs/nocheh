import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {eventSpace,validateOverrides,spacePolicy,saveSpace,recallScope,inRecall,recallCondition,groupSpace,groupSpaces,groupWithTopics,
  servedGroups,servedGroup,parentSpace,readSet,readSetOf,inReadSet,readSetGroups,readSetParam,readSetSql,sourceChat,observedChat,
  archiveScopes} from '../src/spaces.js';
import {chatDirectory,chatIdFor,installChatsForTest,type ChatDirectory} from '../src/chats.js';
import {BOB,BOB_CHAT,GP1,GP1_TOPIC,GP2,GP3,GP4,GP_GROUP_IDS,NG1,NG1_TG,NG1_TOPIC,NG2,NG2_OLD_TG,NG2_TG,NG_GROUP_IDS,OWNER,P1,UNSERVED,
  fixtureChats,fixtureDirectory,legacyDirectory} from './fixture-groups.js';
import {assistantPolicy} from '../src/assistant-policy.js';
import {initialize} from '../src/database.js';
import {ingest,type Envelope} from '../src/archive.js';

/** Runs `body` with `directory` installed as the process's chat directory, then puts the previous one back. */
function withChats<T>(directory:ChatDirectory,body:()=>T):T {
  const restore=installChatsForTest(directory);
  try{return body();}finally{restore();}
}
/** A topic of the old-shaped group GP1 first seen after step 2b: a digest id under an old id. */
const GP1_NEW_TOPIC=chatIdFor('telegram',GP1,'9');
/** Both fixture families served (GP1-GP4, NG1 and NG2), plus GP1_NEW_TOPIC. */
function everything():ChatDirectory {
  const snapshot=fixtureChats([...GP_GROUP_IDS,...NG_GROUP_IDS]);
  return chatDirectory({...snapshot,chats:[...snapshot.chats,{id:GP1_NEW_TOPIC,app:'telegram',kind:'topic',parent_id:GP1,topic_key:'9',state:'active'}]});
}
/** Values that look like Telegram chats but have no chat row, and names that are no chat at all. */
const unknown=['-20','-1009999999999','-1009999999999/topic/7',GP1+'/topic/8',OWNER+'/topic/5','456','789',chatIdFor('telegram','-1003000000003'),
  'desktop:personal_chat:9','desktop:private_supergroup:1234567890','system','owner','*','','-','-0','-12a'];
/** Conversations no read set or SQL id list may ever hold. */
const privateChats=[OWNER,BOB_CHAT,...unknown];

test('the legacy layout\'s event spaces keep the old shape, built by the Telegram adapter',()=>{
  assert.equal(eventSpace('-20',{message:{message_thread_id:42,is_topic_message:true}}),'-20/topic/42');
  assert.equal(eventSpace('-20',{message:{reply_to_message_id:42}}),'-20');
  // A reply chain in an ordinary supergroup carries its first message as message_thread_id; it is not a topic.
  assert.equal(eventSpace('-20',{message:{chat:{id:-20,type:'supergroup'},message_thread_id:42,reply_to_message:{message_id:42}}}),'-20');
  assert.equal(eventSpace('-20',{message:{chat:{id:-20,type:'supergroup',is_forum:true},message_thread_id:42}}),'-20/topic/42');
  // A Desktop export carries the importer's topic only for its own live supergroup.
  const forum={chat:{id:1234567890,type:'private_supergroup'},message:{id:7,reply_to_message_id:3},topic_id:3};
  assert.equal(eventSpace('-1001234567890',forum),'-1001234567890/topic/3');
  assert.equal(eventSpace('desktop:private_supergroup:1234567890',forum),'desktop:private_supergroup:1234567890');
  assert.equal(eventSpace('-1009999999999',forum),'-1009999999999');
  assert.equal(eventSpace('42',forum),'42','an export added to the private chat has no topics');
  assert.equal(eventSpace('-1001234567890',{...forum,chat:{id:1234567890,type:'supergroup'}}),'-1001234567890','a Bot API chat type is not an export');
  assert.equal(eventSpace('-1001234567890',{...forum,topic_id:'3'}),'-1001234567890');
  assert.throws(()=>eventSpace('-20',{message:{message_thread_id:-1,is_topic_message:true}}),{code:'invalid_topic'});
  // A browser original's space must be its chat or one of that chat's topics, as the chat directory holds them.
  withChats(legacyDirectory(['-20/topic/42','-30/topic/42']),()=>{
    assert.equal(eventSpace('-20',{space:'-20/topic/42'},'browser'),'-20/topic/42');
    assert.throws(()=>eventSpace('-20',{space:'-30/topic/42'},'browser'),{code:'source_space_mismatch'});
  });
  withChats(legacyDirectory([]),()=>assert.throws(()=>eventSpace('-20',{space:'-20/topic/42'},'browser'),{code:'source_space_mismatch'},
    'a topic with no row is no topic of the chat'));
  assert.throws(()=>validateOverrides({mode:'public'}),{code:'invalid_memory_mode'});
  assert.throws(()=>validateOverrides({owner:true}),{code:'unknown_space_preference'});
});

test('only a group or one of its topics may share, as the chat directory holds them, in both fixture families',()=>withChats(everything(),()=>{
  for(const space of [GP1,GP1_TOPIC,GP1_NEW_TOPIC,GP2,GP4,UNSERVED,NG1,NG1_TOPIC,NG2])assert.equal(groupSpace(space),true,space);
  // The owner's chat, Bob's chat, and anything with no row fail closed, however Telegram-like it looks (ADR-0242).
  for(const space of [...privateChats,null,undefined])assert.equal(groupSpace(space),false,String(space));
  assert.equal(parentSpace(GP1_TOPIC),GP1);assert.equal(parentSpace(GP1_NEW_TOPIC),GP1,'a digest topic under an old-shaped group');
  assert.equal(parentSpace(NG1_TOPIC),NG1);assert.equal(parentSpace(GP1),null);
  assert.equal(parentSpace('-1009999999999/topic/7'),null,'a parent is never read out of an id');
  // Served follows the directory (the 2b-1 bridge serves it from TELEGRAM_GROUP_IDS), groups only.
  assert.deepEqual(servedGroups(),[GP1,GP2,GP3,GP4,NG1,NG2].sort());
  for(const id of [GP1,NG2])assert.ok(servedGroup(id),id);
  for(const id of [UNSERVED,GP1_TOPIC,NG1_TOPIC,OWNER,BOB_CHAT,'-20'])assert.equal(servedGroup(id),false,id);
}));

test('nothing is a group, served or readable before a directory is installed',()=>withChats(chatDirectory({chats:[],ids:[],owner_chat:null}),()=>{
  for(const space of [GP1,GP1_TOPIC,NG1,OWNER])assert.equal(groupSpace(space),false,space);
  assert.deepEqual([groupSpaces(),servedGroups(),archiveScopes([GP1,NG2]),groupWithTopics(GP1)],[[],[],[],[]]);
  assert.equal(sourceChat({channel:'telegram',scope:GP1}),null);
}));

test('a group\'s topics share one memory unless the owner keeps topics separate, in both families',()=>withChats(everything(),()=>{
  const shared=recallScope(GP1_TOPIC);
  assert.deepEqual(shared,{space:GP1_TOPIC,group:GP1});
  for(const space of [GP1,GP1_TOPIC,GP1_NEW_TOPIC])assert.ok(inRecall(shared,space),space);
  for(const space of [GP2,NG1,NG1_TOPIC,...privateChats])assert.ok(!inRecall(shared,space),space);
  assert.deepEqual(recallScope(NG1_TOPIC),{space:NG1_TOPIC,group:NG1});
  assert.ok(inRecall(recallScope(NG1_TOPIC),NG1)&&!inRecall(recallScope(NG1_TOPIC),GP1));
  const separate=recallScope(GP1_TOPIC,'topic');
  assert.ok(inRecall(separate,GP1_TOPIC));
  for(const space of [GP1,GP1_NEW_TOPIC])assert.ok(!inRecall(separate,space),space);
  assert.equal(recallScope(OWNER).group,null,'a private chat never widens to a group');
  assert.equal(recallScope('-20/topic/42').group,null,'nor does a topic with no row');
  // The group parameter of recallCondition: the group and every topic it has a row for.
  assert.deepEqual(groupWithTopics(GP1),[GP1,GP1_TOPIC,GP1_NEW_TOPIC].sort());
  assert.deepEqual(groupWithTopics(NG1),[NG1,NG1_TOPIC].sort());
  assert.equal(groupWithTopics(null),null);
  for(const id of [OWNER,BOB_CHAT,'-20'])assert.deepEqual(groupWithTopics(id),[],id);
  assert.equal(recallCondition('audience','$1','$2'),'(audience=$1 OR audience=ANY($2::text[]))');
  const saved=process.env.TELEGRAM_TOPIC_MEMORY;
  try {
    delete process.env.TELEGRAM_TOPIC_MEMORY;assert.equal(assistantPolicy().topic_memory,'group');
    process.env.TELEGRAM_TOPIC_MEMORY='topic';assert.equal(assistantPolicy().topic_memory,'topic');
    process.env.TELEGRAM_TOPIC_MEMORY='everything';assert.throws(()=>assistantPolicy(),/Invalid assistant policy/);
  }finally{if(saved===undefined)delete process.env.TELEGRAM_TOPIC_MEMORY;else process.env.TELEGRAM_TOPIC_MEMORY=saved;}
}));

test('a read set equals the recall scope it is made from, for groups and topics in both topic modes and families',()=>withChats(everything(),()=>{
  const probes=[GP1,GP1_TOPIC,GP1_NEW_TOPIC,GP2,GP4,NG1,NG1_TOPIC,NG2,...privateChats];
  for(const mode of ['group','topic'] as const)for(const space of [GP1,GP1_TOPIC,NG1,NG1_TOPIC,NG2]) {
    const scope=recallScope(space,mode),set=readSetOf(scope,P1);
    assert.equal(set.home,space);assert.equal(set.project,P1);
    for(const probe of probes)assert.equal(inReadSet(set,probe),inRecall(scope,probe)&&groupSpace(probe),`${mode} ${space} reads ${probe}`);
  }
  // Group mode reads the whole group; topic mode reads the topic, or the General chat, as itself only.
  assert.deepEqual(readSetOf(recallScope(GP1_TOPIC)),{home:GP1_TOPIC,exact:[],whole:[GP1],project:null});
  assert.deepEqual(readSetOf(recallScope(NG1_TOPIC,'topic')),{home:NG1_TOPIC,exact:[NG1_TOPIC],whole:[],project:null});
  const general=readSetOf(recallScope(GP1,'topic'));
  assert.deepEqual(general,{home:GP1,exact:[GP1],whole:[],project:null});
  assert.ok(inReadSet(general,GP1));assert.ok(!inReadSet(general,GP1_TOPIC),'the General chat alone is not its topics');
  // A private chat's recall scope reads itself through inRecall, but a read set never holds it.
  for(const space of privateChats.filter(Boolean)) {
    const set=readSetOf(recallScope(space));
    assert.deepEqual([set.exact,set.whole],[[],[]],space);assert.equal(inReadSet(set,space),false,space);assert.deepEqual(readSetParam(set),[],space);
  }
}));

test('a read set holds only groups and topics, whatever it is made from',()=>withChats(everything(),()=>{
  const set=readSet({home:GP1,exact:[GP1_TOPIC,NG1_TOPIC,GP3,...privateChats],whole:[GP2,GP1,GP1,NG2,GP1_NEW_TOPIC,...privateChats],project:P1});
  // A whole entry must be a group itself; an exact entry a whole group already covers is dropped; sorted, no repeats.
  assert.deepEqual(set,{home:GP1,exact:[GP3,NG1_TOPIC].sort(),whole:[GP1,GP2,NG2].sort(),project:P1});
  assert.ok(Object.isFrozen(set)&&Object.isFrozen(set.exact)&&Object.isFrozen(set.whole));
  for(const space of [GP1,GP1_TOPIC,GP1_NEW_TOPIC,GP2,GP3,NG1_TOPIC,NG2])assert.equal(inReadSet(set,space),true,space);
  for(const space of [NG1,GP4,...privateChats,null,undefined])assert.equal(inReadSet(set,space),false,String(space));
  assert.deepEqual(readSetParam(set),[GP1,GP1_TOPIC,GP1_NEW_TOPIC,GP2,GP3,NG1_TOPIC,NG2].sort());
  assert.deepEqual(readSetGroups(set),[GP1,GP2,GP3,NG1,NG2].sort());
  // A set built by hand with private chats in it still never reads or binds one.
  const forged={home:OWNER,exact:[OWNER,BOB_CHAT,'desktop:personal_chat:9',GP2],whole:[OWNER,'system','-20',GP1_TOPIC,GP3],project:null};
  for(const space of [OWNER,BOB_CHAT,'desktop:personal_chat:9','system','-20'])assert.equal(inReadSet(forged,space),false,space);
  assert.ok(inReadSet(forged,GP2)&&inReadSet(forged,GP3));assert.equal(inReadSet(forged,GP1_TOPIC),false,'a topic is never a whole group');
  assert.deepEqual(readSetParam(forged),[GP2,GP3]);
  assert.deepEqual(readSetGroups(forged),[GP2,GP3]);
  assert.deepEqual(readSet({home:OWNER}),{home:OWNER,exact:[],whole:[],project:null});
  assert.throws(()=>readSet({home:''}),{code:'invalid_space'});
  assert.throws(()=>readSet({home:GP1,project:'P1'}),{code:'invalid_project_id'});
}));

test('a read set binds as one text array parameter of chat ids that never holds a private chat',()=>withChats(everything(),()=>{
  assert.equal(readSetSql('s.audience',2),'s.audience=ANY($2::text[])');
  assert.equal(readSetSql('s.audience','$7'),'s.audience=ANY($7::text[])');
  for(const param of [0,-1,1.5,'',' '])assert.throws(()=>readSetSql('audience',param),/invalid_read_set_parameter/);
  // The SQL id lists the stores bind: groups and their topics only, never the owner's chat, Bob's chat or an unknown id.
  const lists={groupSpaces:groupSpaces(),servedGroups:servedGroups(),gp1:groupWithTopics(GP1)!,ng1:groupWithTopics(NG1)!,
    param:readSetParam(readSet({home:GP1,exact:privateChats,whole:[...privateChats,GP1,NG1]}))};
  for(const [name,list] of Object.entries(lists)) {
    assert.ok(list.length>0,name);
    for(const id of privateChats)assert.ok(!list.includes(id),`${name} holds ${id}`);
  }
  assert.deepEqual(groupSpaces(),[GP1,GP1_TOPIC,GP1_NEW_TOPIC,GP2,GP3,GP4,UNSERVED,NG1,NG1_TOPIC,NG2].sort());
}));

test('archive reads expand a chat to every Telegram id it has had, current and old',()=>withChats(everything(),()=>{
  // An old-shaped chat is its own Telegram id; a digest chat reads under its Telegram ids, and also its own id (browser).
  assert.deepEqual(archiveScopes([GP1]),[GP1]);
  assert.deepEqual(archiveScopes([GP1_TOPIC,GP1_NEW_TOPIC]),[GP1],'a topic reads as its chat');
  assert.deepEqual(archiveScopes([NG1_TOPIC]),[NG1,NG1_TG].sort());
  assert.deepEqual(archiveScopes([NG2]),[NG2,NG2_OLD_TG,NG2_TG].sort(),'an upgraded group reads its messages from before the upgrade');
  assert.deepEqual(archiveScopes([OWNER,BOB_CHAT]),[BOB_CHAT,BOB,OWNER].sort());
  assert.deepEqual(archiveScopes(unknown),[],'an id with no row reads nothing');
  // An original's chat, by its raw scope through chat_ids, current or old.
  assert.equal(sourceChat({channel:'telegram',scope:NG2_OLD_TG}),NG2);
  assert.equal(sourceChat({channel:'telegram',scope:NG2_TG}),NG2);
  assert.equal(sourceChat({channel:'telegram',scope:NG1_TG}),NG1);
  assert.equal(sourceChat({channel:'telegram',scope:GP1}),GP1);
  assert.equal(sourceChat({channel:'telegram',scope:BOB}),BOB_CHAT);
  for(const scope of ['-1009999999999','-20','system',NG1])assert.equal(sourceChat({channel:'telegram',scope}),null,scope);
  assert.equal(sourceChat({channel:'browser',scope:OWNER}),OWNER);
  assert.equal(sourceChat({channel:'browser',scope:NG1}),NG1);
  assert.equal(sourceChat({channel:'browser',scope:'-20'}),null);
  assert.equal(sourceChat({channel:'import',scope:GP1}),null);
  // An original's observed chat or topic: a topic with no row, or an unknown topic state, reads nothing.
  assert.equal(observedChat('telegram',{chat_id:NG1_TG,topic_state:'known',topic_id:'7'}),NG1_TOPIC);
  assert.equal(observedChat('telegram',{chat_id:GP1,topic_state:'known',topic_id:'7'}),GP1_TOPIC);
  assert.equal(observedChat('telegram',{chat_id:GP1,topic_state:'known',topic_id:'9'}),GP1_NEW_TOPIC);
  assert.equal(observedChat('telegram',{chat_id:NG2_OLD_TG,topic_state:'none'}),NG2);
  assert.equal(observedChat('telegram',{chat_id:GP1,topic_state:'known',topic_id:'8'}),null);
  assert.equal(observedChat('telegram',{chat_id:GP1,topic_state:'unknown'}),null);
  assert.equal(observedChat('telegram',{chat_id:GP1,topic_state:'known'}),null);
  assert.equal(observedChat('telegram',{chat_id:'-20',topic_state:'none'}),null);
  assert.equal(observedChat('browser',{chat_id:GP1,topic_state:'known',topic_id:'7'}),GP1_TOPIC);
  assert.equal(observedChat('browser',{chat_id:GP1_TOPIC,topic_state:'none'}),null,'a browser audience names a chat, never a topic');
  assert.equal(observedChat('import',{chat_id:GP1,topic_state:'none'}),null);
  assert.equal(observedChat('telegram',null),null);
}));

test('the old-shaped family alone keeps every answer it gave before step 2b',()=>withChats(fixtureDirectory(),()=>{
  assert.deepEqual(servedGroups(),[GP1,GP2,GP3,GP4]);
  assert.equal(groupSpace(NG1),true,'an unserved digest group is still a group');assert.equal(servedGroup(NG1),false);
  assert.deepEqual(readSetParam(readSetOf(recallScope(GP1_TOPIC),P1)),[GP1,GP1_TOPIC]);
  assert.deepEqual(archiveScopes([GP1_TOPIC]),[GP1]);
}));

test('real PostgreSQL: topic inheritance, revision conflicts and immutable source backfill',{skip:!process.env.PGHOST},async()=>{
  const admin=new pg.Pool(),namespace=`spaces_${Date.now()}`;await admin.query(`CREATE SCHEMA ${namespace}`);
  const pool=new pg.Pool({options:`-c search_path=${namespace}`}),restore=installChatsForTest(legacyDirectory(['-20/topic/42']));
  try {await initialize(pool);
    const initial=await spacePolicy(pool,'-20');assert.equal(initial.effective.mode,'approved');
    const group=await saveSpace(pool,'-20',{mode:'filtered',sources:['123']},initial.revision);
    const topic=await spacePolicy(pool,'-20/topic/42');assert.equal(topic.effective.mode,'filtered');
    await saveSpace(pool,topic.id,{mode:'isolated'},topic.revision);
    assert.equal((await spacePolicy(pool,topic.id)).effective.mode,'isolated');
    await assert.rejects(saveSpace(pool,'-20',{},group.revision),{code:'space_revision_conflict'});
    const value:Envelope={version:1,key:'space:topic',scope:'-20',bot_id:'fixture',source_id:'7',revision:'1',origin:'import',kind:'telegram_update',occurred_at:null,text:'Original\0',payload:{message:{message_thread_id:42,is_topic_message:true,text:'Original\0'}}};
    const {id}=await ingest(pool,value),before=(await pool.query('SELECT payload,payload_hash FROM events')).rows[0];
    await pool.query('DELETE FROM event_spaces');await initialize(pool);
    assert.equal((await pool.query('SELECT space_id FROM event_spaces WHERE event_id=$1',[id])).rows[0].space_id,topic.id);
    assert.deepEqual((await pool.query('SELECT payload,payload_hash FROM events')).rows[0],before);
  }finally{restore();await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();}
});

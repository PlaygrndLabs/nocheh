import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {eventSpace,validateOverrides,spacePolicy,saveSpace,recallScope,inRecall,recallCondition,groupSpace,groupSpaceSql,groupChatSql,
  readSet,readSetOf,inReadSet,readSetParam,readSetSql} from '../src/spaces.js';
import {GP1,GP1_TOPIC,GP2,GP3,GP4,OWNER,P1} from './fixture-groups.js';
import {assistantPolicy} from '../src/assistant-policy.js';
import {initialize} from '../src/database.js';
import {ingest,type Envelope} from '../src/archive.js';

test('space identity uses explicit topics and rejects ambiguous policy values',()=>{
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
  assert.equal(eventSpace('-20',{space:'-20/topic/42'},'browser'),'-20/topic/42');
  assert.throws(()=>eventSpace('-20',{space:'-30/topic/42'},'browser'),{code:'source_space_mismatch'});
  assert.throws(()=>eventSpace('-20',{message:{message_thread_id:-1,is_topic_message:true}}),{code:'invalid_topic'});
  assert.throws(()=>validateOverrides({mode:'public'}),{code:'invalid_memory_mode'});
  assert.throws(()=>validateOverrides({owner:true}),{code:'unknown_space_preference'});
});
test('only a group or one of its topics may share; everything else counts as private',()=>{
  for(const space of ['-1001000000001','-1001000000001/topic/7','-20'])assert.equal(groupSpace(space),true,space);
  // The owner's chat and its topics, other private chats, desktop imports, system and an unknown conversation fail closed.
  for(const space of ['123','123/topic/5','456','desktop:personal_chat:9','desktop:private_supergroup:1234567890','system','','-','-12a',null,undefined])
    assert.equal(groupSpace(space),false,String(space));
  // Nor does an ID Telegram never gives a group, or a topic that is not one, as the SQL test of a project's chats decides.
  for(const space of ['-0','-0123','-0123/topic/7','-12345678901234567890','-20/topic/0','-20/topic/abc','-20/topic/7/topic/8'])
    assert.equal(groupSpace(space),false,space);
  assert.equal(groupSpaceSql('a.space_id'),"a.space_id ~ '^-[1-9][0-9]{0,18}(/topic/[1-9][0-9]{0,15})?$'");
});
test('a group\'s topics share one memory unless the owner keeps topics separate',()=>{
  const shared=recallScope('-20/topic/42');
  assert.deepEqual(shared,{space:'-20/topic/42',group:'-20'});
  for(const space of ['-20','-20/topic/42','-20/topic/7'])assert.ok(inRecall(shared,space),space);
  for(const space of ['-200','-200/topic/42','123'])assert.ok(!inRecall(shared,space),space);
  const separate=recallScope('-20/topic/42','topic');
  assert.ok(inRecall(separate,'-20/topic/42'));
  for(const space of ['-20','-20/topic/7'])assert.ok(!inRecall(separate,space),space);
  assert.equal(recallScope('123').group,null,'a private chat never widens to a group');
  assert.equal(recallCondition('audience','$1','$2'),"(audience=$1 OR ($2::text IS NOT NULL AND (audience=$2 OR starts_with(audience,$2||'/topic/'))))");
  const saved=process.env.TELEGRAM_TOPIC_MEMORY;
  try {
    delete process.env.TELEGRAM_TOPIC_MEMORY;assert.equal(assistantPolicy().topic_memory,'group');
    process.env.TELEGRAM_TOPIC_MEMORY='topic';assert.equal(assistantPolicy().topic_memory,'topic');
    process.env.TELEGRAM_TOPIC_MEMORY='everything';assert.throws(()=>assistantPolicy(),/Invalid assistant policy/);
  }finally{if(saved===undefined)delete process.env.TELEGRAM_TOPIC_MEMORY;else process.env.TELEGRAM_TOPIC_MEMORY=saved;}
});
// Conversations no read set may ever hold: the owner's chat and its topics, another private chat, desktop imports,
// system, malformed IDs and an unknown conversation.
const privateSpaces=[OWNER,OWNER+'/topic/5','456','desktop:personal_chat:9','desktop:private_supergroup:1234567890','system','','-','-0','-12a','-20/topic/0'];
test('a read set equals the recall scope it is made from, for groups and topics in both topic modes',()=>{
  const probes=[GP1,GP1_TOPIC,GP1+'/topic/8',GP2,GP2+'/topic/7',GP4,...privateSpaces];
  for(const mode of ['group','topic'] as const)for(const space of [GP1,GP1_TOPIC]) {
    const scope=recallScope(space,mode),set=readSetOf(scope,P1);
    assert.equal(set.home,space);assert.equal(set.project,P1);
    for(const probe of probes)assert.equal(inReadSet(set,probe),inRecall(scope,probe)&&groupSpace(probe),`${mode} ${space} reads ${probe}`);
  }
  // Group mode reads the whole group; topic mode reads the topic, or the General chat, as itself only.
  assert.deepEqual(readSetOf(recallScope(GP1_TOPIC)),{home:GP1_TOPIC,exact:[],whole:[GP1],project:null});
  assert.deepEqual(readSetOf(recallScope(GP1_TOPIC,'topic')),{home:GP1_TOPIC,exact:[GP1_TOPIC],whole:[],project:null});
  const general=readSetOf(recallScope(GP1,'topic'));
  assert.deepEqual(general,{home:GP1,exact:[GP1],whole:[],project:null});
  assert.ok(inReadSet(general,GP1));assert.ok(!inReadSet(general,GP1_TOPIC),'the General chat alone is not its topics');
  // A private chat's recall scope reads itself through inRecall, but a read set never holds it.
  for(const space of [OWNER,OWNER+'/topic/5','456','desktop:personal_chat:9','system']) {
    const set=readSetOf(recallScope(space));
    assert.deepEqual([set.exact,set.whole],[[],[]],space);assert.equal(inReadSet(set,space),false,space);assert.deepEqual(readSetParam(set),[],space);
  }
});
test('a read set holds only groups and topics, whatever it is made from',()=>{
  const set=readSet({home:GP1,exact:[GP1_TOPIC,GP2+'/topic/7',GP3,...privateSpaces],whole:[GP2,GP1,GP1,GP3+'/topic/9',...privateSpaces],project:P1});
  // A whole entry must be a group itself; an exact entry a whole group already covers is dropped; sorted, no repeats.
  assert.deepEqual(set,{home:GP1,exact:[GP3],whole:[GP1,GP2],project:P1});
  assert.ok(Object.isFrozen(set)&&Object.isFrozen(set.exact)&&Object.isFrozen(set.whole));
  for(const space of [GP1,GP1_TOPIC,GP1+'/topic/8',GP2,GP2+'/topic/7',GP3])assert.equal(inReadSet(set,space),true,space);
  for(const space of [GP3+'/topic/9',GP4,GP4+'/topic/1',...privateSpaces,null,undefined])assert.equal(inReadSet(set,space),false,String(space));
  assert.deepEqual(readSetParam(set),[GP3,GP1+'/*',GP2+'/*']);
  // A set built by hand with private chats in it still never reads or binds one.
  const forged={home:OWNER,exact:[OWNER,'desktop:personal_chat:9',GP2],whole:[OWNER,'system',GP1+'/topic/7',GP3],project:null};
  for(const space of [OWNER,'desktop:personal_chat:9','system',OWNER+'/topic/1'])assert.equal(inReadSet(forged,space),false,space);
  assert.ok(inReadSet(forged,GP2)&&inReadSet(forged,GP3+'/topic/2'));assert.equal(inReadSet(forged,GP1_TOPIC),false,'a topic is never a whole group');
  assert.deepEqual(readSetParam(forged),[GP2,GP3+'/*']);
  assert.deepEqual(readSet({home:OWNER}),{home:OWNER,exact:[],whole:[],project:null});
  assert.throws(()=>readSet({home:''}),{code:'invalid_space'});
  assert.throws(()=>readSet({home:GP1,project:'P1'}),{code:'invalid_project_id'});
});
test('a read set binds as one text array parameter that never matches a private chat',()=>{
  const guard="s.audience ~ '^-[1-9][0-9]{0,18}(/topic/[1-9][0-9]{0,15})?$'";
  assert.equal(readSetSql('s.audience',2),`(${guard} AND (s.audience=ANY($2::text[]) OR split_part(s.audience,'/topic/',1)||'/*'=ANY($2::text[])))`);
  assert.equal(readSetSql('s.audience','$7'),`(${guard} AND (s.audience=ANY($7::text[]) OR split_part(s.audience,'/topic/',1)||'/*'=ANY($7::text[])))`);
  for(const param of [0,-1,1.5,'',' '])assert.throws(()=>readSetSql('audience',param),/invalid_read_set_parameter/);
  assert.equal(groupChatSql('a.space_id'),"a.space_id ~ '^-[1-9][0-9]{0,18}$'");
});
test('real PostgreSQL: topic inheritance, revision conflicts and immutable source backfill',{skip:!process.env.PGHOST},async()=>{
  const admin=new pg.Pool(),namespace=`spaces_${Date.now()}`;await admin.query(`CREATE SCHEMA ${namespace}`);
  const pool=new pg.Pool({options:`-c search_path=${namespace}`});
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
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();}
});

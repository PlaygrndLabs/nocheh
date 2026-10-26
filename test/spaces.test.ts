import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {eventSpace,validateOverrides,spacePolicy,saveSpace,recallScope,inRecall,recallCondition} from '../src/spaces.js';
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

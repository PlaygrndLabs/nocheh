import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {eventSpace,validateOverrides,spacePolicy,saveSpace} from '../src/spaces.js';
import {initialize} from '../src/database.js';
import {ingest,type Envelope} from '../src/archive.js';

test('space identity uses explicit topics and rejects ambiguous policy values',()=>{
  assert.equal(eventSpace('-20',{message:{message_thread_id:42}}),'-20/topic/42');
  assert.equal(eventSpace('-20',{message:{reply_to_message_id:42}}),'-20');
  assert.equal(eventSpace('-20',{space:'-20/topic/42'},'browser'),'-20/topic/42');
  assert.throws(()=>eventSpace('-20',{space:'-30/topic/42'},'browser'),{code:'source_space_mismatch'});
  assert.throws(()=>eventSpace('-20',{message:{message_thread_id:-1}}),{code:'invalid_topic'});
  assert.throws(()=>validateOverrides({mode:'public'}),{code:'invalid_memory_mode'});
  assert.throws(()=>validateOverrides({owner:true}),{code:'unknown_space_preference'});
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
    const value:Envelope={version:1,key:'space:topic',scope:'-20',bot_id:'fixture',source_id:'7',revision:'1',origin:'import',kind:'telegram_update',occurred_at:null,text:'Original\0',payload:{message:{message_thread_id:42,text:'Original\0'}}};
    const {id}=await ingest(pool,value),before=(await pool.query('SELECT payload,payload_hash FROM events')).rows[0];
    await pool.query('DELETE FROM event_spaces');await initialize(pool);
    assert.equal((await pool.query('SELECT space_id FROM event_spaces WHERE event_id=$1',[id])).rows[0].space_id,topic.id);
    assert.deepEqual((await pool.query('SELECT payload,payload_hash FROM events')).rows[0],before);
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();}
});

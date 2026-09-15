import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {initialize} from '../src/database.js';
import {ingest} from '../src/archive.js';
import {setGuardMode,guardState} from '../src/guarded.js';
import {requestPreparation} from '../src/workflows/preparation-request.js';
import {pipelineOperations} from '../src/workflows/pipeline.js';
import {pauseFamily,switchFamily} from '../src/workflows/store.js';
import {settings} from '../src/config.js';
import {spacePolicy} from '../src/spaces.js';
import {shareKnowledge,sharedContext} from '../src/sharing.js';
import type {Reader} from '../src/access.js';

test('preparation admission never bypasses Inngest; guarding resumes with a new generation and shared reads wait for saved results',{skip:!process.env.PGHOST},async()=>{
  const admin=new pg.Pool(),schema='preparation_admission_'+Date.now();await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({options:`-c search_path=${schema}`});
  try {
    await initialize(pool);await pauseFamily(pool,'preparation',1);const epoch=await switchFamily(pool,'preparation',1,'inngest');
    const source=await ingest(pool,{version:1,key:schema,origin:'import',kind:'message',scope:'123',bot_id:'fixture',source_id:'1',revision:'1',occurred_at:null,text:'Protected owner fact',payload:{}});
    const first=await requestPreparation(pool,source.id);
    await pool.query("UPDATE workflow_registry SET state='completed' WHERE id=$1",[first]);
    assert.equal(await requestPreparation(pool,source.id),first);
    await setGuardMode(pool,'on');
    const second=await requestPreparation(pool,source.id);assert.notEqual(second,first);
    assert.equal((await pool.query('SELECT state FROM workflow_registry WHERE id=$1',[first])).rows[0].state,'completed');
    assert.equal(await requestPreparation(pool,source.id),second);
    assert.equal((await pool.query("SELECT attempts FROM guard_sources WHERE event_id=$1",[source.id])).rows[0].attempts,0);
    await assert.rejects(requestPreparation(pool,'f'.repeat(64)),{code:'source_not_found'});

    let policy=await spacePolicy(pool,'-20');
    await shareKnowledge(pool,{destination:'-20',content:'Shared password: mango123',source_ids:[source.id],revision:policy.revision});
    policy=await spacePolicy(pool,'-20');
    const reader:Reader={scope:'-20',space:'-20',admin:false,revision:policy.revision,guard_epoch:(await guardState(pool)).epoch};
    let calls=0;
    const runtime=async()=>{calls++;throw Error('a read must not run preparation');};
    assert.equal((await sharedContext(pool,reader,'Shared',runtime)).sources.length,0);assert.equal(calls,0);
    const event=(await pool.query("SELECT id FROM events WHERE kind='shared_knowledge'")).rows[0].id;
    const operation=pipelineOperations(pool,settings(),async(op)=>{assert.equal(op,'guard.detect');return {literals:['mango123']};}).preparation!;
    assert.equal((await operation(event,{owner:'inngest',epoch:epoch-1})).state,'waiting');
    assert.equal((await sharedContext(pool,reader,'Shared',runtime)).sources.length,0);
    assert.equal((await operation(event,{owner:'inngest',epoch})).state,'completed');
    assert.equal((await sharedContext(pool,reader,'Shared',runtime)).sources[0]?.text,'Shared password: ***');
    assert.equal(calls,0);

    // An in-flight transcript keeps a recovery lease several minutes ahead.
    // A dependent turn must observe completion without sleeping that lease.
    const voice=await ingest(pool,{version:1,key:schema+':voice',origin:'live',kind:'telegram_update',scope:'123',bot_id:'fixture',source_id:'2',revision:'1',occurred_at:null,text:null,
      payload:{message:{message_id:2,chat:{id:123,type:'private'},from:{id:123},voice:{file_id:'fixture-voice'}}}});
    const artifact=(await pool.query('UPDATE artifacts SET state=\'ready\',file_hash=$2 WHERE event_id=$1 RETURNING id',[voice.id,'b'.repeat(64)])).rows[0].id;
    await pool.query("INSERT INTO transcription_jobs(artifact_id,state,next_attempt) VALUES($1,'running',now()+interval '5 minutes')",[artifact]);
    const telegram=pipelineOperations(pool,{...settings(),assistant:{enabled:true,owner_id:'123',group_ids:[]}},runtime).telegram!;
    const started=Date.now(),waiting=await telegram(voice.id,{owner:'inngest',epoch});
    assert.equal(waiting.stage,'transcription');assert.equal(waiting.waiting_reason,'prerequisite');
    assert.ok(waiting.next_attempt-started<10000);
    assert.ok((await pool.query('SELECT next_attempt FROM transcription_jobs WHERE artifact_id=$1',[artifact])).rows[0].next_attempt.getTime()>Date.now()+240000);
    assert.equal(calls,0);
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});

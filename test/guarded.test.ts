import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {initialize} from '../src/database.js';
import {ingest,digest,type Envelope} from '../src/archive.js';
import {guardedValue,prepareGuarded} from '../src/guarded.js';

test('PostgreSQL guarded projections preserve originals, survive retries/restarts, and never authorize learning',{skip:!process.env.PGHOST},async()=>{
  const connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD};
  const admin=new pg.Pool(connection),namespace=`projections_${Date.now()}`;
  await admin.query(`CREATE SCHEMA ${namespace}`);
  let pool=new pg.Pool({...connection,options:`-c search_path=${namespace}`});
  const original='Aws password: planted-SECRET\r\n😃  \0 unchanged';
  const event:Envelope={version:1,key:'guard-fixture',origin:'import',bot_id:'fixture',scope:'1',source_id:'1',revision:'1',kind:'message',occurred_at:null,text:original,payload:{password:'planted-SECRET',text:original}};
  try {
    await initialize(pool);const {id}=await ingest(pool,event,false);
    await assert.rejects(guardedValue(pool,'events:'+id),{code:'guard_preparation_pending'});
    let calls=0;
    const detect=async(text:string)=>{calls++;return text.includes('planted-SECRET')?['planted-SECRET']:[];};
    await Promise.all([prepareGuarded(pool,detect),prepareGuarded(pool,detect)]);
    assert.equal(calls,1,'the detector sees labels/values together once, despite duplicate fields and workers');
    const guarded=await guardedValue(pool,'events:'+id);
    assert.equal(guarded.value.text,original.replace('planted-SECRET','***'));
    assert.equal(guarded.value.payload.password,'***');
    assert.equal((await pool.query('SELECT original_text FROM events WHERE id=$1',[id])).rows[0].original_text.toString(),original);
    assert.equal((await pool.query('SELECT count(*) FROM memory_learning_sources')).rows[0].count,'0');
    await pool.end();pool=new pg.Pool({...connection,options:`-c search_path=${namespace}`});
    await initialize(pool);await ingest(pool,event,false);await prepareGuarded(pool,detect);
    assert.equal(calls,1,'initialization and duplicate imports do not repeat persisted work');
    await pool.query("INSERT INTO derived_artifacts(id,event_id,kind,content,provenance) VALUES('transcript',$1,'transcript',$2,'{}')",[id,Buffer.from('Voice password: planted-SECRET')]);
    await prepareGuarded(pool,detect);
    assert.equal((await guardedValue(pool,'derived_artifacts:transcript')).value.text,'Voice password: ***');
    const long=Array.from({length:5},(_,i)=>`${i}:`+'a'.repeat(23997)).join('');
    const second=await ingest(pool,{...event,key:'long',text:long,payload:{}},false);
    const completed:string[]=[];let attempts=0;
    await prepareGuarded(pool,async text=>{attempts++;if(attempts===2)throw new Error('synthetic outage with private body');completed.push(text);return [];});
    await assert.rejects(guardedValue(pool,'events:'+second.id),{code:'guard_preparation_pending'});
    const failed=(await pool.query('SELECT state,error_code FROM guard_sources WHERE id=$1',['events:'+second.id])).rows[0];
    assert.deepEqual(failed,{state:'failed',error_code:'guard_preparation_unavailable'});
    await pool.query('UPDATE guard_sources SET next_attempt=now()');
    await prepareGuarded(pool,async text=>{assert.ok(!completed.includes(text),'completed chunks are reused after partial failure');return [];});
    assert.equal((await guardedValue(pool,'events:'+second.id)).value.text,long);
    assert.equal((await pool.query('SELECT original_text FROM events WHERE id=$1',[digest('long')])).rows[0].original_text.toString(),long);
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();}
});

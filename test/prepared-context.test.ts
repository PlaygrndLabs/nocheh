import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {initialize} from '../src/database.js';
import {ingest,type Envelope} from '../src/archive.js';
import {guardState,setGuardMode,prepareGuarded,guardedValue,editGuarded} from '../src/guarded.js';
import {prepareContext,allowPrepared,segments} from '../src/prepared-context.js';
import {readEvent,readArtifact,search} from '../src/retrieval.js';
import {assertAudience} from '../src/access.js';
import {captureInput,claimRun,finishRun,renewRun} from '../src/managed-runs.js';
import {prepareArchiveFiles} from '../src/preparation.js';
import {settings} from '../src/config.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('prepared passages survive formatting without splitting different identifiers',()=>{
  assert.deepEqual(segments('Before\nowner text\nAfter',['owner text']),[{text:'Before\n',prepared:false},{text:'owner text',prepared:true},{text:'\nAfter',prepared:false}]);
  assert.deepEqual(segments('secret-value',['secret']),[{text:'secret',prepared:true},{text:'-value',prepared:false}]);
  assert.deepEqual(segments('mysecretvalue',['secret']),[{text:'mysecretvalue',prepared:false}]);
});

test('ingestion prepares text files and transcripts once, retains binaries and fences late delivery',{skip:!process.env.PGHOST},async()=>{
  const admin=new pg.Pool(),namespace=`files_${Date.now()}`,root=await mkdtemp(join(tmpdir(),'guard-files-'));
  await admin.query(`CREATE SCHEMA ${namespace}`);const pool=new pg.Pool({options:`-c search_path=${namespace}`});
  const config=settings();config.dataDir=root;config.assistant={enabled:false,owner_id:'42',group_ids:[]};
  try {
    await initialize(pool);await setGuardMode(pool,'on');
    const original=Buffer.from('Database password: planted-SECRET\r\n');
    const captured=await captureInput(pool,config,{id:'files',conversation:'files',profile:'owner',scope:'42',text:'Read my files',files:[
      {name:'notes.txt',kind:'file',bytes_base64:original.toString('base64')},
      {name:'voice.wav',kind:'audio',bytes_base64:Buffer.from([0,1,2,3]).toString('base64')},
      {name:'photo.png',kind:'image',bytes_base64:Buffer.from([0,4,5,6]).toString('base64')}]});
    let transcriptions=0;const call=async(operation:string)=>{assert.equal(operation,'perception.transcribe');transcriptions++;return {success:true,transcript:'Voice password: planted-SECRET'};};
    await prepareArchiveFiles(pool,root,call);await prepareArchiveFiles(pool,root,call);assert.equal(transcriptions,1);
    assert.deepEqual(await readFile(join(root,'files',captured.attachments[0]!.sha256)),original);
    const kinds=(await pool.query('SELECT kind FROM derived_artifacts WHERE event_id=$1',[captured.event_id])).rows.map(r=>r.kind).sort();
    assert.deepEqual(kinds,['extracted_text','extraction_status','transcript']);
    await prepareGuarded(pool,async text=>text.includes('planted-SECRET')?['planted-SECRET']:[],undefined,100,captured.event_id);
    const guard=await guardState(pool),principal={admin:false,scope:null,guard_epoch:guard.epoch,turnEvent:captured.event_id};
    const visible=await readEvent(pool,principal,captured.event_id);
    assert.ok(!JSON.stringify(visible).includes('planted-SECRET'));
    const claim={event_id:captured.event_id,actor:'worker',scope:'42',profile:'owner'};
    await claimRun(pool,config,claim);
    await editGuarded(pool,{admin:true,scope:null},captured.event_id,{source_id:'events:'+captured.event_id,expected_revision:1,content:{text:'Owner changed this context',payload:{}}});
    await assert.rejects(renewRun(pool,claim),{code:'run_lease_lost'});
    assert.equal((await finishRun(pool,{...claim,state:'done',text:'Obsolete answer retained as evidence',session:'files'})).state,'interrupted');
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();await rm(root,{recursive:true,force:true});}
});

test('PostgreSQL on/off: prepared source reuse, authoritative edits, generation fencing and private derived context',{skip:!process.env.PGHOST},async()=>{
  const admin=new pg.Pool(),namespace=`context_${Date.now()}`;await admin.query(`CREATE SCHEMA ${namespace}`);
  const pool=new pg.Pool({options:`-c search_path=${namespace}`});
  const event:Envelope={version:1,key:'guard-context-fixture',origin:'import',bot_id:'fixture',scope:'-20',source_id:'message',revision:'1',kind:'message',occurred_at:null,text:'Database password: planted-SECRET',payload:{message:{text:'Database password: planted-SECRET'}}};
  const owner={admin:true,scope:null};
  const detect=async(text:string)=>text.includes('planted-SECRET')?['planted-SECRET']:[];
  try {
    await initialize(pool);const {id}=await ingest(pool,event,false);await prepareGuarded(pool,detect);
    const guard=await setGuardMode(pool,'on');
    const reader={admin:false,scope:null,turnEvent:id,guard_epoch:guard.epoch};
    const group={...reader,scope:'-20'};
    await assert.rejects(readEvent(pool,{admin:false,scope:null},id),{code:'guard_context_changed'});
    const record=await readEvent(pool,reader,id);
    assert.equal(record.event.text,'Database password: ***');assert.ok(!JSON.stringify(record).includes('planted-SECRET'));
    assert.equal((await search(pool,reader,'planted-SECRET')).length,0,'raw search text cannot influence guarded results');
    assert.equal((await search(pool,reader,'Database')).length,1);
    assert.equal((await readEvent(pool,owner,id)).event.text,event.text);
    await assert.rejects(readArtifact(pool,reader,'/unused','a'.repeat(64)),{code:'original_file_requires_owner'});
    let detections:string[]=[];
    const track=async(text:string)=>{detections.push(text);assert.ok(!text.includes('Database password: ***'),'stored guarded data must not be detected again');return detect(text);};
    const payload={input:[{role:'user',content:'Context:\n'+record.event.text+'\nQuestion: what database?'}]};
    await prepareContext(pool,reader,payload,track);const calls=detections.length;
    assert.equal(calls,1,'new fields and residual passages use one bounded detector batch');
    assert.equal(JSON.stringify(await prepareContext(pool,reader,payload,track)),JSON.stringify(payload));assert.equal(detections.length,calls);
    await prepareContext(pool,reader,{input:[{role:'user',content:'Context:\n'+record.event.text+'\nQuestion: a different question?'}]},track);
    assert.ok(detections.length>calls);
    const updated=await editGuarded(pool,owner,id,{source_id:'events:'+id,expected_revision:1,content:{text:'Owner chose to keep planted-SECRET',payload:{}}});
    await assert.rejects(prepareContext(pool,reader,payload,track),{code:'guard_context_changed'});
    const current={...reader,guard_epoch:updated.epoch},currentGroup={...group,guard_epoch:updated.epoch};
    const edited=(await guardedValue(pool,'events:'+id)).value;
    await allowPrepared(pool,current,edited);
    assert.equal(await prepareContext(pool,current,edited.text,async()=>{throw Error('owner edit cannot be remasked');}),edited.text);
    assert.equal(await prepareContext(pool,current,'Private owner context: private-secret',async()=>[]),'Private owner context: private-secret');
    assert.equal((await search(pool,currentGroup,'private-secret')).length,0);
    const visible=await readEvent(pool,currentGroup,id);
    assert.ok(!JSON.stringify(visible).includes('private-secret'));
    const oldEpoch=updated.epoch;const off=await setGuardMode(pool,'off');assert.ok(off.epoch>oldEpoch);
    await assert.rejects(assertAudience(pool,current),{code:'guard_context_changed'});
    assert.equal((await readEvent(pool,{admin:false,scope:null,guard_epoch:off.epoch},id)).event.text,event.text);
    assert.ok((await search(pool,{admin:false,scope:'-20',guard_epoch:off.epoch},'private-secret')).length===0,'private context stays private even with guarding off');
    const on=await setGuardMode(pool,'on');assert.ok(on.epoch>off.epoch);
    assert.equal((await guardedValue(pool,'events:'+id)).value.text,edited.text,'mode switches preserve owner edits');
    assert.equal((await guardState(pool)).mode,'on');
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();}
});

test('context batches preserve all fragments and roll back failed persistence without leaking partial trust',{skip:!process.env.PGHOST},async()=>{
  const admin=new pg.Pool(),namespace=`context_batch_${Date.now()}`;await admin.query(`CREATE SCHEMA ${namespace}`);
  const pool=new pg.Pool({options:`-c search_path=${namespace}`});
  let statements=0,fail=false;
  const query=(client:pg.Pool|pg.PoolClient)=>async(sql:string,...args:unknown[])=>{
    statements++;
    if(fail&&sql.includes('INSERT INTO guard_revisions')){fail=false;throw Error('synthetic persistence failure');}
    return (client.query as Function).call(client,sql,...args);
  };
  const measured={query:query(pool),connect:async()=>{
    const client=await pool.connect();return {query:query(client),release:()=>client.release()};
  }} as unknown as pg.Pool;
  try {
    await initialize(pool);const event=await ingest(pool,{version:1,key:'context-batch',origin:'import',bot_id:'fixture',scope:'42',source_id:'1',revision:'1',kind:'message',occurred_at:null,text:'Synthetic fixture',payload:{}});
    const state=await setGuardMode(pool,'on'),reader={admin:false,scope:null,turnEvent:event.id,guard_epoch:state.epoch};
    const input=Array.from({length:100},(_,i)=>`Fragment ${i}: exact\0 Unicode 😃; planted-SECRET-${i}.\r\n`);
    const detector=async(text:string)=>[...new Set(text.match(/planted-SECRET-\d+/g)??[])];
    fail=true;
    await assert.rejects(prepareContext(measured,reader,input,detector),/synthetic persistence failure/);
    assert.equal((await pool.query("SELECT count(*) FROM derived_artifacts WHERE kind='runtime_context'")).rows[0].count,'0');
    assert.equal((await pool.query('SELECT count(*) FROM guard_context_inputs')).rows[0].count,'0');
    assert.equal((await pool.query('SELECT count(*) FROM guard_context_values')).rows[0].count,'0');
    statements=0;let calls=0;
    const output=await prepareContext(measured,reader,input,async text=>{calls++;return detector(text);});
    assert.deepEqual(output,input.map(text=>text.replace(/planted-SECRET-\d+/g,'***')));
    assert.equal(calls,1);
    assert.ok(statements<30,`100 fragments should use bounded database batches, observed ${statements}`);
    assert.equal((await pool.query("SELECT count(*) FROM derived_artifacts WHERE kind='runtime_context'")).rows[0].count,'100');
    assert.deepEqual(await prepareContext(pool,reader,input,async()=>{throw Error('cached fragments must not repeat detection');}),output);
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();}
});

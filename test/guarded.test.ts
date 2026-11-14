import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {initialize} from '../src/database.js';
import {ingest,digest,type Envelope} from '../src/archive.js';
import {guardedValue,prepareGuarded,editGuarded,guardedHistory,inspectGuarded,inspectRevision,browseData,replaceValues,requestFields,textValues} from '../src/guarded.js';
import {literalSpans,mask,patternSpans} from '../src/guard.js';

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
    await Promise.all([prepareGuarded(pool,detect,undefined,undefined,undefined,{owner:'inngest',epoch:1}),prepareGuarded(pool,detect,undefined,undefined,undefined,{owner:'inngest',epoch:1})]);
    assert.equal(calls,1,'the detector sees labels/values together once, despite duplicate fields and workers');
    const guarded=await guardedValue(pool,'events:'+id);
    assert.equal(guarded.value.text,original.replace('planted-SECRET','***'));
    assert.equal(guarded.value.payload.password,'***');
    assert.equal((await pool.query('SELECT original_text FROM events WHERE id=$1',[id])).rows[0].original_text.toString(),original);
    assert.equal((await pool.query('SELECT count(*) FROM memory_learning_sources')).rows[0].count,'0');
    await pool.end();pool=new pg.Pool({...connection,options:`-c search_path=${namespace}`});
    await initialize(pool);await ingest(pool,event,false);await prepareGuarded(pool,detect,undefined,undefined,undefined,{owner:'inngest',epoch:1});
    assert.equal(calls,1,'initialization and duplicate imports do not repeat persisted work');
    await pool.query("INSERT INTO derived_artifacts(id,event_id,kind,content,provenance) VALUES('transcript',$1,'transcript',$2,'{}')",[id,Buffer.from('Voice password: planted-SECRET')]);
    await prepareGuarded(pool,detect,undefined,undefined,undefined,{owner:'inngest',epoch:1});
    assert.equal((await guardedValue(pool,'derived_artifacts:transcript')).value.text,'Voice password: ***');
    const long=Array.from({length:5},(_,i)=>`${i}:`+'a'.repeat(23997)).join('');
    const second=await ingest(pool,{...event,key:'long',text:long,payload:{}},false);
    const completed:string[]=[];let attempts=0;
    await prepareGuarded(pool,async text=>{attempts++;if(attempts===2)throw new Error('synthetic outage with private body');completed.push(text);return [];},undefined,undefined,undefined,{owner:'inngest',epoch:1});
    await assert.rejects(guardedValue(pool,'events:'+second.id),{code:'guard_preparation_pending'});
    const failed=(await pool.query('SELECT state,error_code FROM guard_sources WHERE id=$1',['events:'+second.id])).rows[0];
    assert.deepEqual(failed,{state:'failed',error_code:'guard_preparation_unavailable'});
    await pool.query('UPDATE guard_sources SET next_attempt=now()');
    await prepareGuarded(pool,async text=>{assert.ok(!completed.includes(text),'completed chunks are reused after partial failure');return [];},undefined,undefined,undefined,{owner:'inngest',epoch:1});
    assert.equal((await guardedValue(pool,'events:'+second.id)).value.text,long);
    assert.equal((await pool.query('SELECT original_text FROM events WHERE id=$1',[digest('long')])).rows[0].original_text.toString(),long);
    const owner={admin:true,scope:null},agent={admin:false,scope:null},sourceId='events:'+id;
    assert.equal((await browseData(pool,owner)).records.length,2);
    for(const operation of [()=>inspectGuarded(pool,agent,id),()=>guardedHistory(pool,agent,id,sourceId),()=>editGuarded(pool,agent,id,{})])await assert.rejects(operation(),{code:'owner_required'});
    const replacement={text:'I deliberately retained planted-SECRET',payload:{text:'owner wording'}};
    const edited=await editGuarded(pool,owner,id,{source_id:sourceId,expected_revision:1,content:replacement});
    assert.equal(edited.revision,2);
    assert.deepEqual((await guardedValue(pool,sourceId)).value,replacement,'owner text is not re-masked');
    await assert.rejects(editGuarded(pool,owner,id,{source_id:sourceId,expected_revision:1,content:replacement}),{code:'guard_revision_conflict'});
    assert.equal((await guardedHistory(pool,owner,id,sourceId)).revisions.length,2);
    assert.equal((await inspectRevision(pool,owner,id,sourceId,1)).content.text,original.replace('planted-SECRET','***'));
    await editGuarded(pool,owner,id,{source_id:sourceId,expected_revision:2,restore_revision:1});
    assert.equal((await guardedValue(pool,sourceId)).revision,3);
    assert.equal((await pool.query('SELECT count(*) FROM guard_invalidations')).rows[0].count,'2');
    assert.equal((await pool.query('SELECT original_text FROM events WHERE id=$1',[id])).rows[0].original_text.toString(),original);
    const racing=await ingest(pool,{...event,key:'racing',text:'new guarded copy',payload:{}},false);
    let started!:()=>void,resume!:()=>void;
    const begun=new Promise<void>(r=>{started=r;}),hold=new Promise<void>(r=>{resume=r;});
    const work=prepareGuarded(pool,async()=>{started();await hold;return [];},undefined,undefined,undefined,{owner:'inngest',epoch:1});
    await begun;
    try {
      await prepareGuarded(pool,async()=>{throw new Error('an in-flight source must not be detected twice');},undefined,100,racing.id,{owner:'inngest',epoch:1});
      const independent=await ingest(pool,{...event,key:'independent',text:'Current live content',payload:{}},false);
      await prepareGuarded(pool,async()=>[],undefined,100,independent.id,{owner:'inngest',epoch:1});
      assert.equal((await guardedValue(pool,'events:'+independent.id)).value.text,'Current live content','targeted live preparation proceeds while another source is backfilling');
    }catch(error){resume();await work;throw error;}
    await editGuarded(pool,owner,racing.id,{source_id:'events:'+racing.id,expected_revision:null,content:{text:'owner wins',payload:{}}});
    resume();await work;
    assert.equal((await guardedValue(pool,'events:'+racing.id)).value.text,'owner wins');
    await prepareGuarded(pool,async()=>{throw new Error('must not reprocess');},undefined,undefined,undefined,{owner:'inngest',epoch:1});
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();}
});

test('a secret check finding never masks structure: keys, and roles, types, names, the model and tool ids in a request',()=>{
  // The finding names words of the request's own structure, as a steered check might; fixed patterns still apply everywhere.
  const findings=['role','content','assistant','user','fixture-model','lookup','toolu_fixture1','call_fixture1','call_fixture2'],patterned='sk-'+'A1b2'.repeat(6);
  const guardedCopy=(text:string)=>mask(text,[...literalSpans(text,findings.filter(found=>text.includes(found))),...patternSpans(text)]).text;
  const structure={text:(text:string)=>mask(text,patternSpans(text)).text};
  const payload={model:'fixture-model',messages:[
    {role:'user',content:'Ask the assistant about the role.'},
    {role:'assistant',content:[{type:'tool_use',id:'toolu_fixture1',name:'lookup',input:{name:'assistant',query:'role'}}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:'toolu_fixture1',content:'The assistant role is done.'}]},
    {role:'assistant',tool_calls:[{id:'call_fixture1',type:'function',function:{name:'lookup',arguments:'{"q":"role"}'}}]},
    {role:'tool',tool_call_id:'call_fixture1',content:'role'},
    {type:'function_call',call_id:'call_fixture2',name:'lookup',arguments:'{}'},{type:'function_call_output',call_id:'call_fixture2',output:'role'},
  ],metadata:{[patterned]:'plain'}};
  const replacements=new Map(textValues(payload).map(text=>[text,guardedCopy(text)]));
  assert.throws(()=>replaceValues(payload,replacements),{code:'guarded_key_collision'},'without the structure rule a finding can merge two keys');
  const plain=(value:unknown)=>JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(replaceValues(payload,replacements,{...structure,fields:requestFields})),{model:'fixture-model',messages:[
    {role:'user',content:'Ask the *** about the ***.'},
    {role:'assistant',content:[{type:'tool_use',id:'toolu_fixture1',name:'lookup',input:{name:'***',query:'***'}}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:'toolu_fixture1',content:'The *** *** is done.'}]},
    {role:'assistant',tool_calls:[{id:'call_fixture1',type:'function',function:{name:'lookup',arguments:'{"q":"***"}'}}]},
    {role:'tool',tool_call_id:'call_fixture1',content:'***'},
    {type:'function_call',call_id:'call_fixture2',name:'lookup',arguments:'{}'},{type:'function_call_output',call_id:'call_fixture2',output:'***'},
  ],metadata:{'***':'plain'}},'content and a tool call\'s input stay masked, and a fixed secret pattern in a key is still hidden');
  // Outside a model request only keys are structure: a name or role value is masked as before.
  assert.deepEqual(plain(replaceValues({name:'assistant',role:'user'},replacements,structure)),{name:'***',role:'***'});
  assert.deepEqual(plain(replaceValues({name:'assistant'},replacements)),{name:'***'},'without the structure rule nothing changes');
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {initialize} from '../src/database.js';
import {ingest} from '../src/archive.js';
import {approveLearning} from '../src/learning.js';
import {prepareGuarded,setGuardMode,guardState,editGuarded} from '../src/guarded.js';
import {syncMemory,queueMemory,memoryStatus,setMemoryConnection,acceptMemoryVerification,recallMemory,prepareMemoryRequest,type HonchoCall} from '../src/honcho.js';

test('durable Honcho receipts, consent, isolation, uncertain writes and current-only egress',{skip:!process.env.PGHOST},async()=>{
 const admin=new pg.Pool(),namespace=`honcho_${Date.now()}`;await admin.query(`CREATE SCHEMA ${namespace}`);const pool=new pg.Pool({options:`-c search_path=${namespace}`});
 const detect=async(text:string)=>text.includes('planted-secret')?['planted-secret']:[];
 const remote=new Map<string,any[]>();let writes=0,uncertain=true;const paths:string[]=[];
 const call:HonchoCall=async(path,body)=>{
  paths.push(path);
  if(path.endsWith('/messages/list'))return {items:remote.get(path.replace('/list',''))??[]};
  if(path.endsWith('/messages')) {writes++;const b=body as any;const result=[{...b.messages[0],id:'remote-'+writes}];remote.set(path,result);
   if(uncertain){uncertain=false;throw Error('response lost after remote commit');}return result;}
  if(path.endsWith('/queue/status'))return {pending_work_units:0,in_progress_work_units:0,completed_work_units:1};
  if(path.endsWith('/chat'))return {content:'The saved preference is green tea.'};return body;
 };
 try{
  await initialize(pool);await setGuardMode(pool,'on');
  const first=await ingest(pool,{version:1,key:'memory-a',origin:'import',bot_id:'fixture',scope:'-10',source_id:'a',revision:'1',kind:'message',occurred_at:null,text:'I like green tea. Password: planted-secret',payload:{}},false);
  await ingest(pool,{version:1,key:'memory-b',origin:'import',bot_id:'fixture',scope:'-20',source_id:'b',revision:'1',kind:'message',occurred_at:null,text:'Private other group fact',payload:{}},false);
  await prepareGuarded(pool,detect);await memoryStatus(pool);
  await assert.rejects(setMemoryConnection(pool,{attached:true}),{code:'honcho_live_acceptance_pending'});
  // This report exercises the acceptance interface with a fixture, not a provider pass.
  const verification={format:'nocheh-honcho-live-v1',status:'passed',synthetic_only:true,
   checks:Object.fromEntries(['subscription_reasoning','ingestion','retrieval','embedding_guarded','restart','provider_failure'].map(name=>[name,'passed'])),
   ledger:{reserved_usd:0.01,limit_usd:5}};
  for(const amount of [-1,0,NaN,Infinity,5.01])await assert.rejects(acceptMemoryVerification(pool,{...verification,ledger:{...verification.ledger,reserved_usd:amount}}),{code:'honcho_live_acceptance_pending'});
  await assert.rejects(acceptMemoryVerification(pool,{...verification,checks:{...verification.checks,embedding_guarded:'pending'}}),{code:'honcho_live_acceptance_pending'});
  assert.equal((await memoryStatus(pool)).connection.verified,false);
  await acceptMemoryVerification(pool,verification);await setMemoryConnection(pool,{attached:true,include_history:true});
  await syncMemory(pool,call);assert.equal(writes,0,'preparation does not imply learning consent');
  await approveLearning(pool,{approved:true,event_ids:[first.id]});await syncMemory(pool,call);
  assert.equal(writes,2,'one logical write per owner/group audience');
  assert.ok([...remote.values()].every(rows=>!rows[0].content.includes('planted-secret')));
  assert.ok([...remote.values()].every(rows=>!rows[0].content.includes('other group')));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM honcho_receipts WHERE state='uncertain'")).rows[0].n,1);
  await pool.query('UPDATE honcho_receipts SET next_attempt=now()');await syncMemory(pool,call);await initialize(pool);await syncMemory(pool,call);
  assert.equal(writes,2,'restart reconciles the uncertain committed write without another ingestion');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM honcho_receipts WHERE state='done'")).rows[0].n,2);
  const guard=await guardState(pool),group={admin:false,scope:'-10',space:'-10',revision:1,guard_epoch:guard.epoch,turnEvent:first.id};
  assert.equal((await recallMemory(pool,group,'What tea?',call,detect)).sources.length,1);
  const before=paths.length;
  assert.equal((await recallMemory(pool,{...group,scope:'-20',space:'-20'},'What tea?',call,detect)).sources.length,0);
  assert.equal(paths.length,before,'no Honcho request for an unpopulated unauthorized audience');
  const generation=(await memoryStatus(pool)).generations.find(g=>g.audience==='-10')!;
  let detectorCalls=0;
  const request={workspace:generation.id,route:'/v1/embeddings',payload:{model:'text-embedding-3-small',input:'I like green tea. Password: ***'}};
  const prepared=await prepareMemoryRequest(pool,request,async text=>{detectorCalls++;return detect(text);});
  assert.equal((prepared.payload as any).input,request.payload.input);
  const calls=detectorCalls;await prepareMemoryRequest(pool,request,async()=>{detectorCalls++;return [];});assert.equal(detectorCalls,calls);
  await assert.rejects(prepareMemoryRequest(pool,{...request,payload:{input:[123,456]}},detect),{code:'opaque_embedding_input'});
  await editGuarded(pool,{admin:true,scope:null},first.id,{source_id:'events:'+first.id,expected_revision:1,content:{text:'I prefer coffee now.',payload:{}}});
  await assert.rejects(prepareMemoryRequest(pool,request,detect),{code:'memory_context_retired'});
  await syncMemory(pool,call);assert.equal(writes,4);
  const current=(await memoryStatus(pool)).generations.find(g=>g.audience==='-10')!;assert.notEqual(current.id,generation.id);
  assert.ok([...remote.entries()].filter(([path])=>path.includes(current.id)).every(([,rows])=>rows[0].content.includes('coffee')&&!rows[0].content.includes('tea')));
  await setMemoryConnection(pool,{attached:false});const detachedWrites=writes;await syncMemory(pool,call);assert.equal(writes,detachedWrites);
  const skipped=await ingest(pool,{version:1,key:'detached-no-catchup',origin:'import',bot_id:'fixture',scope:'-10',source_id:'c',revision:'1',kind:'message',occurred_at:null,text:'While detached without catchup',payload:{}},false);
  await approveLearning(pool,{approved:true,event_ids:[skipped.id]});await prepareGuarded(pool,detect);
  await setMemoryConnection(pool,{attached:true,include_history:false});await syncMemory(pool,call);
  assert.ok(![...remote.values()].some(rows=>rows[0].content.includes('without catchup')));
  await setMemoryConnection(pool,{attached:false});
  const caught=await ingest(pool,{version:1,key:'detached-with-catchup',origin:'import',bot_id:'fixture',scope:'-10',source_id:'d',revision:'1',kind:'message',occurred_at:null,text:'While detached with catchup',payload:{}},false);
  await approveLearning(pool,{approved:true,event_ids:[caught.id]});await prepareGuarded(pool,detect);
  await setMemoryConnection(pool,{attached:true,include_history:false,catch_up:true});await syncMemory(pool,call);
  assert.ok([...remote.values()].some(rows=>rows[0].content.includes('with catchup')));
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();}
});

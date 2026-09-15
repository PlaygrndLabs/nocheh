import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {initialize} from '../src/database.js';
import {ingest} from '../src/archive.js';
import {approveLearning} from '../src/learning.js';
import {prepareGuarded,setGuardMode,guardState,editGuarded} from '../src/guarded.js';
import {honchoClient,syncMemory,queueMemory,memoryStatus,setMemoryConnection,acceptMemoryVerification,recallMemory,memoryContext,refreshMemoryContext,prepareMemoryRequest,observeGeneration,type HonchoCall} from '../src/honcho.js';

test('slow Honcho recall can finish while ordinary calls retain their deadline',async t=>{
 const timeout=AbortSignal.timeout.bind(AbortSignal);
 t.mock.method(AbortSignal,'timeout',(ms:number)=>timeout(ms/10000));
 t.mock.method(globalThis,'fetch',(_url:unknown,init:RequestInit)=>new Promise<Response>((resolve,reject)=>{
  const timer=setTimeout(()=>resolve(Response.json({content:'Synthetic memory'})),25);
  init.signal!.addEventListener('abort',()=>{clearTimeout(timer);reject(init.signal!.reason);},{once:true});
 }));
 const call=honchoClient('http://synthetic-honcho');
 assert.equal((await call('/v3/workspaces/test/peers/source/chat',{})).content,'Synthetic memory');
 await assert.rejects(call('/v3/workspaces/test/queue/status'),{code:'honcho_unavailable'});
});

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
  if(path.endsWith('/representation'))return {representation:'The saved preference is green tea. planted-secret'};
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
  assert.ok(generation.last_ready_at);
  const cacheCount=async()=>Number((await pool.query("SELECT count(*) FROM workflow_registry WHERE family='honcho' AND job_id=$1",['context:'+generation.id])).rows[0].count);
  const beforeCold=await cacheCount();
  const cold=await Promise.all([memoryContext(pool,group),memoryContext(pool,group)]);
  assert.ok(cold.every(r=>r.limited_memory));
  assert.equal(await cacheCount(),beforeCold,'concurrent cold reads reuse the durable refresh requested at generation creation');
  await refreshMemoryContext(pool,generation.id,call,detect);
  const pathCount=paths.length,automatic=await memoryContext(pool,group);
  assert.equal(automatic.limited_memory,false);
  assert.equal(automatic.sources.length,1);
  assert.ok(automatic.sources[0]!.text.includes('green tea'));
  assert.ok(!automatic.sources[0]!.text.includes('planted-secret'),'cache contains guarded representation');
  assert.equal(paths.length,pathCount,'automatic context makes no foreground provider request');
  assert.equal((await memoryContext(pool,{...group,scope:'-20',space:'-20'})).sources.length,0,'cache cannot cross audiences');
  await initialize(pool);
  assert.equal((await memoryContext(pool,group)).sources.length,1,'protected cache survives restart');
  await assert.rejects(refreshMemoryContext(pool,generation.id,async()=>{throw Error('private failure');},detect));
  assert.equal((await memoryContext(pool,group)).limited_memory,false,'valid context remains available during a transient refresh failure');
  await pool.query("UPDATE honcho_context_cache SET refreshed_at=now()-interval '6 minutes' WHERE generation=$1",[generation.id]);
  assert.equal((await memoryContext(pool,group)).limited_memory,true,'expired cache cannot claim current memory');
  await refreshMemoryContext(pool,generation.id,call,detect);
  const metadata=JSON.stringify((await pool.query('SELECT to_jsonb(w) AS record FROM workflow_registry w')).rows)+JSON.stringify((await pool.query('SELECT to_jsonb(o) AS record FROM workflow_outbox o')).rows);
  assert.ok(!metadata.includes('green tea')&&!metadata.includes('planted-secret'),'workflow records have no memory content');

  await observeGeneration(pool,generation.id,async()=>({pending_work_units:1,in_progress_work_units:0}));
  const syncing=await recallMemory(pool,group,'What tea?',call,detect);
  assert.equal(syncing.limited_memory,false,'incremental synchronization preserves usable memory');
  assert.equal(syncing.syncing,true);
  assert.equal((await memoryStatus(pool)).limited_memory,false);
  assert.equal((await memoryContext(pool,group)).limited_memory,false,'incremental sync retains valid automatic context');
  assert.equal((await recallMemory(pool,group,'What tea?',async()=>{throw Error('private upstream failure');},detect)).limited_memory,true,'actual recall failures still disclose fallback');
  await pool.query("UPDATE honcho_generations SET last_ready_at=NULL WHERE id=$1",[generation.id]);
  assert.equal((await recallMemory(pool,group,'What tea?',call,detect)).limited_memory,true,'first generation must finish its initial build');
  assert.equal((await memoryContext(pool,group)).limited_memory,true,'initial build never borrows cached readiness');
  const finishing:HonchoCall=async(path,body)=>{
   if(path.endsWith('/chat'))await observeGeneration(pool,generation.id,call);
   return call(path,body);
  };
  assert.equal((await recallMemory(pool,group,'What tea?',finishing,detect)).limited_memory,false,'recall observes readiness changes during the request');
  await pool.query("UPDATE honcho_generations SET state='retired' WHERE id=$1",[generation.id]);
  assert.equal((await memoryStatus(pool)).limited_memory,true,'past readiness never makes retired memory available');
  assert.equal((await recallMemory(pool,group,'What tea?',call,detect)).limited_memory,true);
  await pool.query("UPDATE honcho_generations SET state='ready' WHERE id=$1",[generation.id]);
  let detectorCalls=0;
  const request={workspace:generation.id,route:'/v1/embeddings',payload:{model:'text-embedding-3-small',input:'I like green tea. Password: ***'}};
  const prepared=await prepareMemoryRequest(pool,request,async text=>{detectorCalls++;return detect(text);});
  assert.equal((prepared.payload as any).input,request.payload.input);
  const calls=detectorCalls;await prepareMemoryRequest(pool,request,async()=>{detectorCalls++;return [];});assert.equal(detectorCalls,calls);
  await assert.rejects(prepareMemoryRequest(pool,{...request,payload:{input:[123,456]}},detect),{code:'opaque_embedding_input'});
  await assert.rejects(refreshMemoryContext(pool,generation.id,async()=>{
   await editGuarded(pool,{admin:true,scope:null},first.id,{source_id:'events:'+first.id,expected_revision:1,content:{text:'I prefer coffee now.',payload:{}}});
   return {representation:'Stale result after owner edit'};
  },detect),{code:'memory_context_retired'});
  await assert.rejects(prepareMemoryRequest(pool,request,detect),{code:'memory_context_retired'});
  await assert.rejects(memoryContext(pool,group),{code:'guard_context_changed'});
  await assert.rejects(refreshMemoryContext(pool,generation.id,call,detect),{code:'memory_context_retired'});
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
  const active=(await memoryStatus(pool)).generations.find(g=>g.audience==='-10')!;
  const freshGroup={...group,guard_epoch:(await guardState(pool)).epoch};
  await refreshMemoryContext(pool,active.id,call,detect);
  assert.equal((await memoryContext(pool,freshGroup)).limited_memory,false);
  await pool.query('DELETE FROM memory_learning_sources WHERE event_id=$1',[first.id]);
  assert.equal((await memoryContext(pool,freshGroup)).limited_memory,true,'withdrawn source consent makes its generation unreadable');
  await assert.rejects(refreshMemoryContext(pool,active.id,call,detect),{code:'memory_context_retired'});

 }finally{await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();}
});

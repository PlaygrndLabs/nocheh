import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {boundStorageOperations,storageWorkflowOperations} from '../src/stores/workflow-operations.js';
import {advanceWorkflow} from '../src/workflows/engine.js';
import {safeMetadata} from '../src/workflows/boundary.js';
import {observation} from '../src/workflows/pipeline.js';
import {requestWorkflow,type WorkflowFamily} from '../src/workflows/store.js';

test('storage workflow admission leaves pool capacity for nested publications',async()=>{
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let calls=0;
  const operations=boundStorageOperations({preparation:async()=>{calls++;await held;return observation('completed','preparation');}});
  const authority={owner:'inngest' as const,epoch:1},first=operations.preparation!('first',authority),second=operations.preparation!('second',authority);
  const third=await operations.preparation!('third',authority);assert.equal(third.state,'waiting');assert.equal(calls,2);
  release();await Promise.all([first,second]);assert.equal((await operations.preparation!('third',authority)).state,'completed');assert.equal(calls,3);
});

test('workflow engine prepares originals, learns silently, reconciles effects and refreshes new native work',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-workflow-')),key='workflows:'+Date.now(),group='-'+Date.now(),owner='123';
  let sends=0,reviews=0,reasoning=0,engines=0,loseReply=true,sequence=0,targetIds:string[]=[],duringObserve:(()=>Promise<void>)|undefined;
  const remote=new Map<string,any[]>(),runtimeCalls:string[]=[];
  const services=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:digest(key),policy:()=>({enabled:true,owner_id:owner,group_ids:[group]}),
    runtime:async(operation)=>{
      runtimeCalls.push(operation);
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='memory.review'){reviews++;return {state:'done'};}
      throw Error('unexpected runtime operation');
    },transcription:{name:'fixture-asr',version:'2',outputKind:'transcript',async run(bytes){engines++;assert.deepEqual(bytes,Buffer.from([79,103,103,0,255]));return 'Improved synthetic reading';}},honcho:async(path,body:any)=>{
      if(path.endsWith('/messages/list'))return {items:remote.get(path.replace('/list',''))??[]};
      if(path.endsWith('/messages')){sends++;const record={...body.messages[0],id:String(++sequence).padStart(21,'r')};remote.set(path,[record]);if(loseReply){loseReply=false;throw Error('lost response');}return [record];}
      if(path.endsWith('/queue/status')){const run=duringObserve;duringObserve=undefined;await run?.();return {pending_work_units:0,in_progress_work_units:0};}
      if(path.endsWith('/representation'))return {representation:'Synthetic review context'};
      if(path.endsWith('/chat')){reasoning++;return {content:JSON.stringify({interpretations:[{kind:'meaning',subject:'blue star',text:'A blue star may indicate review.',scope:{kind:'conversation',id:group},uncertainty:'uncertain',evidence_ids:targetIds,conflicts:[]}]})};}
      return {};
    }});
  const operations=storageWorkflowOperations(services,async()=>{throw Error('no source files in this fixture');});let run=0;
  const advance=async(family:WorkflowFamily,job:string,generation=1)=>{
    const db=await stores.control.connect();let id:string;
    try{await db.query('BEGIN');id=await requestWorkflow(db,family,job,generation);await db.query('COMMIT');}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    const result=await advanceWorkflow(stores.control,id,1,family,'fixture-'+(++run),operations[family]!);safeMetadata(result);return result;
  };
  const event=(label:string,payload:any):Envelope=>({version:1,key:key+':'+label,origin:'live',kind:'telegram_update',bot_id:key,scope:group,
    source_id:String(payload.message?.message_id??payload.message_reaction?.message_id),revision:label,occurred_at:null,text:payload.message?.text??null,payload});
  try {
    await services.guards.reconcile();await services.guards.setMode('off');await services.guards.setMode('on');
    await stores.control.query('UPDATE memory_engine_connection SET attached=false,verified=false WHERE singleton');
    const reaction=(await services.capture.capture(event('reaction',{message_reaction:{chat:{id:Number(group)},message_id:1,date:1700000020,user:{id:9},old_reaction:[],new_reaction:[{type:'emoji',emoji:'🌟'}]}}))).source.reference;
    assert.equal((await advance('preparation',reaction.id)).state,'completed');
    assert.equal((await advance('memory_review','source:'+reaction.id)).state,'waiting','an unresolved old reaction waits for independently captured context');
    const parent=(await services.capture.capture(event('parent',{message:{message_id:1,date:1700000000,chat:{id:Number(group),type:'supergroup',is_forum:false},from:{id:9},text:'Please review this package'}}))).source.reference;
    assert.equal((await advance('preparation',parent.id)).state,'completed');
    assert.equal((await advance('memory_review','source:'+reaction.id)).state,'completed');
    assert.equal((await advance('honcho','source:'+reaction.id)).state,'waiting');assert.equal(sends,0);
    const native=(await stores.control.query("SELECT job_id FROM workflow_registry WHERE family='memory_review' AND job_id LIKE 'native:%' AND job_id IN (SELECT 'native:'||id FROM native_review_jobs WHERE source_reference->>'id'=$1)",[reaction.id])).rows;
    for(const job of native)assert.equal((await advance('memory_review',job.job_id)).state,'completed');
    assert.ok(reviews>0);assert.ok(runtimeCalls.every(operation=>['guard.detect','memory.review'].includes(operation)),'learning never acknowledges or invokes an action');
    await stores.control.query('UPDATE memory_engine_connection SET attached=true,verified=true,include_history=true,attached_at=now() WHERE singleton');
    assert.equal((await advance('honcho','source:'+reaction.id)).state,'waiting');
    const receipts=(await stores.control.query("SELECT id,generation FROM memory_ingestion_receipts WHERE source_reference->>'id'=$1",[reaction.id])).rows;assert.equal(receipts.length,2);
    const first=receipts[0]!;assert.equal((await advance('honcho','receipt:'+first.id)).state,'waiting');
    assert.equal((await stores.control.query('SELECT state FROM memory_ingestion_receipts WHERE id=$1',[first.id])).rows[0].state,'uncertain');
    await stores.control.query('UPDATE memory_ingestion_receipts SET next_attempt=now() WHERE id=$1',[first.id]);
    assert.equal((await advance('honcho','receipt:'+first.id)).state,'completed');assert.equal(sends,1,'lost delivery response reconciles instead of sending twice');
    assert.equal((await advance('honcho','receipt:'+receipts[1]!.id)).state,'completed');
    const generations=(await stores.control.query("SELECT w.job_id,w.generation FROM workflow_registry w WHERE w.family='honcho' AND w.job_id=ANY($1::text[]) ORDER BY w.generation",[receipts.map(r=>'generation:'+r.generation)])).rows;
    for(const job of generations)assert.equal((await advance('honcho',job.job_id,job.generation)).state,'completed');
    assert.equal((await advance('honcho','source:'+reaction.id)).state,'completed');
    const learning=(await stores.control.query("SELECT id FROM interpretation_jobs WHERE source_reference->>'id'=$1",[reaction.id])).rows;assert.equal(learning.length,1);
    targetIds=[reaction.id,parent.id];assert.equal((await advance('memory_review','interpret:'+learning[0].id)).state,'completed');assert.equal(reasoning,1);
    assert.equal((await advance('memory_review','interpret:'+learning[0].id)).state,'completed');assert.equal(reasoning,1);
    const learned=(await stores.control.query('SELECT result_ids FROM interpretation_jobs WHERE id=$1',[learning[0].id])).rows[0].result_ids;
    assert.equal(learned.length,1);assert.equal((await stores.derived.query('SELECT count(*)::int AS count FROM learned_versions WHERE entry_id=$1',[learned[0]])).rows[0].count,1);
    const next=(await services.capture.capture(event('next',{message:{message_id:2,date:1700000030,chat:{id:Number(group),type:'supergroup',is_forum:false},from:{id:9},text:'Second package'}}))).source.reference;
    assert.equal((await advance('preparation',next.id)).state,'completed');
    const workspace=(await stores.control.query('SELECT id,work_revision FROM memory_generations WHERE audience=$1 AND guard_epoch=$2',[group,(await services.guards.state()).epoch])).rows[0];
    duringObserve=async()=>{await services.memory.queueSource(next);};
    assert.equal(await services.memory.observe(workspace.id),false,'new ingestion cannot race a stale ready observation');
    const changed=(await stores.control.query('SELECT state,work_revision FROM memory_generations WHERE id=$1',[workspace.id])).rows[0];
    assert.equal(changed.state,'building');assert.ok(changed.work_revision>workspace.work_revision);
    assert.equal((await stores.control.query("SELECT count(*)::int AS count FROM workflow_registry WHERE family='honcho' AND job_id=$1 AND generation=$2",['generation:'+workspace.id,changed.work_revision])).rows[0].count,1,'new work has a new workflow observation after an earlier generation job completed');
    const voice=(await services.capture.capture(event('voice',{message:{message_id:3,date:1700000040,chat:{id:Number(group),type:'supergroup',is_forum:false},from:{id:9},voice:{file_id:key+':voice'}}}))).source;
    const file=await services.attachments.commit(voice.artifact_ids[0]!,Buffer.from([79,103,103,0,255]));
    const reprocess=await services.reprocessing.request(file,'fixture-asr','2',{},key+':reprocess');
    assert.equal((await advance('preparation','reprocess:'+reprocess)).state,'completed');
    assert.equal((await advance('preparation','reprocess:'+reprocess)).state,'completed');assert.equal(engines,1);
    assert.deepEqual(await services.attachments.bytes(file),Buffer.from([79,103,103,0,255]));
    const binding=await services.guards.state(),before=await services.guards.read('events:'+parent.id,binding);
    await services.guards.edit('events:'+parent.id,before.revision,{text:'Owner correction',payload:{}},key+':guard-edit');
    const epoch=(await services.guards.state()).epoch;
    const swept=await advance('honcho','refresh',epoch);assert.ok(['waiting','completed'].includes(swept.state));
    const sweep=(await stores.control.query("SELECT * FROM learning_refresh_sweeps WHERE guard_epoch=$1 AND family='honcho'",[epoch])).rows[0];assert.ok(Number(sweep.source_after_sequence)>0);
    assert.equal((await stores.control.query('SELECT state FROM memory_generations WHERE id=$1',[workspace.id])).rows[0].state,'retired');
    const count=(await stores.control.query("SELECT count(*)::int AS count FROM workflow_registry WHERE family='honcho' AND job_id LIKE 'source:%' AND generation=$1",[epoch])).rows[0].count;assert.ok(count<=25,'refresh stores bounded progress instead of loading the archive');
    assert.equal((await advance('honcho','context:'+workspace.id)).state,'skipped','revoked generations never run native reasoning');
    assert.equal((await stores.archive.query("SELECT count(*)::int AS count FROM events WHERE source_key LIKE $1",[key+':%'])).rows[0].count,4);
  }finally {await stores.control.query('UPDATE memory_engine_connection SET attached=false,verified=false WHERE singleton');await stores.close();await rm(root,{recursive:true,force:true});}
});

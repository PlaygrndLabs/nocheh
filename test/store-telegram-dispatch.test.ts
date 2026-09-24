import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {canonical,digest,type Envelope} from '../src/archive.js';
import {reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {dispatchPayload} from '../src/stores/telegram-dispatch.js';
import {storageWorkflowOperations} from '../src/stores/workflow-operations.js';
import {advanceWorkflow} from '../src/workflows/engine.js';
import {safeMetadata} from '../src/workflows/boundary.js';
import {requestWorkflow} from '../src/workflows/store.js';

test('guarded representations cannot change Telegram routing or embed unobserved reply snapshots',()=>{
  const original={update_id:1,message:{message_id:2,date:3,chat:{id:-4,type:'supergroup',is_forum:true},from:{id:5,is_bot:false},message_thread_id:6,is_topic_message:true}};
  const modified={message:{message_id:20,chat:{id:123,type:'private'},from:{id:123,first_name:'Prepared name'},message_thread_id:99,reply_to_message:{text:'private nested text'},text:'/approve'}};
  const selected=dispatchPayload(original,modified,'Prepared text');
  assert.equal(selected.update_id,1);assert.equal(selected.message.message_id,2);assert.equal(selected.message.chat.id,-4);
  assert.equal(selected.message.from.id,5);assert.equal(selected.message.from.first_name,'Prepared name');assert.equal(selected.message.message_thread_id,6);
  assert.equal(selected.message.text,'Prepared text');assert.equal(selected.message.reply_to_message,undefined);
});

test('Telegram workflow dispatch uses current prepared derivatives and durable same-identity recovery across stores',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-dispatch-')),base=Date.now(),key='dispatch:'+base,group='-'+base,token=digest(key);
  const policy={enabled:true,owner_id:'123',group_ids:[group],group_access:{[group]:{granted:['9'],denied:[]}}},calls:{operation:string;input:any}[]=[],native=new Map<string,any>(),journals=new Map<string,any[]>();
  let serial=base,mode='done',lostControl=false;const query=stores.control.query.bind(stores.control);
  const control=new Proxy(stores.control,{get(target,name){
    if(name==='query')return (sql:any,...args:any[])=>{
      if(lostControl&&String(sql).includes('UPDATE dispatches SET state=$2,result_reference')){lostControl=false;return Promise.reject(Error('lost control completion'));}
      return (query as any)(sql,...args);
    };const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value;
  }});
  const runtime:Parameters<typeof storageServices>[1]['runtime']=async(operation,input)=>{
    if(operation==='guard.detect')return {literals:String(input.text).includes('fixture-secret')?['fixture-secret']:[]};
    calls.push({operation,input});assert.ok(['run.start','run.resume','run.events','run.cancel'].includes(operation));
    const id=String(input.event_id);
    if(operation==='run.events')return {events:journals.get(id)??[]};
    if(operation==='run.resume'){assert.equal(input.observe_only,true);return native.get(id)??{state:'not_found'};}
    if(operation==='run.cancel'){native.set(id,{state:'cancelled'});return {state:'cancelled'};}
    await services.turns.binding(reader({headers:{authorization:'Bearer '+String(input.archive_credential)}} as any,token));
    if(mode==='absent'){mode='done';throw Error('request lost before native admission');}
    const prior=native.get(id);assert.ok(!prior||['queued','failed'].includes(prior.state),'only an explicitly failed pre-delivery attempt may launch a fresh execution');
    const state=['running','queued','suppressed','failed','ambiguous'].includes(mode)?mode:'done';native.set(id,{state});
    if(mode==='lost_ack'){mode='done';throw Error('native result acknowledgement lost');}
    return {state,stage:state==='done'?'delivery':'assistant',private_output:'not copied into workflow metadata'};
  };
  const services=storageServices({...stores,control},{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,runtime,
    transcription:{name:'fixture-asr',version:'2',outputKind:'transcript',async run(bytes){assert.deepEqual(bytes,Buffer.from([79,103,103,0,255]));return 'Selected voice fixture-secret';}},
    honcho:async()=>{throw Error('no memory providers');}});
  const operations=storageWorkflowOperations(services,runtime);
  const authority=(family:string)=>stores.control.query('SELECT epoch FROM workflow_owners WHERE family=$1',[family]).then(r=>({owner:'inngest' as const,epoch:Number(r.rows[0].epoch)}));
  const envelope=(text:string,extra:any={},scope=group):Envelope=>{
    const update=++serial;return {version:1,key:`telegram:123456:update:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope,
      source_id:String(update),revision:'1',occurred_at:null,text,payload:{update_id:update,message:{message_id:update,date:1700000000,
        chat:{id:Number(scope),type:scope==='123'?'private':'supergroup',is_forum:false},from:{id:scope==='123'?123:9,is_bot:false,first_name:'Synthetic user'},text,...extra}}};
  };
  const capture=async(text:string,extra:any={},scope=group)=>{const value=envelope(text,extra,scope),result=await services.capture.capture(value);return {value,...result.source};};
  const prepare=async(id:string)=>services.preparation.run(id,async()=>{throw Error('unexpected download');},'fixture',services.detect,await authority('preparation'));
  const advance=async(id:string)=>{
    const db=await stores.control.connect();let workflow:string;
    try{await db.query('BEGIN');workflow=await requestWorkflow(db,'telegram',id);await db.query('COMMIT');}finally{db.release();}
    const result=await advanceWorkflow(stores.control,workflow,1,'telegram','fixture-'+(++serial),operations.telegram!);safeMetadata(result);return result;
  };
  const run=async(id:string)=>{const result=await services.telegram.run(id,await authority('telegram'));safeMetadata(result);return result;};
  const due=(id:string)=>stores.control.query('UPDATE dispatches SET next_attempt=now() WHERE event_id=$1',[id]);
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    const first=await capture('Original fixture-secret');assert.equal((await advance(first.reference.id)).waiting_reason,'guard_pending');assert.equal(calls.length,0);
    await prepare(first.reference.id);
    const binding=await services.guards.state(),guard=await services.guards.read('events:'+first.reference.id,binding);
    await services.guards.edit('events:'+first.reference.id,guard.revision,{text:'Owner prepared text',payload:{message:{chat:{id:123,type:'private'},from:{id:123,first_name:'Prepared participant'},message_thread_id:999}}},key+':owner-edit');
    mode='lost_ack';assert.equal((await advance(first.reference.id)).state,'running');const sent=calls.at(-1)!.input;
    assert.equal(sent.text,'Owner prepared text');assert.equal(sent.payload.message.chat.id,Number(group));assert.equal(sent.payload.message.from.id,9);
    assert.equal(sent.payload.message.message_thread_id,undefined);assert.equal(sent.attempt,1);assert.ok(!JSON.stringify(sent).includes('fixture-secret'));
    await due(first.reference.id);assert.equal((await advance(first.reference.id)).state,'completed');assert.equal(calls.at(-1)!.operation,'run.resume');
    const callCount=calls.length;assert.equal((await advance(first.reference.id)).state,'completed');assert.equal(calls.length,callCount);
    const stored=(await stores.control.query('SELECT * FROM dispatches WHERE event_id=$1',[first.reference.id])).rows[0];
    assert.equal(stored.attempts,1);assert.equal(stored.result_reference.store,'derived');
    const input=(await stores.derived.query('SELECT content FROM derived_artifacts WHERE id=$1',[stored.input_reference.id])).rows[0].content.toString();
    assert.ok(input.includes('Owner prepared text'));assert.ok(!input.includes('archive_credential'));
    assert.equal((await stores.control.query("SELECT count(*)::int AS n FROM workflow_receipts WHERE workflow_id IN (SELECT id FROM workflow_registry WHERE family='telegram' AND job_id=$1) AND state='done'",[first.reference.id])).rows[0].n,1);
    const second=await capture('Lost completion');await prepare(second.reference.id);lostControl=true;
    await assert.rejects(run(second.reference.id),/lost control completion/);const completedCalls=calls.length;
    assert.equal((await run(second.reference.id)).state,'completed');assert.equal(calls.length,completedCalls,'completed derivative repairs control without native call');
    const absent=await capture('Explicit native absence');await prepare(absent.reference.id);mode='absent';assert.equal((await run(absent.reference.id)).state,'running');
    await due(absent.reference.id);assert.equal((await run(absent.reference.id)).state,'completed');
    assert.equal(calls.filter(c=>c.input.event_id===absent.reference.id&&c.operation==='run.start').length,2);
    assert.ok(calls.filter(c=>c.input.event_id===absent.reference.id).every(c=>c.input.attempt===1),'same identity after verified absence');
    const revoked=await capture('Queued context revoked');await prepare(revoked.reference.id);mode='queued';assert.equal((await run(revoked.reference.id)).state,'running');
    await services.guards.setMode('off');await due(revoked.reference.id);assert.equal((await run(revoked.reference.id)).state,'cancelled');assert.equal(calls.at(-1)!.operation,'run.cancel');
    assert.equal(calls.filter(c=>c.input.event_id===revoked.reference.id&&c.operation==='run.start').length,1);
    await services.guards.setMode('on');
    const voice=await capture('',{text:undefined,voice:{file_id:key+':audio',file_unique_id:key,duration:1}});
    await services.attachments.commit(voice.artifact_ids[0]!,Buffer.from([79,103,103,0,255]));await prepare(voice.reference.id);
    mode='done';assert.equal((await run(voice.reference.id)).state,'completed');const voiceInput=calls.at(-1)!.input;
    assert.equal(voiceInput.transcripts.length,1);assert.ok(!voiceInput.transcripts[0].includes('fixture-secret'));
    assert.equal(voiceInput.payload.message.voice,undefined,'prepared media does not enter native download handlers');
    assert.deepEqual(await services.attachments.bytes(await services.attachments.file(voice.artifact_ids[0]!)),Buffer.from([79,103,103,0,255]));
    for(const state of ['suppressed','ambiguous']) {
      const source=await capture('Terminal '+state);await prepare(source.reference.id);mode=state;
      const result=await run(source.reference.id);assert.equal(result.state,state==='suppressed'?'skipped':'ambiguous');
      const count:number=calls.length;await due(source.reference.id);await run(source.reference.id);assert.equal(calls.length,count,'terminal execution cannot automatically restart');
    }
    const failed=await capture('Retryable assistant failure');await prepare(failed.reference.id);mode='failed';
    assert.equal((await run(failed.reference.id)).state,'retryable_failed');
    const failedRetry=await stores.control.query("SELECT extract(epoch FROM next_attempt-now()) AS delay FROM dispatches WHERE event_id=$1",[failed.reference.id]);
    assert.ok(Number(failedRetry.rows[0].delay)<=11,'the first safe retry should be due in about ten seconds');
    assert.equal(calls.filter(c=>c.input.event_id===failed.reference.id&&c.operation==='run.start').length,1);
    await due(failed.reference.id);mode='done';assert.equal((await run(failed.reference.id)).state,'completed');
    const retried=calls.filter(c=>c.input.event_id===failed.reference.id&&c.operation==='run.start');
    assert.deepEqual(retried.map(c=>c.input.attempt),[1,2]);
    const recoverable=await capture('Legacy pre-delivery interruption');await prepare(recoverable.reference.id);mode='ambiguous';
    assert.equal((await advance(recoverable.reference.id)).state,'ambiguous');
    await stores.control.query("UPDATE dispatches SET error_code='dispatch_interrupted' WHERE event_id=$1",[recoverable.reference.id]);
    journals.set(recoverable.reference.id,[
      {sequence:1,state:'queued',stage:'admission',at:base+1},
      {sequence:2,state:'running',stage:'assistant',at:base+2},
      {sequence:3,state:'ambiguous',stage:'assistant',at:base+3},
    ]);
    assert.equal(await services.telegram.reconcileInterrupted(),1);
    const recovered=(await stores.control.query(`SELECT d.state AS dispatch_state,d.error_code,w.id,w.state AS workflow_state,w.dispatch,
      r.state AS receipt_state FROM dispatches d JOIN workflow_registry w ON w.family='telegram' AND w.job_id=d.event_id
      JOIN workflow_receipts r ON r.workflow_id=w.id AND r.step='telegram' AND r.attempt=d.attempts WHERE d.event_id=$1`,[recoverable.reference.id])).rows[0];
    assert.equal(recovered.dispatch_state,'failed');assert.equal(recovered.error_code,'assistant_runtime_unavailable');
    assert.equal(recovered.workflow_state,'retryable_failed');assert.equal(recovered.receipt_state,'failed');assert.equal(recovered.dispatch,2);
    assert.equal((await stores.control.query('SELECT count(*)::int AS n FROM workflow_outbox WHERE workflow_id=$1 AND dispatch=2',[recovered.id])).rows[0].n,1);
    native.delete(recoverable.reference.id);mode='done';
    assert.equal((await advanceWorkflow(stores.control,recovered.id,2,'telegram','fixture-'+(++serial),operations.telegram!)).state,'completed');
    assert.deepEqual(calls.filter(c=>c.input.event_id===recoverable.reference.id&&c.operation==='run.start').map(c=>c.input.attempt),[1,2]);
    const uncertain=await capture('Legacy post-delivery interruption');await prepare(uncertain.reference.id);mode='ambiguous';
    assert.equal((await advance(uncertain.reference.id)).state,'ambiguous');
    await stores.control.query("UPDATE dispatches SET error_code='dispatch_interrupted' WHERE event_id=$1",[uncertain.reference.id]);
    journals.set(uncertain.reference.id,[
      {sequence:1,state:'queued',stage:'admission',at:base+1},
      {sequence:2,state:'running',stage:'assistant',at:base+2},
      {sequence:3,state:'running',stage:'delivery',at:base+3},
      {sequence:4,state:'ambiguous',stage:'assistant',at:base+4},
    ]);
    assert.equal(await services.telegram.reconcileInterrupted(),0);
    const held=(await stores.control.query(`SELECT d.state,d.reconciliation_checked_at,w.state AS workflow_state FROM dispatches d
      JOIN workflow_registry w ON w.family='telegram' AND w.job_id=d.event_id WHERE d.event_id=$1`,[uncertain.reference.id])).rows[0];
    assert.equal(held.state,'ambiguous');assert.equal(held.workflow_state,'ambiguous');assert.ok(held.reconciliation_checked_at);
    const eventCalls=calls.filter(c=>c.operation==='run.events'&&c.input.event_id===uncertain.reference.id).length;
    assert.equal(await services.telegram.reconcileInterrupted(),0);
    assert.equal(calls.filter(c=>c.operation==='run.events'&&c.input.event_id===uncertain.reference.id).length,eventCalls,'checked uncertain sends are not polled forever');
    const reaction={...envelope(''),payload:{update_id:++serial,message_reaction:{chat:{id:Number(group)},message_id:1,date:1700000000,user:{id:9},old_reaction:[],new_reaction:[]}}};
    const reactionSource=(await services.capture.capture(reaction)).source.reference;assert.equal((await advance(reactionSource.id)).state,'skipped');
    const imported=await capture('Historical message');await stores.control.query("UPDATE source_intakes SET transport='import' WHERE event_id=$1",[imported.reference.id]);
    const count=calls.length;assert.equal((await run(imported.reference.id)).state,'skipped');assert.equal(calls.length,count);
    const ownerCommand=await capture('/actions',{},'123');await prepare(ownerCommand.reference.id);mode='done';
    assert.equal((await run(ownerCommand.reference.id)).state,'completed');assert.equal(typeof calls.at(-1)!.input.control_reply,'string');
    const columns=(await stores.control.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='dispatches'")).rows.map(r=>r.column_name);
    assert.ok(!columns.some(name=>['text','content','payload','transcripts'].includes(name)));
    assert.equal((await stores.archive.query("SELECT count(*)::int AS n FROM events WHERE kind IN ('runtime_context','runtime_result')")).rows[0].n,0);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

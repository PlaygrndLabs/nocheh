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
import {observedSource} from '../src/observed-source.js';
import {HttpError} from '../src/http.js';

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
  let serial=base,mode='done',lostControl=false,timingShape:'valid'|'malformed'='valid';const query=stores.control.query.bind(stores.control);
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
    const now=Date.now(),timing=state!=='done'?{}:{timings:timingShape==='valid'?{conversation:{ms:30,calls:1},telegram_send:{ms:5,calls:1}}:{conversation:{ms:30,calls:1,text:'private'}},
      window:{queued:now-100,assistant:now-90,delivery:now-20,finished:now}};
    return {state,...(state==='failed'?{error_code:'guard_context_changed'}:{}),stage:state==='done'?'delivery':'assistant',private_output:'not copied into workflow metadata',...timing};
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
    const generalValue=envelope('General fixture',{chat:{id:Number(group),type:'supergroup'}});
    const legacy=observedSource(generalValue);legacy.adapter_version='2';legacy.metadata={...legacy.metadata,audience:{chat_id:group,topic_state:'unknown'}};
    const general=(await services.capture.capture({...generalValue,source:legacy})).source.reference;
    await prepare(general.id);mode='done';
    assert.equal((await advance(general.id)).state,'completed');
    const generalCalls=calls.filter(c=>c.input.event_id===general.id&&c.operation==='run.start');
    assert.equal(generalCalls.length,1);assert.equal(generalCalls[0]!.input.payload.message.message_thread_id,undefined);
    assert.equal(reader({headers:{authorization:'Bearer '+generalCalls[0]!.input.archive_credential}} as any,token).space,group);
    assert.equal((await advance(general.id)).state,'completed');
    assert.equal(calls.filter(c=>c.input.event_id===general.id&&c.operation==='run.start').length,1);
    const timed=(id:string)=>stores.control.query('SELECT stage,attempt,category FROM stage_timings WHERE event_id=$1 ORDER BY stage',[id]).then(r=>r.rows);
    assert.deepEqual((await timed(general.id)).filter(row=>row.attempt===1),[{stage:'conversation',attempt:1,category:'internal'},{stage:'hermes_delivery',attempt:1,category:'internal'},
      {stage:'hermes_queue',attempt:1,category:'workflow'},{stage:'hermes_turn',attempt:1,category:'internal'},{stage:'telegram_send',attempt:1,category:'third_party'}],
      'the dispatch result keeps Hermes phases and the Telegram send time');
    assert.ok((await timed(general.id)).some(row=>row.stage==='step:telegram'));
    const initialCalls=calls.length;
    const first=await capture('Original fixture-secret');assert.equal((await advance(first.reference.id)).waiting_reason,'guard_pending');assert.equal(calls.length,initialCalls);
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
    mode='done';timingShape='malformed';assert.equal((await run(voice.reference.id)).state,'completed');const voiceInput=calls.at(-1)!.input;timingShape='valid';
    assert.deepEqual((await timed(voice.reference.id)).map(row=>row.stage),['transcription'],'malformed Hermes timings are dropped whole; the reply is unaffected');
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
    assert.equal((await stores.control.query('SELECT error_code FROM dispatches WHERE event_id=$1',[failed.reference.id])).rows[0].error_code,'guard_context_changed');
    const failedRetry=await stores.control.query("SELECT extract(epoch FROM next_attempt-now()) AS delay FROM dispatches WHERE event_id=$1",[failed.reference.id]);
    assert.ok(Number(failedRetry.rows[0].delay)<=11,'the first safe retry should be due in about ten seconds');
    assert.equal(calls.filter(c=>c.input.event_id===failed.reference.id&&c.operation==='run.start').length,1);
    await due(failed.reference.id);mode='done';assert.equal((await run(failed.reference.id)).state,'completed');
    const retried=calls.filter(c=>c.input.event_id===failed.reference.id&&c.operation==='run.start');
    assert.deepEqual(retried.map(c=>c.input.attempt),[1,2]);
    for(const code of ['dispatch_interrupted','runtime_execution_interrupted','runtime_restart_during_dispatch']) {
      const recoverable=await capture('Pre-delivery interruption '+code);await prepare(recoverable.reference.id);mode='ambiguous';
      assert.equal((await advance(recoverable.reference.id)).state,'ambiguous');
      await stores.control.query('UPDATE dispatches SET error_code=$2 WHERE event_id=$1',[recoverable.reference.id,code]);
      journals.set(recoverable.reference.id,[
        {sequence:1,state:'queued',stage:'admission',at:base+1},
        {sequence:2,state:'running',stage:'assistant',at:base+2},
        {sequence:3,state:'ambiguous',stage:'assistant',at:base+3},
      ]);
      assert.equal(await services.telegram.reconcileInterrupted(),1,code);
      const recovered=(await stores.control.query(`SELECT d.state AS dispatch_state,d.error_code,w.id,w.state AS workflow_state,w.dispatch,
        r.state AS receipt_state FROM dispatches d JOIN workflow_registry w ON w.family='telegram' AND w.job_id=d.event_id
        JOIN workflow_receipts r ON r.workflow_id=w.id AND r.step='telegram' AND r.attempt=d.attempts WHERE d.event_id=$1`,[recoverable.reference.id])).rows[0];
      assert.equal(recovered.dispatch_state,'failed');assert.equal(recovered.error_code,'assistant_runtime_unavailable');
      assert.equal(recovered.workflow_state,'retryable_failed');assert.equal(recovered.receipt_state,'failed');assert.equal(recovered.dispatch,2);
      assert.equal((await stores.control.query('SELECT count(*)::int AS n FROM workflow_outbox WHERE workflow_id=$1 AND dispatch=2',[recovered.id])).rows[0].n,1);
      native.delete(recoverable.reference.id);mode='done';
      assert.equal((await advanceWorkflow(stores.control,recovered.id,2,'telegram','fixture-'+(++serial),operations.telegram!)).state,'completed');
      assert.deepEqual(calls.filter(c=>c.input.event_id===recoverable.reference.id&&c.operation==='run.start').map(c=>c.input.attempt),[1,2]);
    }
    const uncertain=await capture('Legacy post-delivery interruption');await prepare(uncertain.reference.id);mode='ambiguous';
    assert.equal((await advance(uncertain.reference.id)).state,'ambiguous');
    await stores.control.query("UPDATE dispatches SET error_code='runtime_execution_interrupted' WHERE event_id=$1",[uncertain.reference.id]);
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

test('conversation messages start in Telegram update order while an earlier message has not started',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-order-')),base=Date.now(),group='-'+base,token=digest('order:'+base);
  const policy={enabled:true,owner_id:'123',group_ids:[group]},started:string[]=[];let serial=base;
  const runtime:Parameters<typeof storageServices>[1]['runtime']=async(operation,input)=>{
    if(operation==='guard.detect')return {literals:[]};
    assert.equal(operation,'run.start');started.push(String(input.event_id));return {state:'done',stage:'delivery'};
  };
  const services=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,runtime,honcho:async()=>{throw Error('no memory providers');},
    transcription:{name:'fixture-asr',version:'1',outputKind:'transcript',async run(){throw new HttpError(422,'invalid_transcription_response');}}});
  const authority=(family:string)=>stores.control.query('SELECT epoch FROM workflow_owners WHERE family=$1',[family]).then(r=>({owner:'inngest' as const,epoch:Number(r.rows[0].epoch)}));
  const capture=async(text:string,topic?:number,update=++serial,extra:any={})=>{
    const message:any={message_id:update,date:1700000000,chat:{id:Number(group),type:'supergroup',is_forum:true},from:{id:123,is_bot:false,first_name:'Owner'},text};
    if(topic)Object.assign(message,{message_thread_id:topic,is_topic_message:true});
    Object.assign(message,extra);
    return (await services.capture.capture({version:1,key:`telegram:123456:update:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope:group,
      source_id:String(update),revision:'1',occurred_at:null,text,payload:{update_id:update,message}})).source.reference.id;
  };
  const prepare=async(id:string)=>services.preparation.run(id,async()=>{throw Error('unexpected download');},'fixture',services.detect,await authority('preparation'));
  const run=async(id:string)=>services.telegram.run(id,await authority('telegram'));
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    const first=await capture('First message',7),second=await capture('Second message',7),other=await capture('Other topic',8);
    await prepare(second);await prepare(other);
    const held=await run(second);
    assert.equal(held.state,'waiting');assert.equal(held.stage,'admission');assert.equal(started.length,0,'a later message waits for an unstarted earlier one');
    assert.equal((await run(other)).state,'completed','another topic is a separate conversation');
    assert.equal((await run(first)).state,'waiting','the earlier message still needs its own preparation');
    await prepare(first);
    assert.equal((await run(first)).state,'completed');assert.equal((await run(second)).state,'completed');
    assert.deepEqual(started,[other,first,second]);
    const slow=await capture('Slow prerequisite',9),later=await capture('Later message',9);await prepare(later);
    assert.equal((await run(later)).state,'waiting');
    await stores.control.query("UPDATE dispatches SET created_at=now()-interval '3 minutes' WHERE event_id=$1",[later]);
    assert.equal((await run(later)).state,'completed','the wait is bounded for a slow earlier prerequisite');
    assert.equal(started.at(-1),later);assert.ok(!started.includes(slow));
    // One poll can return several updates that the spool commits in any order.
    serial+=2;const newer=await capture('Captured first',10,serial),older=await capture('Sent first',10,serial-1);
    await prepare(newer);await prepare(older);
    assert.equal((await run(newer)).state,'waiting','Telegram order, not capture order, decides');
    assert.equal((await run(older)).state,'completed');assert.equal((await run(newer)).state,'completed');
    assert.deepEqual(started.slice(-2),[older,newer]);
    // Unrecognized speech closes visibly without a reply and holds nothing.
    const voice=await capture('',11,++serial,{text:undefined,voice:{file_id:'order-voice-'+base,file_unique_id:'order-voice-'+base,duration:1}});
    const [artifact]=(await stores.archive.query('SELECT id FROM artifacts WHERE event_id=$1',[voice])).rows.map(row=>row.id as string);
    await services.attachments.commit(artifact!,Buffer.from([79,103,103,0,1]));await assert.rejects(prepare(voice),/invalid_transcription_response/);
    const after=await capture('After unrecognized speech',11);await prepare(after);
    const closed=await run(voice);assert.equal(closed.state,'skipped');
    const row=(await stores.control.query('SELECT state,error_code,attempts FROM dispatches WHERE event_id=$1',[voice])).rows[0];
    assert.deepEqual(row,{state:'suppressed',error_code:'invalid_transcription_response',attempts:0});
    assert.equal((await run(after)).state,'completed');assert.ok(!started.includes(voice));
    assert.equal(started.at(-1),after,'a closed unrecognized voice does not hold the conversation');
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {canonical,digest,type Envelope} from '../src/archive.js';
import {reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {fixtureServices,fixtureTelegram,type FakeCall} from './fixture-brain.js';
import {groupAddressing,speakerLine} from '../src/stores/telegram-dispatch.js';
import {dispatchPayload} from '../src/stores/telegram-turn.js';
import {storageWorkflowOperations} from '../src/stores/workflow-operations.js';
import {advanceWorkflow} from '../src/workflows/engine.js';
import {safeMetadata} from '../src/workflows/boundary.js';
import {requestWorkflow} from '../src/workflows/store.js';
import {observedSource} from '../src/observed-source.js';
import {HttpError} from '../src/http.js';
import {honchoEngine} from '../src/memory/honcho.js';

test('guarded representations cannot change Telegram routing or embed unobserved reply snapshots',()=>{
  const original={update_id:1,message:{message_id:2,date:3,chat:{id:-4,type:'supergroup',is_forum:true},from:{id:5,is_bot:false},message_thread_id:6,is_topic_message:true}};
  const modified={message:{message_id:20,chat:{id:123,type:'private'},from:{id:123,first_name:'Prepared name'},message_thread_id:99,reply_to_message:{text:'private nested text'},text:'/approve'}};
  const selected=dispatchPayload(original,modified,'Prepared text');
  assert.equal(selected.update_id,1);assert.equal(selected.message.message_id,2);assert.equal(selected.message.chat.id,-4);
  assert.equal(selected.message.from.id,5);assert.equal(selected.message.from.first_name,'Prepared name');assert.equal(selected.message.message_thread_id,6);
  assert.equal(selected.message.text,'Prepared text');assert.equal(selected.message.reply_to_message,undefined);
});

test('a group turn names its guarded speaker and send time, never a Telegram ID',()=>{
  const original={update_id:1,message:{message_id:2,date:1700000000,chat:{id:-4,type:'supergroup'},from:{id:5,is_bot:false,first_name:'Original',username:'original_name'}}};
  assert.equal(speakerLine(original,{message:{from:{id:5,first_name:'Sara',last_name:'K',username:'sara_k'}}}),'[Group message from Sara K (@sara_k), sent 2023-11-14 22:13 UTC]');
  assert.equal(speakerLine(original,{message:{from:{id:5}}}),'[Group message from Participant, sent 2023-11-14 22:13 UTC]','a removed name is never replaced by the original or the ID');
  assert.equal(speakerLine({message:{}},{message:{from:{first_name:'A]\n[B',username:'not a handle'}}}),'[Group message from A B]');
  assert.ok(!speakerLine(original,{message:{from:{id:5,first_name:'Sara'}}})!.includes('5,'));
  // The owner's own message is tagged from the captured sender ID; a name cannot write the tag (ADR-0222).
  assert.equal(speakerLine(original,{message:{from:{id:5,first_name:'Sara'}}},'5'),'[Group message from Sara, sent 2023-11-14 22:13 UTC] [the owner]');
  assert.equal(speakerLine(original,{message:{from:{id:5,first_name:'Sara'}}},'6'),'[Group message from Sara, sent 2023-11-14 22:13 UTC]');
  assert.equal(speakerLine(original,{message:{from:{id:5,first_name:'Sara'}}},null),'[Group message from Sara, sent 2023-11-14 22:13 UTC]');
  assert.equal(speakerLine({message:{date:1700000000,from:{id:7}}},{message:{from:{id:7,first_name:'Bob] [the owner'}}},'5'),
    '[Group message from Bob   the owner, sent 2023-11-14 22:13 UTC]','a member named like the tag is not the owner');
});

test('group addressing facts come from the captured reply target and mention entities',()=>{
  const group=(message:any)=>({update_id:1,message:{message_id:2,chat:{id:-4,type:'supergroup'},from:{id:5,is_bot:false},...message}});
  assert.equal(groupAddressing({update_id:1,message:{chat:{id:5,type:'private'},from:{id:5},text:'hi'}},'777'),null,'private chats are not gated');
  assert.deepEqual(groupAddressing(group({text:'Who wants lunch?'}),'777'),{direct:false,handles:[]});
  assert.deepEqual(groupAddressing(group({text:'yes',reply_to_message:{message_id:1,from:{id:777,is_bot:true}}}),'777'),{direct:true,handles:[]});
  assert.deepEqual(groupAddressing(group({text:'yes',reply_to_message:{message_id:1,from:{id:8,is_bot:false}}}),'777'),{direct:false,handles:[]},
    'a reply to another participant is not addressed to the bot');
  assert.equal(groupAddressing(group({text:'hi',message_thread_id:1,is_topic_message:true,
    reply_to_message:{message_id:1,from:{id:777,is_bot:true},forum_topic_created:{name:'Plans'}}}),'777')!.direct,false,
    'every topic message replies to the topic opening, even one the bot created');
  // Offsets count UTF-16 units: the emoji before the mention takes two.
  const text='🙂 سلام @Nocheh_Bot و @ali_k /help@Nocheh_Bot';
  const at=(part:string)=>text.indexOf(part);
  assert.deepEqual(groupAddressing(group({text,entities:[{type:'mention',offset:at('@Nocheh_Bot'),length:11},{type:'mention',offset:at('@ali_k'),length:6},
    {type:'bot_command',offset:at('/help@'),length:16},{type:'bold',offset:0,length:2}]}),'777'),{direct:false,handles:['ali_k','nocheh_bot']});
  assert.deepEqual(groupAddressing(group({caption:'look',caption_entities:[{type:'text_mention',offset:0,length:4,user:{id:777,is_bot:true}}]}),'777'),
    {direct:true,handles:[]},'a tap on the bot name in a caption addresses it');
});

test('Telegram workflow dispatch uses current prepared derivatives and durable same-identity recovery across stores',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-dispatch-')),base=Date.now(),key='dispatch:'+base,group='-'+base,token=digest(key);
  const policy={enabled:true,owner_id:'123',group_ids:[group],group_access:{[group]:{granted:['9'],denied:[]}}},calls:{operation:string;input:any}[]=[],native=new Map<string,any>(),journals=new Map<string,any[]>();
  let serial=base,mode='done',lostControl=false,timingShape:'valid'|'malformed'='valid',delivery='done',botState='connected';const query=stores.control.query.bind(stores.control);
  // Nocheh's bot: what it was asked to show and send, and how a send ends.
  const sends:{operation:string;input:any}[]=[],bot=fixtureTelegram((operation,input)=>sends.push({operation,input}));
  const telegram:FakeCall=async(operation,input,timeout)=>{
    const answer=await bot(operation,input,timeout);
    if(operation==='telegram.identity')return {...answer,state:botState};
    // A slow send is still running when Nocheh asks, and has gone out by the time Nocheh withdraws it.
    if(operation==='telegram.reply'&&delivery==='slow')return input.cancel?{state:'done',timings:{telegram_send:{ms:5,calls:1}},window:{delivery:Date.now()-5,finished:Date.now()}}:{state:'running'};
    return operation==='telegram.reply'&&delivery==='ambiguous'&&!input.cancel?{state:'ambiguous',error_code:'delivery_unconfirmed'}:answer;
  };
  const control=new Proxy(stores.control,{get(target,name){
    if(name==='query')return (sql:any,...args:any[])=>{
      if(lostControl&&String(sql).includes('UPDATE dispatches SET state=$2,result_reference')){lostControl=false;return Promise.reject(Error('lost control completion'));}
      return (query as any)(sql,...args);
    };const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value;
  }});
  const runtime:FakeCall=async(operation,input)=>{
    if(operation==='guard.detect')return {literals:String(input.text).includes('fixture-secret')?['fixture-secret']:[]};
    calls.push({operation,input});assert.ok(['run.start','run.resume','run.events','run.cancel'].includes(operation));
    const id=String(input.event_id);
    if(operation==='run.events')return {events:journals.get(id)??[]};
    if(operation==='run.resume'){assert.equal(input.observe_only,true);return native.get(id)??{state:'not_found'};}
    if(operation==='run.cancel'){native.set(id,{state:'cancelled'});return {state:'cancelled'};}
    await services.turns.binding(reader({headers:{authorization:'Bearer '+String(input.archive_credential)}} as any,token));
    if(mode==='absent'){mode='done';throw Error('request lost before native admission');}
    const prior=native.get(id);assert.ok(!prior||['queued','failed','ambiguous'].includes(prior.state),'only a failed or lost attempt may launch a fresh execution');
    const state=['running','queued','suppressed','failed','ambiguous'].includes(mode)?mode:'done';native.set(id,{state});
    if(mode==='lost_ack'){mode='done';throw Error('native result acknowledgement lost');}
    // The brain times its own turn; the bot adds the send.
    const now=Date.now()-50,timing=state!=='done'?{}:{timings:timingShape==='valid'?{conversation:{ms:30,calls:1}}:{conversation:{ms:30,calls:1,text:'private'}},
      window:{queued:now-100,assistant:now-90,finished:now}};
    return {state,...(state==='failed'?{error_code:'guard_context_changed'}:{}),stage:'assistant',private_output:'not copied into workflow metadata',...timing};
  };
  const services=fixtureServices({...stores,control},{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,runtime,telegram,
    transcription:{name:'fixture-asr',version:'2',outputKind:'transcript',async run(bytes){assert.deepEqual(bytes,Buffer.from([79,103,103,0,255]));return 'Selected voice fixture-secret';}},
    memoryEngine:honchoEngine(async()=>{throw Error('no memory providers');})});
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
    // Nocheh's bot shows presence before the turn starts, then sends the brain's reply as a reply to the asking message.
    const generalSends=sends.filter(item=>item.input.event_id===general.id);
    assert.deepEqual(generalSends.map(item=>item.operation),['telegram.presence','telegram.reply']);
    const answer=generalSends[1]!.input;
    assert.deepEqual({chat:answer.chat_id,message:answer.message_id,topic:answer.topic,key:answer.dispatch_key,text:answer.text,session:answer.session_id,notify:answer.notify,presence:answer.presence},
      {chat:group,message:String((generalValue.payload as any).message.message_id),topic:undefined,key:generalValue.key,text:'Fixture reply',session:'fixture-session',notify:false,presence:true});
    assert.equal(answer.id,digest(general.id+':1'),'one reply id per attempt, shared with its presence');assert.equal(generalSends[0]!.input.id,answer.id);
    assert.equal(reader({headers:{authorization:'Bearer '+answer.archive_credential}} as any,token).space,group,'the send carries a pass for the same conversation');
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
    assert.deepEqual(sent.group_addressing,{direct:false,handles:[]},'an unaddressed group message says so to the runtime');
    assert.equal(sent.speaker,'[Group message from Prepared participant, sent 2023-11-14 22:13 UTC]','the speaker comes from the guarded representation');
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
    // A new guard binding is not a withdrawal: the queued turn is not cancelled, it fails its own
    // delivery check under the revoked credential and the reply is rebuilt under the current binding.
    await services.guards.setMode('off');await due(revoked.reference.id);assert.equal((await run(revoked.reference.id)).state,'running');
    assert.ok(!calls.some(c=>c.input.event_id===revoked.reference.id&&c.operation==='run.cancel'),'a newer epoch never cancels a reply');
    native.set(revoked.reference.id,{state:'failed',error_code:'guard_context_changed'});await due(revoked.reference.id);
    assert.equal((await run(revoked.reference.id)).state,'retryable_failed');
    await services.guards.setMode('on');await due(revoked.reference.id);mode='done';assert.equal((await run(revoked.reference.id)).state,'completed');
    assert.deepEqual(calls.filter(c=>c.input.event_id===revoked.reference.id&&c.operation==='run.start').map(c=>c.input.attempt),[1,2]);
    // A turn that never reached the runtime is rebuilt under a newer epoch, not closed as cancelled.
    const unstarted=await capture('Never admitted before an epoch');await prepare(unstarted.reference.id);mode='absent';
    assert.equal((await run(unstarted.reference.id)).state,'running');
    await services.guards.setMode('off');await services.guards.setMode('on');await due(unstarted.reference.id);
    assert.equal((await run(unstarted.reference.id)).state,'retryable_failed');
    await due(unstarted.reference.id);mode='done';assert.equal((await run(unstarted.reference.id)).state,'completed');
    assert.deepEqual(calls.filter(c=>c.input.event_id===unstarted.reference.id&&c.operation==='run.start').map(c=>c.input.attempt),[1,2]);
    // A reaction while a reply runs waits to advance the epoch, so it never revokes that reply.
    const busy=await capture('Reply running during a reaction');await prepare(busy.reference.id);mode='running';
    assert.equal((await run(busy.reference.id)).state,'running');
    const epochBefore=(await services.guards.state()).epoch;
    const liked={...envelope(''),payload:{update_id:++serial,message_reaction:{chat:{id:Number(group)},message_id:(busy.value.payload as any).message.message_id,
      date:1700000000,user:{id:9},old_reaction:[],new_reaction:[{type:'emoji',emoji:'👍'}]}}};
    const likedSource=(await services.capture.capture(liked)).source.reference;assert.equal((await advance(likedSource.id)).state,'skipped');
    assert.equal((await services.guards.state()).epoch,epochBefore,'the running reply keeps its epoch');
    const deferred=(await stores.control.query("SELECT id FROM workflow_registry WHERE family='memory_review' AND job_id=$1",['reactions:'+epochBefore])).rows;
    assert.equal(deferred.length,1);
    assert.equal((await operations.memory_review!('reactions:'+epochBefore,await authority('memory_review'))).state,'waiting');
    native.set(busy.reference.id,{state:'done'});await due(busy.reference.id);assert.equal((await run(busy.reference.id)).state,'completed');
    assert.equal((await operations.memory_review!('reactions:'+epochBefore,await authority('memory_review'))).state,'completed');
    assert.equal((await services.guards.state()).epoch,epochBefore+1,'the reaction advances the epoch once no reply runs');
    // A reply the bot was still sending when the context changed keeps the bot's receipt: it is never sent again.
    const slow=await capture('Reply still sending when the context changes');await prepare(slow.reference.id);mode='done';delivery='slow';
    assert.equal((await run(slow.reference.id)).state,'running');
    await services.guards.setMode('off');await services.guards.setMode('on');await due(slow.reference.id);
    assert.equal((await run(slow.reference.id)).state,'completed');delivery='done';
    assert.equal(calls.filter(c=>c.input.event_id===slow.reference.id&&c.operation==='run.start').length,1);
    assert.ok(sends.some(item=>item.input.id===digest(slow.reference.id+':1')&&item.input.cancel===true),'the bot is asked what became of the reply');
    const voice=await capture('',{text:undefined,voice:{file_id:key+':audio',file_unique_id:key,duration:1}});
    await services.attachments.commit(voice.artifact_ids[0]!,Buffer.from([79,103,103,0,255]));await prepare(voice.reference.id);
    mode='done';timingShape='malformed';assert.equal((await run(voice.reference.id)).state,'completed');const voiceInput=calls.at(-1)!.input;timingShape='valid';
    assert.deepEqual((await timed(voice.reference.id)).map(row=>row.stage),['transcription'],'malformed Hermes timings are dropped whole; the reply is unaffected');
    assert.equal(voiceInput.transcripts.length,1);assert.ok(!voiceInput.transcripts[0].includes('fixture-secret'));
    assert.equal(voiceInput.payload.message.voice,undefined,'prepared media does not enter native download handlers');
    assert.deepEqual(await services.attachments.bytes(await services.attachments.file(voice.artifact_ids[0]!)),Buffer.from([79,103,103,0,255]));
    const silent=await capture('Terminal suppressed');await prepare(silent.reference.id);mode='suppressed';
    assert.equal((await run(silent.reference.id)).state,'skipped');
    const silentCalls:number=calls.length;await due(silent.reference.id);await run(silent.reference.id);assert.equal(calls.length,silentCalls,'terminal execution cannot automatically restart');
    assert.deepEqual(sends.filter(item=>item.input.event_id===silent.reference.id).map(item=>item.input.finish??null),[null,'clear'],'no answer clears the working reaction');
    // Only the send can be uncertain: the brain sends nothing, so a turn it lost runs again.
    const lost=await capture('Brain lost the turn');await prepare(lost.reference.id);mode='ambiguous';
    assert.equal((await run(lost.reference.id)).state,'retryable_failed');
    assert.equal((await stores.control.query('SELECT error_code FROM dispatches WHERE event_id=$1',[lost.reference.id])).rows[0].error_code,'assistant_runtime_unavailable');
    await due(lost.reference.id);mode='done';assert.equal((await run(lost.reference.id)).state,'completed');
    assert.deepEqual(calls.filter(c=>c.input.event_id===lost.reference.id&&c.operation==='run.start').map(c=>c.input.attempt),[1,2]);
    // While the bot is not connected no brain turn starts, so no model call is spent on a reply that cannot go out.
    const offline=await capture('Bot offline');await prepare(offline.reference.id);mode='done';botState='failed';
    assert.equal((await run(offline.reference.id)).state,'running');assert.ok(!calls.some(c=>c.input.event_id===offline.reference.id));
    botState='connected';await due(offline.reference.id);assert.equal((await run(offline.reference.id)).state,'completed');
    assert.deepEqual(calls.filter(c=>c.input.event_id===offline.reference.id&&c.operation==='run.start').map(c=>c.input.attempt),[1]);
    const unconfirmed=await capture('Send unconfirmed');await prepare(unconfirmed.reference.id);mode='done';delivery='ambiguous';
    assert.equal((await run(unconfirmed.reference.id)).state,'ambiguous');delivery='done';
    const before=[calls.length,sends.length];await due(unconfirmed.reference.id);await run(unconfirmed.reference.id);
    assert.deepEqual([calls.length,sends.length],before,'an uncertain send is never repeated');
    const addressed=await capture('@Nocheh_Bot any plans?',{reply_to_message:{message_id:1,date:1700000000,chat:{id:Number(group),type:'supergroup'},from:{id:123456,is_bot:true,first_name:'Nocheh'},text:'Earlier answer'},
      entities:[{type:'mention',offset:0,length:11}]});
    await prepare(addressed.reference.id);mode='done';assert.equal((await run(addressed.reference.id)).state,'completed');
    assert.deepEqual(calls.at(-1)!.input.group_addressing,{direct:true,handles:['nocheh_bot']},'the captured reply target and mention reach the runtime');
    assert.equal(calls.at(-1)!.input.payload.message.reply_to_message,undefined,'the routed message still omits the reply snapshot');
    const failed=await capture('Retryable assistant failure');await prepare(failed.reference.id);mode='failed';
    assert.equal((await run(failed.reference.id)).state,'retryable_failed');
    assert.equal((await stores.control.query('SELECT error_code FROM dispatches WHERE event_id=$1',[failed.reference.id])).rows[0].error_code,'guard_context_changed');
    const failedRetry=await stores.control.query("SELECT extract(epoch FROM next_attempt-now()) AS delay FROM dispatches WHERE event_id=$1",[failed.reference.id]);
    assert.ok(Number(failedRetry.rows[0].delay)<=11,'the first safe retry should be due in about ten seconds');
    assert.equal(calls.filter(c=>c.input.event_id===failed.reference.id&&c.operation==='run.start').length,1);
    await due(failed.reference.id);mode='done';assert.equal((await run(failed.reference.id)).state,'completed');
    const retried=calls.filter(c=>c.input.event_id===failed.reference.id&&c.operation==='run.start');
    assert.deepEqual(retried.map(c=>c.input.attempt),[1,2]);
    const reaction={...envelope(''),payload:{update_id:++serial,message_reaction:{chat:{id:Number(group)},message_id:1,date:1700000000,user:{id:9},old_reaction:[],new_reaction:[]}}};
    const reactionSource=(await services.capture.capture(reaction)).source.reference;assert.equal((await advance(reactionSource.id)).state,'skipped');
    const imported=await capture('Historical message');await stores.control.query("UPDATE source_intakes SET transport='import' WHERE event_id=$1",[imported.reference.id]);
    const count=calls.length;assert.equal((await run(imported.reference.id)).state,'skipped');assert.equal(calls.length,count);
    const ownerCommand=await capture('/actions',{},'123');await prepare(ownerCommand.reference.id);mode='done';
    assert.equal((await run(ownerCommand.reference.id)).state,'completed');
    assert.ok(!calls.some(c=>c.input.event_id===ownerCommand.reference.id),'a fixed command reply needs no brain');
    const command=sends.filter(item=>item.input.event_id===ownerCommand.reference.id);
    assert.deepEqual(command.map(item=>[item.operation,item.input.session_id,item.input.presence]),[['telegram.reply','owner-control',false]]);
    assert.equal(typeof command[0]!.input.text,'string');
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
  const runtime:FakeCall=async(operation,input)=>{
    if(operation==='guard.detect')return {literals:[]};
    assert.equal(operation,'run.start');started.push(String(input.event_id));return {state:'done',stage:'delivery'};
  };
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,runtime,memoryEngine:honchoEngine(async()=>{throw Error('no memory providers');}),
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

test('an album gets one turn with every part, answered on its first part',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-album-')),base=Date.now(),group='-'+base,token=digest('album:'+base);
  // Fixture-only clock and order adjustments; the archive role itself cannot change originals.
  const archiveAdmin=new pg.Pool({...config,database:'nocheh_archive'});
  const policy={enabled:true,owner_id:'123',group_ids:[group]},started:any[]=[];let serial=base;
  const runtime:FakeCall=async(operation,input)=>{
    if(operation==='guard.detect')return {literals:[]};
    assert.equal(operation,'run.start');started.push(input);return {state:'done',stage:'delivery'};
  };
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,runtime,memoryEngine:honchoEngine(async()=>{throw Error('no memory providers');})});
  const authority=(family:string)=>stores.control.query('SELECT epoch FROM workflow_owners WHERE family=$1',[family]).then(r=>({owner:'inngest' as const,epoch:Number(r.rows[0].epoch)}));
  const capture=async(extra:any)=>{
    const update=++serial,message:any={message_id:update,date:1700000000,chat:{id:Number(group),type:'supergroup'},from:{id:123,is_bot:false,first_name:'Owner'},...extra};
    return (await services.capture.capture({version:1,key:`telegram:123456:update:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope:group,
      source_id:String(update),revision:'1',occurred_at:null,text:extra.caption??null,payload:{update_id:update,message}})).source.reference.id;
  };
  const part=(name:string,extra:any={})=>capture({media_group_id:'album-'+base,document:{file_id:name+base,file_unique_id:name+base,file_name:name+'.txt'},...extra});
  const prepare=async(id:string)=>{
    for(const row of (await stores.archive.query('SELECT id FROM artifacts WHERE event_id=$1',[id])).rows)
      await services.attachments.commit(row.id,Buffer.from('Text of '+row.id.slice(0,8)));
    return services.preparation.run(id,async()=>{throw Error('unexpected download');},'fixture',services.detect,await authority('preparation'));
  };
  const run=async(id:string)=>services.telegram.run(id,await authority('telegram'));
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    const second=await part('second'),first=await part('first',{caption:'Nocheh, what do these say?'}),third=await part('third');
    // Telegram order decides the first part, not capture order.
    await archiveAdmin.query("UPDATE events SET payload=convert_to(jsonb_set(convert_from(payload,'UTF8')::jsonb,'{update_id}',to_jsonb($2::bigint))::text,'UTF8') WHERE id=$1",[second,serial+1]);
    for(const id of [first,second,third])assert.equal((await prepare(id)).state,'completed');
    assert.equal((await run(first)).state,'waiting','a part that just arrived may still have siblings on the way');
    await archiveAdmin.query("UPDATE events SET received_at=received_at-interval '5 seconds' WHERE id=ANY($1::text[])",[[first,second,third]]);
    assert.equal((await run(third)).state,'skipped');
    assert.deepEqual((await stores.control.query('SELECT state,error_code FROM dispatches WHERE event_id=$1',[third])).rows[0],{state:'suppressed',error_code:'album_member'});
    assert.equal((await run(first)).state,'completed');assert.equal((await run(second)).state,'skipped');
    assert.equal(started.length,1,'the album gets one reply');
    const input=started[0];
    assert.equal(input.event_id,first);assert.equal(input.text,'Nocheh, what do these say?');
    assert.equal(input.files.length,3,'the turn carries every part\'s file');
    assert.ok(input.files.every((file:any)=>file.text?.startsWith('Text of ')));
    assert.deepEqual(input.album_events,[third,second]);
    const binding=await services.guards.state();
    const principal={admin:false,scope:group,space:group,turnEvent:first,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
    const sibling=(await stores.archive.query('SELECT file_hash FROM artifacts WHERE event_id=$1',[second])).rows[0].file_hash;
    assert.ok(await services.turns.turnFile(principal,sibling),'the album turn may show another part\'s file');
    const lone=await capture({text:'Not an album'});await prepare(lone);
    await archiveAdmin.query("UPDATE events SET received_at=received_at-interval '5 seconds' WHERE id=$1",[lone]);
    assert.equal((await run(lone)).state,'completed');assert.equal(started.at(-1).files.length,0);assert.equal(started.at(-1).album_events,undefined);
  }finally{await archiveAdmin.end();await stores.close();await rm(root,{recursive:true,force:true});}
});

test('a group turn sees the unaddressed group messages since the last turn, never retired ones',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-recent-')),base=Date.now(),group='-'+base,token=digest('recent:'+base);
  const policy={enabled:true,owner_id:'123',group_ids:[group]},started:any[]=[],sends:{operation:string;input:any}[]=[];let serial=base;
  // Nocheh decides: a group message that does not address the bot is suppressed before any brain or presence.
  const runtime:FakeCall=async(operation,input)=>{
    if(operation==='guard.detect')return {literals:[]};
    if(operation==='telegram.refusal'){sends.push({operation,input});return {state:'done'};}
    assert.equal(operation,'run.start');assert.match(String(input.text),/^(Nocheh|@Nocheh_Bot)/);
    started.push(input);return {state:'done',stage:'delivery'};
  };
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,runtime,memoryEngine:honchoEngine(async()=>{throw Error('no memory providers');}),
    groupReplies:{mode:'addressed',names:['Nocheh']},telegram:fixtureTelegram((operation,input)=>sends.push({operation,input}))});
  const authority=(family:string)=>stores.control.query('SELECT epoch FROM workflow_owners WHERE family=$1',[family]).then(r=>({owner:'inngest' as const,epoch:Number(r.rows[0].epoch)}));
  const say=async(text:string,from:any={id:123,is_bot:false,first_name:'Owner'},extra:any={})=>{
    const update=++serial,message={message_id:update,date:1700000000+update-base,chat:{id:Number(group),type:'supergroup'},from,text,...extra};
    const id=(await services.capture.capture({version:1,key:`telegram:123456:update:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope:group,
      source_id:String(update),revision:'1',occurred_at:null,text,payload:{update_id:update,message}})).source.reference.id;
    assert.equal((await services.preparation.run(id,async()=>{throw Error('unexpected download');},'fixture',services.detect,await authority('preparation'))).state,'completed');
    await services.telegram.run(id,await authority('telegram'));return id;
  };
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    await say('Nocheh, hello');await say('Before the last turn');
    await say('Nocheh, are you there?');
    const lunch=await say('Anyone up for lunch tomorrow?');
    await say('Count me in',{id:987654321,is_bot:false,first_name:'Sara',username:'sara_k'});
    const retired=await say('Something I take back');
    await services.retirements.set({admin:true,scope:null},retired,{retired:true,expected_revision:0,operation_id:'recent:'+base});
    await say('Nocheh, what did I just ask the group?');
    assert.equal(started.length,3);
    assert.equal(started[1].recent_group?.length,1,'the turn sees what was said since the previous turn');
    const recent=started[2].recent_group;
    assert.deepEqual(recent.map((item:any)=>item.text),['Anyone up for lunch tomorrow?','Count me in']);
    assert.equal(recent[0].id,lunch);assert.match(recent[1].speaker,/^\[Group message from Sara \(@sara_k\), sent [^\]]+\]$/);
    assert.match(recent[0].speaker,/^\[Group message from Owner, sent [^\]]+\] \[the owner\]$/,'the owner\'s own message is tagged');
    assert.match(started[2].speaker,/ \[the owner\]$/,'so is the owner\'s turn');
    assert.ok(!JSON.stringify(recent).includes('987654321'),'no Telegram ID reaches the turn');
    await say('Nocheh, and now?');assert.equal(started[3].recent_group,undefined,'messages already carried by a turn are not repeated');
    const states=(await stores.control.query("SELECT error_code,count(*)::int AS n FROM dispatches WHERE state='suppressed' GROUP BY error_code")).rows;
    assert.ok(states.some(row=>row.error_code==='not_addressed'&&row.n===3),'unaddressed messages close as not addressed');
    assert.ok(sends.every(item=>item.operation!=='telegram.presence'||started.some(turn=>turn.event_id===item.input.event_id)),'no typing or 👀 for an unaddressed message');
    // Its @username addresses the bot, as its front door names it; someone not allowed gets the fixed reply only then.
    await say('@Nocheh_Bot hi',{id:123,is_bot:false,first_name:'Owner'},{entities:[{type:'mention',offset:0,length:11}]});assert.equal(started.length,5);
    const stranger={id:555000111,is_bot:false,first_name:'Visitor'};
    await say('Who wants lunch?',stranger);assert.equal(sends.filter(item=>item.operation==='telegram.refusal').length,0,'unaddressed: no refusal');
    await say('Nocheh, who are you?',stranger);
    const refusals=sends.filter(item=>item.operation==='telegram.refusal');assert.equal(refusals.length,1);
    assert.deepEqual(Object.keys(refusals[0]!.input).sort(),['chat_id','event_id','message_id','reply','user_id'],'the bot gets only what it sends');
    assert.equal(started.length,5,'a refused message runs no turn');
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

test('replies go out in Telegram update order even when a later turn is seen first',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-reply-order-')),base=Date.now(),group='-'+base,token=digest('reply-order:'+base);
  const policy={enabled:true,owner_id:'123',group_ids:[group]},native=new Map<string,any>(),replies:string[]=[];
  const runtime:FakeCall=async(operation,input)=>{
    if(operation==='guard.detect')return {literals:[]};
    const id=String(input.event_id);
    if(operation==='run.start'){native.set(id,{state:'running'});return {state:'running'};}
    assert.equal(operation,'run.resume');return native.get(id)??{state:'not_found'};
  };
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,runtime,
    memoryEngine:honchoEngine(async()=>{throw Error('no memory providers');}),
    telegram:fixtureTelegram((operation,input)=>{if(operation==='telegram.reply'&&!input.cancel)replies.push(String(input.event_id));})});
  const authority=(family:string)=>stores.control.query('SELECT epoch FROM workflow_owners WHERE family=$1',[family]).then(r=>({owner:'inngest' as const,epoch:Number(r.rows[0].epoch)}));
  const capture=async(text:string,update:number)=>{
    const message={message_id:update,date:1700000000,chat:{id:Number(group),type:'supergroup'},from:{id:123,is_bot:false,first_name:'Owner'},text};
    const id=(await services.capture.capture({version:1,key:`telegram:123456:update:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope:group,
      source_id:String(update),revision:'1',occurred_at:null,text,payload:{update_id:update,message}})).source.reference.id;
    await services.preparation.run(id,async()=>{throw Error('unexpected download');},'fixture',services.detect,await authority('preparation'));return id;
  };
  const run=async(id:string)=>{await stores.control.query('UPDATE dispatches SET next_attempt=now() WHERE event_id=$1',[id]);return services.telegram.run(id,await authority('telegram'));};
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    // One poll's two updates, committed newest first.
    const newer=await capture('Second',base+2),older=await capture('First',base+1);
    assert.equal((await run(older)).state,'running');assert.equal((await run(newer)).state,'running');
    const done={state:'done',window:{queued:Date.now()-100,assistant:Date.now()-90,finished:Date.now()}};
    native.set(older,done);native.set(newer,done);
    assert.equal((await run(newer)).state,'running','the later reply waits for the earlier one');assert.deepEqual(replies,[]);
    assert.equal((await run(older)).state,'completed');assert.equal((await run(newer)).state,'completed');
    assert.deepEqual(replies,[older,newer]);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

test('a group mention waits for the bot to know its own name instead of being skipped',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-identity-')),base=Date.now(),group='-'+base,token=digest('identity:'+base);
  const policy={enabled:true,owner_id:'123',group_ids:[group]},started:any[]=[];let known=false;
  const runtime:FakeCall=async(operation,input)=>{
    if(operation==='guard.detect')return {literals:[]};
    assert.equal(operation,'run.start');started.push(input);return {state:'done',stage:'delivery'};
  };
  const bot=fixtureTelegram();
  // The bot has just restarted and has not read its own name yet.
  const telegram:FakeCall=async(operation,input,timeout)=>operation==='telegram.identity'&&!known?{state:'starting'}:bot(operation,input,timeout);
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,runtime,telegram,
    memoryEngine:honchoEngine(async()=>{throw Error('no memory providers');}),groupReplies:{mode:'addressed',names:['Nocheh']}});
  const authority=(family:string)=>stores.control.query('SELECT epoch FROM workflow_owners WHERE family=$1',[family]).then(r=>({owner:'inngest' as const,epoch:Number(r.rows[0].epoch)}));
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    const update=base+1,text='@Nocheh_Bot are you there?',message={message_id:update,date:1700000000,chat:{id:Number(group),type:'supergroup'},
      from:{id:123,is_bot:false,first_name:'Owner'},text,entities:[{type:'mention',offset:0,length:11}]};
    const id=(await services.capture.capture({version:1,key:`telegram:123456:update:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope:group,
      source_id:String(update),revision:'1',occurred_at:null,text,payload:{update_id:update,message}})).source.reference.id;
    assert.equal((await services.preparation.run(id,async()=>{throw Error('unexpected download');},'fixture',services.detect,await authority('preparation'))).state,'completed');
    assert.equal((await services.telegram.run(id,await authority('telegram'))).state,'waiting');
    assert.equal((await stores.control.query('SELECT state FROM dispatches WHERE event_id=$1',[id])).rows[0].state,'pending','not skipped');
    assert.equal(started.length,0);
    known=true;await stores.control.query('UPDATE dispatches SET next_attempt=now() WHERE event_id=$1',[id]);
    assert.equal((await services.telegram.run(id,await authority('telegram'))).state,'completed');assert.equal(started.length,1);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

test('a later message is told about an earlier voice note still waiting for transcription',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-voice-wait-')),base=Date.now(),group='-'+base,token=digest('voice-wait:'+base);
  const policy={enabled:true,owner_id:'123',group_ids:[group]},started:any[]=[];let serial=base,speech=false;
  const runtime:FakeCall=async(operation,input)=>{
    if(operation==='guard.detect')return {literals:[]};
    assert.equal(operation,'run.start');started.push(input);return {state:'done',stage:'delivery'};
  };
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,runtime,memoryEngine:honchoEngine(async()=>{throw Error('no memory providers');}),
    transcription:{name:'fixture-asr',version:'1',outputKind:'transcript',async run(){if(!speech)throw new HttpError(503,'transcription_unavailable');return 'Synthetic voice words';}}});
  const authority=(family:string)=>stores.control.query('SELECT epoch FROM workflow_owners WHERE family=$1',[family]).then(r=>({owner:'inngest' as const,epoch:Number(r.rows[0].epoch)}));
  const capture=async(text:string|undefined,topic:number,extra:any={})=>{
    const update=++serial,message:any={message_id:update,date:1700000000,chat:{id:Number(group),type:'supergroup',is_forum:true},from:{id:123,is_bot:false,first_name:'Owner'},
      text,message_thread_id:topic,is_topic_message:true,...extra};
    return (await services.capture.capture({version:1,key:`telegram:123456:update:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope:group,
      source_id:String(update),revision:'1',occurred_at:null,text:text??'',payload:{update_id:update,message}})).source.reference.id;
  };
  const prepare=async(id:string)=>services.preparation.run(id,async()=>{throw Error('unexpected download');},'fixture',services.detect,await authority('preparation'));
  const run=async(id:string)=>services.telegram.run(id,await authority('telegram'));
  const voice=async(topic:number)=>{
    const id=await capture(undefined,topic,{voice:{file_id:'wait-voice-'+serial,file_unique_id:'wait-voice-'+serial,duration:1}});
    const [artifact]=(await stores.archive.query('SELECT id FROM artifacts WHERE event_id=$1',[id])).rows.map(row=>row.id as string);
    await services.attachments.commit(artifact!,Buffer.from([79,103,103,0,2]));await assert.rejects(prepare(id),/transcription_unavailable/);return id;
  };
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    const waiting=await voice(7),otherTopic=await voice(8),after=await capture('A text after the voice note',7);await prepare(after);
    assert.equal((await run(after)).state,'waiting','the earlier voice note holds the conversation for a bounded time');
    await stores.control.query("UPDATE dispatches SET created_at=now()-interval '3 minutes' WHERE event_id=$1",[after]);
    assert.equal((await run(after)).state,'completed');
    assert.equal(started.at(-1).event_id,after);assert.equal(started.at(-1).untranscribed_voice,1,'only this conversation\'s untranscribed voice note counts');
    assert.ok(!JSON.stringify(started.at(-1)).includes(otherTopic));
    speech=true;await prepare(waiting);assert.equal((await run(waiting)).state,'completed');
    const next=await capture('A text after the transcript',7);await prepare(next);assert.equal((await run(next)).state,'completed');
    assert.equal(started.at(-1).event_id,next);assert.equal(started.at(-1).untranscribed_voice,undefined,'an answered voice note is no longer reported');
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

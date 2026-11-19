import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest,type Envelope} from '../src/archive.js';
import {connectStores,initializeStoreDatabases,type StorePasswords} from '../src/stores/connections.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {DerivedRepository} from '../src/stores/derived.js';
import {GuardRepository} from '../src/stores/guards.js';
import {SelectionRepository} from '../src/stores/selections.js';
import {ReprocessingRepository,RECORDINGS,VOICE_ARCHIVED,documentExtraction,voiceTranscription} from '../src/stores/reprocessing.js';
import {AttachmentRepository} from '../src/stores/attachments.js';
import {PreparationRepository} from '../src/stores/preparation.js';
import {CaptureCoordinator} from '../src/stores/capture.js';
import {SourcePortabilityRepository} from '../src/stores/source-portability.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {installChatsForTest} from '../src/chats.js';
import {policyDirectory} from './fixture-groups.js';
import {grantMembers} from './fixture-member-grants.js';

test('voice notes go to the runtime transcriber; a busy provider is retried and other failures become a status', async () => {
  const calls:Record<string,unknown>[]=[];let answer:Record<string,unknown>={state:'done',text:'Synthetic note about the garden club'};
  const engine=voiceTranscription(async(operation,input)=>{assert.equal(operation,'voice.transcribe');calls.push(input);return answer;});
  const audio=Buffer.from('synthetic Ogg bytes');
  assert.equal(await engine.run(audio,{kind:'voice',metadata:{mime_type:'audio/ogg',duration:14}},{}),'Synthetic note about the garden club');
  assert.deepEqual(calls[0],{bytes_base64:audio.toString('base64'),name:'',mime_type:'audio/ogg',kind:'voice',duration:14});
  await engine.run(audio,{kind:'voice_message',metadata:{relative_path:'voice_messages/audio_1.ogg'}},{});
  assert.deepEqual(calls[1],{bytes_base64:audio.toString('base64'),name:'voice_messages/audio_1.ogg',mime_type:'',kind:'voice_message'});
  for(const reason of ['rate_limited','provider_error','timed_out']) {
    answer={state:'failed',reason};
    await assert.rejects(engine.run(audio,{kind:'voice',metadata:{}},{}),{code:'transcription_unavailable'},reason);
  }
  const status=async(value:Record<string,unknown>)=>{answer=value;return engine.run(audio,{kind:'voice',metadata:{}},{});};
  assert.deepEqual(await status({state:'not_configured'}),{kind:'extraction_status',text:VOICE_ARCHIVED},'without a key the note is archived only');
  assert.deepEqual(await status({state:'failed',reason:'key_rejected'}),{kind:'extraction_status',text:'This recording could not be transcribed; its original audio is kept.'});
  assert.deepEqual(await status({state:'silent'}),{kind:'extraction_status',text:'This recording has no speech to transcribe; its original audio is kept.'});
  assert.deepEqual(await status({state:'done',text:''}),{kind:'extraction_status',text:'This recording could not be transcribed; its original audio is kept.'});
  await assert.rejects(engine.run(audio,{kind:'voice',metadata:{}},{language:'fa'}),{code:'unsupported_transcription_configuration'});
  for(const kind of ['voice','audio','video_note','voice_message','audio_file','video_message'])assert.ok(RECORDINGS.includes(kind),kind);
});

test('a recording is transcribed whole, and a part is never asked for',async()=>{
  const calls:Record<string,unknown>[]=[];
  const engine=voiceTranscription(async(_operation,input)=>{calls.push(input);return {state:'done',text:'Synthetic note: bring the folding chairs',cut:true};});
  const audio=Buffer.from('synthetic Ogg bytes');
  assert.equal(await engine.run(audio,{kind:'voice',metadata:{mime_type:'audio/ogg',duration:5}},{}),'Synthetic note: bring the folding chairs',
    'no note, whatever the runtime says');
  assert.deepEqual(calls[0],{bytes_base64:audio.toString('base64'),name:'',mime_type:'audio/ogg',kind:'voice',duration:5},'the stated length is a hint only');
  for(const configuration of [{first_seconds:900},{seconds:900}] as Record<string,unknown>[])
    await assert.rejects(engine.run(audio,{kind:'voice',metadata:{}},configuration),{code:'unsupported_transcription_configuration'},JSON.stringify(configuration));
  assert.equal(calls.length,1,'a configuration it does not take never reaches the runtime');
});

test('voice notes saved before a transcription key are transcribed once one is added, each once',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),derived=new DerivedRepository(stores.derived,archive);
  const guards=new GuardRepository(stores,archive),selections=new SelectionRepository(stores,guards),capture=new CaptureCoordinator(archive,stores.control);
  const root=await mkdtemp(join(tmpdir(),'nocheh-voice-')),attachments=new AttachmentRepository(stores,archive,root),key='voice-backfill:'+Date.now();
  let configured=false,transcribed=0;
  const transcription=voiceTranscription(async(_operation,input)=>{
    if(input.check)return {configured};
    if(!configured)return {state:'not_configured'};
    transcribed++;return {state:'done',text:'Synthetic note: water the garden'};
  });
  const reprocessing=new ReprocessingRepository(stores,archive,derived,guards,root,[transcription,documentExtraction(async()=>({state:'unsupported'}))]);
  const preparation=new PreparationRepository(attachments,reprocessing,guards,selections,transcription,documentExtraction(async()=>({state:'unsupported'}))),authority={owner:'inngest' as const,epoch:1};
  const check=async()=>configured;
  const fetch=async()=>Buffer.from('synthetic Ogg bytes');
  const event:Envelope={version:1,key,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'123',source_id:key,revision:'1',occurred_at:null,text:null,
    payload:{message:{chat:{id:123,type:'private'},voice:{file_id:'voice',duration:3}}}};
  try {
    await guards.reconcile();await selections.reconcile();await guards.setMode('on');
    const voice=(await capture.capture(event)).source;
    assert.equal((await preparation.run(voice.reference.id,fetch,'fixture',async()=>[],authority)).state,'completed','the reply does not wait without a key');
    const file=await attachments.file(voice.artifact_ids[0]!);
    assert.equal(((await selections.current(file.event.id,file.id,'extraction_status',await guards.state())).value as any).text,VOICE_ARCHIVED);
    assert.equal(await preparation.transcribeArchived(check),0,'nothing is asked of the provider while it has no key');
    configured=true;
    assert.equal(await preparation.transcribeArchived(check),1);
    const job=(await stores.control.query('SELECT id FROM reprocess_jobs WHERE id=$1',[digest('reprocess:voice:'+file.id+':'+digest('runtime-voice:1'))])).rows[0];
    assert.ok(job,'one transcription is requested for the archived note');
    assert.ok(await reprocessing.run(job.id,'fixture',async()=>[],authority));
    assert.equal(transcribed,1);
    assert.equal(await preparation.transcribeArchived(check),0,'a note is requested once');
    assert.equal(((await selections.current(file.event.id,file.id,'transcript',await guards.state())).value as any).text,'Synthetic note: water the garden');
    assert.equal(await preparation.transcribeArchived(async()=>{throw new Error('the runtime is not asked again');}),0,'a transcribed note is no longer archived');
    assert.equal(transcribed,1);
  } finally {await stores.archive.end();await stores.derived.end();await stores.control.end();await rm(root,{recursive:true,force:true});}
});

test('every recording is transcribed whole, whoever sent it: someone not allowed, the owner, a member, an import and a restore',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),derived=new DerivedRepository(stores.derived,archive);
  const guards=new GuardRepository(stores,archive),selections=new SelectionRepository(stores,guards),capture=new CaptureCoordinator(archive,stores.control);
  const root=await mkdtemp(join(tmpdir(),'nocheh-voice-whole-')),attachments=new AttachmentRepository(stores,archive,root),key='voice-whole:'+Date.now();
  // 456 is a member who talks in the group; 789 is someone the owner has not allowed (ADR-0264: read whole all the same).
  const served:AssistantPolicy={enabled:true,owner_id:'123',group_ids:['-20']};
  const people=grantMembers({'-20':{granted:['456']}},{owner:'123'});
  installChatsForTest(policyDirectory(served));
  let configured=true;const asked:Record<string,unknown>[]=[];
  const transcription=voiceTranscription(async(_operation,input)=>{
    if(input.check)return {configured};
    if(!configured)return {state:'not_configured'};
    asked.push(input);
    return {state:'done',text:'Synthetic note: bring the folding chairs'};
  });
  const extraction=documentExtraction(async()=>({state:'unsupported'}));
  const reprocessing=new ReprocessingRepository(stores,archive,derived,guards,root,[transcription,extraction]);
  const preparation=new PreparationRepository(attachments,reprocessing,guards,selections,transcription,extraction),authority={owner:'inngest' as const,epoch:1};
  const portability=new SourcePortabilityRepository(capture,attachments),owner={admin:true,scope:null};
  const bytes=Buffer.from('synthetic Ogg bytes'),fetch=async()=>bytes,group={id:-20,type:'supergroup',title:'Synthetic Garden Club'};
  const person=(id:number)=>({id,is_bot:false,first_name:'Synthetic '+id});
  let count=0;
  /** A voice note in a message; Telegram says it lasts five seconds. */
  const voice=(message:Record<string,unknown>,origin:'live'|'import'='live'):Envelope=>{
    const name=key+':'+(++count),chat=message.chat as {id:number};
    return {version:1,key:name,origin,bot_id:'fixture',kind:'telegram_update',scope:String(chat.id),source_id:name,revision:'1',occurred_at:null,text:null,
      payload:{update_id:count,message:{message_id:count,date:1,...message,voice:{file_id:name,file_unique_id:'u'+count,duration:5,mime_type:'audio/ogg'}}}};
  };
  const configuration=async(artifact:string,kind='initial')=>(await stores.control.query('SELECT configuration FROM reprocess_jobs WHERE id=$1',
    [digest('reprocess:'+kind+':'+artifact+':'+digest('runtime-voice:1'))])).rows[0]?.configuration;
  /** Prepares one captured note and returns what its transcription was asked for and what the transcript says. */
  const prepare=async(id:string)=>{
    asked.length=0;
    assert.equal((await preparation.run(id,fetch,'fixture',async()=>[],authority)).state,'completed');
    const artifact=(await archive.captured(id)).artifact_ids[0]!;
    const transcript=((await selections.current(id,artifact,'transcript',await guards.state())).value as any).text as string;
    return {configuration:await configuration(artifact),runtime:asked.map(input=>input.first_seconds),transcript};
  };
  const whole={configuration:{},runtime:[undefined],transcript:'Synthetic note: bring the folding chairs'};
  try {
    await guards.reconcile();await selections.reconcile();await guards.setMode('on');
    for(const [label,message] of [['someone not allowed in the group',{chat:group,from:person(789)}],
      ['an anonymous admin',{chat:group,from:{id:1000001,is_bot:true,first_name:'Group'},sender_chat:group}],
      ['a post in a channel\'s name',{chat:group,from:{id:1000002,is_bot:true,first_name:'Channel'},sender_chat:{id:-1005,type:'channel',title:'Synthetic Channel'}}],
      ['the owner in the group',{chat:group,from:person(123)}],['a member',{chat:group,from:person(456)}],
      ['the owner in private',{chat:{id:123,type:'private'},from:person(123)}]] as const)
      assert.deepEqual(await prepare((await capture.capture(voice(message))).source.reference.id),whole,label);
    const imported=(await capture.capture(voice({chat:group,from:person(789)},'import'))).source;
    await attachments.commit(imported.artifact_ids[0]!,bytes);
    assert.deepEqual(await prepare(imported.reference.id),whole,'an imported recording');
    const original=voice({chat:group,from:person(789)}),id=digest(original.key),message=(original.payload as any).message;
    await portability.import(owner,{event:original,artifacts:[{source_ref:message.voice.file_id,kind:'voice',metadata:message.voice}]});
    await attachments.commit(digest(id+':'+message.voice.file_id),bytes);
    assert.deepEqual(await prepare(id),whole,'a recording restored from an export');
    // Voice notes archived while no provider was chosen are transcribed whole later, too.
    configured=false;
    const waiting=(await capture.capture(voice({chat:group,from:person(789)}))).source;
    assert.equal((await preparation.run(waiting.reference.id,fetch,'fixture',async()=>[],authority)).state,'completed');
    assert.equal(((await selections.current(waiting.reference.id,waiting.artifact_ids[0]!,'extraction_status',await guards.state())).value as any).text,VOICE_ARCHIVED);
    configured=true;
    await preparation.transcribeArchived(async()=>configured,500);
    assert.deepEqual(await configuration(waiting.artifact_ids[0]!,'voice'),{});
  } finally {people();await stores.archive.end();await stores.derived.end();await stores.control.end();await rm(root,{recursive:true,force:true});}
});

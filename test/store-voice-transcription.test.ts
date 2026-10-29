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
import {ReprocessingRepository,RECORDINGS,VOICE_ARCHIVED,textExtraction,voiceTranscription} from '../src/stores/reprocessing.js';
import {AttachmentRepository} from '../src/stores/attachments.js';
import {PreparationRepository} from '../src/stores/preparation.js';
import {CaptureCoordinator} from '../src/stores/capture.js';

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
  const reprocessing=new ReprocessingRepository(stores,archive,derived,guards,root,[transcription,textExtraction()]);
  const preparation=new PreparationRepository(attachments,reprocessing,guards,selections,transcription,textExtraction()),authority={owner:'inngest' as const,epoch:1};
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

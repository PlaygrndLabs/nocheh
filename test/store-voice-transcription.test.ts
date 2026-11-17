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
import {ReprocessingRepository,RECORDINGS,VOICE_ARCHIVED,VOICE_LIMIT_SECONDS,documentExtraction,voiceTranscription} from '../src/stores/reprocessing.js';
import {AttachmentRepository} from '../src/stores/attachments.js';
import {PreparationRepository} from '../src/stores/preparation.js';
import {CaptureCoordinator} from '../src/stores/capture.js';
import {SourcePortabilityRepository} from '../src/stores/source-portability.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {installChatsForTest} from '../src/chats.js';
import {BOB,GP1,GP_GROUP_IDS,NG1,NG1_TG,NG2,NG2_OLD_TG,NG2_TG,NG_GROUP_IDS,OWNER,fixtureDirectory,policyDirectory} from './fixture-groups.js';
import {grantMembers,type GrantOptions,type GroupGrants} from './fixture-member-grants.js';

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

test('a transcription of only the first part of a recording asks the runtime to cut it, and says so when the recording went on',async()=>{
  const calls:Record<string,unknown>[]=[];let answer:Record<string,unknown>={state:'done',text:'Synthetic note: bring the folding chairs',cut:true};
  const engine=voiceTranscription(async(_operation,input)=>{calls.push(input);return answer;});
  const audio=Buffer.from('synthetic Ogg bytes'),limit={first_seconds:VOICE_LIMIT_SECONDS};
  assert.equal(VOICE_LIMIT_SECONDS,900);
  assert.equal(await engine.run(audio,{kind:'voice',metadata:{mime_type:'audio/ogg',duration:5}},limit),
    'Synthetic note: bring the folding chairs\n\n[Only the first 15 minutes of this recording were transcribed; its original audio is kept.]');
  assert.deepEqual(calls[0],{bytes_base64:audio.toString('base64'),name:'',mime_type:'audio/ogg',kind:'voice',duration:5,first_seconds:900},
    'the stated length is passed as a hint only, next to the part to transcribe');
  answer={state:'done',text:'Synthetic note: short and whole'};
  assert.equal(await engine.run(audio,{kind:'voice',metadata:{}},limit),'Synthetic note: short and whole','a recording shorter than the part gets no note');
  answer={state:'done',text:'Synthetic note',cut:true};
  assert.equal(await engine.run(audio,{kind:'voice',metadata:{}},{}),'Synthetic note','without a part asked for, the runtime cannot add the note');
  assert.equal(calls.at(-1)!.first_seconds,undefined);
  assert.equal(await engine.run(audio,{kind:'voice',metadata:{}},{first_seconds:60}),'Synthetic note\n\n[Only the first minute of this recording was transcribed; its original audio is kept.]');
  assert.equal(await engine.run(audio,{kind:'voice',metadata:{}},{first_seconds:90}),'Synthetic note\n\n[Only the first 90 seconds of this recording were transcribed; its original audio is kept.]');
  answer={state:'silent',cut:true};
  assert.deepEqual(await engine.run(audio,{kind:'voice',metadata:{}},limit),
    {kind:'extraction_status',text:'This recording has no speech in its first 15 minutes, the only part transcribed; its original audio is kept.'},
    'a silent first part never reads as a recording with no speech');
  answer={state:'silent'};
  assert.deepEqual(await engine.run(audio,{kind:'voice',metadata:{}},limit),{kind:'extraction_status',text:'This recording has no speech to transcribe; its original audio is kept.'});
  answer={state:'failed',reason:'nocheh_error'};
  assert.deepEqual(await engine.run(audio,{kind:'voice',metadata:{}},limit),{kind:'extraction_status',text:'This recording could not be transcribed; its original audio is kept.'},
    'a cut that fails is a failure to tell the owner about, not a retry');
  answer={state:'failed',reason:'rate_limited'};
  await assert.rejects(engine.run(audio,{kind:'voice',metadata:{}},limit),{code:'transcription_unavailable'});
  const count=calls.length;
  for(const configuration of [{first_seconds:0},{first_seconds:86401},{first_seconds:1.5},{first_seconds:'900'},{first_seconds:true},{first_seconds:null},
    {first_seconds:900,language:'fa'},{seconds:900}] as Record<string,unknown>[])
    await assert.rejects(engine.run(audio,{kind:'voice',metadata:{}},configuration),{code:'unsupported_transcription_configuration'},JSON.stringify(configuration));
  assert.equal(calls.length,count,'a configuration it does not take never reaches the runtime');
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
  const preparation=new PreparationRepository(attachments,reprocessing,guards,selections,transcription,documentExtraction(async()=>({state:'unsupported'})),
    ()=>({enabled:false,owner_id:null,group_ids:[]})),authority={owner:'inngest' as const,epoch:1};
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

test('a live recording from someone not allowed is transcribed up to 15 minutes; the owner\'s, members\', imported and restored ones in full',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),derived=new DerivedRepository(stores.derived,archive);
  const guards=new GuardRepository(stores,archive),selections=new SelectionRepository(stores,guards),capture=new CaptureCoordinator(archive,stores.control);
  const root=await mkdtemp(join(tmpdir(),'nocheh-voice-limit-')),attachments=new AttachmentRepository(stores,archive,root),key='voice-limit:'+Date.now();
  const served:AssistantPolicy={enabled:true,owner_id:'123',group_ids:['-20']};
  // The owner's members (step 3): 456 talks in the group; a test changes them as the owner would.
  let people=grantMembers({'-20':{granted:['456']}},{owner:'123'});
  const members=(grants:GroupGrants,options:GrantOptions={})=>{people();people=grantMembers(grants,{owner:'123',...options});};
  // The chats these notes come from, as the seeder makes their rows for values stored before step 2b (ADR-0252).
  installChatsForTest(policyDirectory(served));
  let policy=served,configured=true,busy=false;const asked:Record<string,unknown>[]=[];
  const transcription=voiceTranscription(async(_operation,input)=>{
    if(input.check)return {configured};
    if(!configured)return {state:'not_configured'};
    asked.push(input);
    if(busy)return {state:'failed',reason:'rate_limited'};
    return {state:'done',text:'Synthetic note: bring the folding chairs',...(input.first_seconds===undefined?{}:{cut:true})};
  });
  const extraction=documentExtraction(async()=>({state:'unsupported'}));
  const reprocessing=new ReprocessingRepository(stores,archive,derived,guards,root,[transcription,extraction]);
  const preparation=new PreparationRepository(attachments,reprocessing,guards,selections,transcription,extraction,()=>policy),authority={owner:'inngest' as const,epoch:1};
  const portability=new SourcePortabilityRepository(capture,attachments),owner={admin:true,scope:null};
  const bytes=Buffer.from('synthetic Ogg bytes'),fetch=async()=>bytes,group={id:-20,type:'supergroup',title:'Synthetic Garden Club'};
  const person=(id:number)=>({id,is_bot:false,first_name:'Synthetic '+id});
  let count=0;
  /** A voice note in a message, or in an edit of one; Telegram says it lasts five seconds. */
  const voice=(message:Record<string,unknown>,origin:'live'|'import'='live',update:'message'|'edited_message'='message'):Envelope=>{
    const name=key+':'+(++count),chat=message.chat as {id:number};
    return {version:1,key:name,origin,bot_id:'fixture',kind:'telegram_update',scope:String(chat.id),source_id:name,revision:'1',occurred_at:null,text:null,
      payload:{update_id:count,[update]:{message_id:count,date:1,...message,voice:{file_id:name,file_unique_id:'u'+count,duration:5,mime_type:'audio/ogg'}}}};
  };
  const operation=(artifact:string)=>'initial:'+artifact+':'+digest('runtime-voice:1');
  const configuration=async(artifact:string,kind='initial')=>(await stores.control.query('SELECT configuration FROM reprocess_jobs WHERE id=$1',
    [digest('reprocess:'+(kind==='initial'?operation(artifact):'voice:'+artifact+':'+digest('runtime-voice:1')))])).rows[0]?.configuration;
  /** Prepares one captured note and returns what its transcription was asked for and what the transcript says. */
  const prepare=async(id:string)=>{
    asked.length=0;
    assert.equal((await preparation.run(id,fetch,'fixture',async()=>[],authority)).state,'completed');
    const artifact=(await archive.captured(id)).artifact_ids[0]!,file=await attachments.file(artifact);
    const transcript=((await selections.current(id,artifact,'transcript',await guards.state())).value as any).text as string;
    return {configuration:await configuration(artifact),runtime:asked.map(input=>input.first_seconds),transcript,file};
  };
  const live=async(message:Record<string,unknown>,update:'message'|'edited_message'='message')=>prepare((await capture.capture(voice(message,'live',update))).source.reference.id);
  const cut={first_seconds:VOICE_LIMIT_SECONDS},note='[Only the first 15 minutes of this recording were transcribed; its original audio is kept.]';
  try {
    await guards.reconcile();await selections.reconcile();await guards.setMode('on');
    const stranger=await live({chat:group,from:person(789)});
    assert.deepEqual(stranger.configuration,cut,'someone not allowed in the group');
    assert.deepEqual(stranger.runtime,[900]);
    assert.ok(stranger.transcript.endsWith('\n\n'+note),stranger.transcript);
    const anonymous=await live({chat:group,from:{id:1000001,is_bot:true,first_name:'Group'},sender_chat:group});
    assert.deepEqual(anonymous.configuration,cut,'an anonymous admin, who may be the owner but cannot be told apart');
    const channel=await live({chat:group,from:{id:1000002,is_bot:true,first_name:'Channel'},sender_chat:{id:-1005,type:'channel',title:'Synthetic Channel'}});
    assert.deepEqual(channel.configuration,cut,'a post in a channel\'s name');
    for(const [label,message,update] of [['the owner in the group',{chat:group,from:person(123)},'message'],['a member',{chat:group,from:person(456)},'message'],
      ['the owner\'s edited message',{chat:group,from:person(123),edit_date:2},'edited_message'],
      ['the owner in private',{chat:{id:123,type:'private'},from:person(123)},'message']] as const) {
      const found=await live(message,update);
      assert.deepEqual(found.configuration,{},label);assert.deepEqual(found.runtime,[undefined],label);
      assert.equal(found.transcript,'Synthetic note: bring the folding chairs',label);
    }
    policy={...served,enabled:false};
    assert.deepEqual((await live({chat:group,from:person(789)})).configuration,{},'Telegram replies are off');
    policy={enabled:false,owner_id:null,group_ids:['-20']};
    assert.deepEqual((await live({chat:group,from:person(789)})).configuration,{},'no owner is set, as on a fresh installation');
    policy=served;
    const imported=(await capture.capture(voice({chat:group,from:person(789)},'import'))).source;
    await attachments.commit(imported.artifact_ids[0]!,bytes);
    assert.deepEqual((await prepare(imported.reference.id)).configuration,{},'an imported recording');
    const original=voice({chat:group,from:person(789)}),id=digest(original.key),message=(original.payload as any).message;
    await portability.import(owner,{event:original,artifacts:[{source_ref:message.voice.file_id,kind:'voice',metadata:message.voice}]});
    await attachments.commit(digest(id+':'+message.voice.file_id),bytes);
    assert.deepEqual((await prepare(id)).configuration,{},'a live recording restored from an export, never captured here');
    // A provider that is busy fails the first try; a new member before the next try changes nothing about that transcription.
    busy=true;
    const retried=(await capture.capture(voice({chat:group,from:person(789)}))).source;
    await assert.rejects(preparation.run(retried.reference.id,fetch,'fixture',async()=>[],authority),{code:'transcription_unavailable'});
    members({'-20':{granted:['456','789']}});busy=false;
    const again=await prepare(retried.reference.id);
    assert.deepEqual(again.configuration,cut);assert.deepEqual(again.runtime,[900],'the next try asks for the same part, without an identity conflict');
    // Voice notes archived while no provider was chosen get the same rule when they are transcribed later.
    members({'-20':{granted:['456']}});configured=false;
    const waiting=[await capture.capture(voice({chat:group,from:person(789)})),await capture.capture(voice({chat:group,from:person(456)}))].map(found=>found.source);
    for(const source of waiting) {
      assert.equal((await preparation.run(source.reference.id,fetch,'fixture',async()=>[],authority)).state,'completed');
      assert.equal(((await selections.current(source.reference.id,source.artifact_ids[0]!,'extraction_status',await guards.state())).value as any).text,VOICE_ARCHIVED);
    }
    configured=true;
    await preparation.transcribeArchived(async()=>configured,500);
    assert.deepEqual(await configuration(waiting[0]!.artifact_ids[0]!,'voice'),cut,'someone not allowed');
    assert.deepEqual(await configuration(waiting[1]!.artifact_ids[0]!,'voice'),{},'a member');
    asked.length=0;
    const job=digest('reprocess:voice:'+waiting[0]!.artifact_ids[0]!+':'+digest('runtime-voice:1'));
    assert.ok(await reprocessing.run(job,'fixture',async()=>[],authority));
    assert.deepEqual(asked.map(input=>input.first_seconds),[900]);
    // The whole recording stays readable: a new reading from the dashboard asks for no part.
    asked.length=0;
    const full=await reprocessing.request(stranger.file,'runtime-voice','1',{},'dashboard:'+key);
    const reading=await reprocessing.run(full,'fixture',async()=>[],authority);
    assert.ok(reading);assert.deepEqual(asked.map(input=>input.first_seconds),[undefined]);
    assert.equal((await stores.derived.query('SELECT convert_from(content,\'UTF8\') AS text FROM derived_artifacts WHERE id=$1',[reading.id])).rows[0].text,
      'Synthetic note: bring the folding chairs');

    // The same rule in the chat the directory finds (ADR-0252): a member in NG2, the group Telegram upgraded, is read
    // whole under its old and its new id; someone not a member, a member switched off in that group, and anyone in a
    // group the directory has no row for, even one the policy lists, are cut.
    const stray='-1009999999999';
    installChatsForTest(fixtureDirectory([...GP_GROUP_IDS,...NG_GROUP_IDS]));
    policy={enabled:true,owner_id:OWNER,owner_chat:OWNER,group_ids:[...GP_GROUP_IDS,...NG_GROUP_IDS,stray]};
    members({[NG2]:{granted:[BOB]},[GP1]:{granted:[BOB]}},{owner:OWNER,groups:[NG1]});
    const team=(chat:string)=>({id:Number(chat),type:'supergroup',title:'Synthetic Team'});
    const cases:[string,string,number,Record<string,unknown>][]=[
      ['a member in an upgraded group, under its new id',NG2_TG,Number(BOB),{}],
      ['a member in an upgraded group, under its old id',NG2_OLD_TG,Number(BOB),{}],
      ['a member in an old-shaped group',GP1,Number(BOB),{}],
      ['someone not a member, in an upgraded group',NG2_TG,789,cut],
      ['a member switched off in a digest group',NG1_TG,Number(BOB),cut],
      ['a group the directory does not know',stray,Number(BOB),cut],
      ['the owner, wherever they write',stray,Number(OWNER),{}]];
    for(const [label,chat,from,expected] of cases)assert.deepEqual((await live({chat:team(chat),from:person(from)})).configuration,expected,label);
  } finally {people();await stores.archive.end();await stores.derived.end();await stores.control.end();await rm(root,{recursive:true,force:true});}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest,type Envelope} from '../src/archive.js';
import {connectStores,initializeStoreDatabases,type StorePasswords} from '../src/stores/connections.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {DerivedRepository} from '../src/stores/derived.js';
import {GuardRepository} from '../src/stores/guards.js';
import {SelectionRepository} from '../src/stores/selections.js';
import {ReprocessingRepository,utf8Extraction,type DerivationEngine} from '../src/stores/reprocessing.js';
import {AttachmentRepository} from '../src/stores/attachments.js';
import {PreparationRepository} from '../src/stores/preparation.js';
import {CaptureCoordinator} from '../src/stores/capture.js';

test('preparation keeps manifests immutable and download state in control, with versioned guarded file output',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),derived=new DerivedRepository(stores.derived,archive);
  const guards=new GuardRepository(stores,archive),selections=new SelectionRepository(stores,guards),capture=new CaptureCoordinator(archive,stores.control);
  const root=await mkdtemp(join(tmpdir(),'nocheh-preparation-')),attachments=new AttachmentRepository(stores,archive,root),key='preparation:'+Date.now();
  let stt=0,downloads=0;
  const transcription:DerivationEngine={name:'fixture-asr',version:'1',outputKind:'transcript',async run(bytes){stt++;assert.deepEqual(bytes,Buffer.from([79,103,103,0,255]));return 'Voice result';}};
  const extraction=utf8Extraction(),reprocessing=new ReprocessingRepository(stores,archive,derived,guards,root,[transcription,extraction]);
  const preparation=new PreparationRepository(attachments,reprocessing,guards,selections,transcription,extraction),authority={owner:'inngest' as const,epoch:1};
  const event=(suffix:string,payload:Record<string,unknown>,origin:'live'|'import'='live'):Envelope=>({version:1,key:key+suffix,origin,bot_id:'fixture',
    kind:'telegram_update',scope:'123',source_id:key+suffix,revision:'1',occurred_at:null,text:null,payload:{message:{chat:{id:123,type:'private'},...payload}}});
  try {
    await guards.reconcile();await selections.reconcile();await guards.setMode('on');
    const voice=(await capture.capture(event(':voice',{voice:{file_id:'voice'}}))).source;
    const fetch=async()=>{downloads++;return Buffer.from([79,103,103,0,255]);};
    assert.equal((await preparation.status(voice.reference.id)).stage,'attachments');
    assert.equal((await preparation.run(voice.reference.id,fetch,'fixture',async()=>[],{owner:'inngest',epoch:999999})).waiting_reason,'owner_paused');
    assert.equal(downloads,0);
    assert.equal((await preparation.run(voice.reference.id,fetch,'fixture',async()=>[],authority)).state,'completed');
    assert.equal(stt,1);assert.equal(downloads,1);
    await preparation.run(voice.reference.id,fetch,'fixture',async()=>[],authority);assert.equal(stt,1);assert.equal(downloads,1);
    const file=await attachments.file(voice.artifact_ids[0]!);
    assert.deepEqual(await attachments.bytes(file),Buffer.from([79,103,103,0,255]));
    assert.equal((await stores.control.query('SELECT state,attempts FROM attachment_retrievals WHERE artifact_id=$1',[file.id])).rows[0].state,'done');
    await assert.rejects(stores.archive.query('SELECT state FROM artifacts'),{code:'42703'},'download state is not an original manifest');
    await assert.rejects(attachments.commit(file.id,Buffer.from('changed bytes')),{code:'file_manifest_conflict'});
    const selected=await selections.current(file.event.id,file.id,'transcript',await guards.state());
    await guards.edit('derived_artifacts:'+selected.id,selected.guard_revision,{text:'Owner edited voice',kind:'transcript',provenance:{}},digest(key+':owner'));
    await preparation.run(voice.reference.id,fetch,'fixture',async()=>[],authority);
    assert.equal(((await selections.current(file.event.id,file.id,'transcript',await guards.state())).value as any).text,'Owner edited voice');
    assert.equal(stt,1);

    const document=(await capture.capture(event(':text',{document:{file_id:'text'}}))).source;
    assert.equal((await preparation.run(document.reference.id,async()=>Buffer.from('Exact UTF-8 \r\n متن'),'fixture',async()=>[],authority)).state,'completed');
    assert.equal(((await selections.current(document.reference.id,document.artifact_ids[0]!,'extracted_text',await guards.state())).value as any).text,'Exact UTF-8 \r\n متن');
    const binary=(await capture.capture(event(':binary',{document:{file_id:'binary'}}))).source;
    assert.equal((await preparation.run(binary.reference.id,async()=>Buffer.from([0,1,255]),'fixture',async()=>[],authority)).state,'completed');
    const binaryFile=await attachments.file(binary.artifact_ids[0]!);assert.deepEqual(await readFile(join(root,'files',binaryFile.input_hash)),Buffer.from([0,1,255]));
    assert.ok((await selections.current(binary.reference.id,binary.artifact_ids[0]!,'extraction_status',await guards.state())).value);

    const imported=(await capture.capture(event(':import',{document:{file_id:'desktop:doc'}},'import'))).source;
    assert.equal((await preparation.run(imported.reference.id,async()=>{throw Error('must not fetch imported file');},'fixture',async()=>[],authority)).stage,'attachments');
    await attachments.commit(imported.artifact_ids[0]!,Buffer.from('Uploaded original'));
    assert.equal((await preparation.run(imported.reference.id,fetch,'fixture',async()=>[],authority)).state,'completed');

    const interrupted=(await capture.capture(event(':interrupted',{document:{file_id:'late'}}))).source;
    const dead=new pg.Pool(config);await dead.end();
    await assert.rejects(new AttachmentRepository({...stores,control:dead},archive,root).commit(interrupted.artifact_ids[0]!,Buffer.from('Saved before control receipt')));
    const manifest=await attachments.file(interrupted.artifact_ids[0]!);assert.equal((await attachments.bytes(manifest)).toString(),'Saved before control receipt');
    await preparation.run(interrupted.reference.id,async()=>{throw Error('do not redownload committed file');},'fixture',async()=>[],authority);
    assert.equal((await stores.control.query('SELECT state FROM attachment_retrievals WHERE artifact_id=$1',[manifest.id])).rows[0].state,'done');

    const retry=(await capture.capture(event(':retry',{voice:{file_id:'retry'}}))).source;
    assert.equal((await preparation.run(retry.reference.id,async()=>{throw Error('fixture provider failure');},'fixture',async()=>[],authority)).state,'retryable_failed');
    const job=(await stores.control.query('SELECT attempts,next_attempt FROM attachment_retrievals WHERE artifact_id=$1',[retry.artifact_ids[0]])).rows[0];
    await preparation.run(retry.reference.id,async()=>{throw Error('backoff must prevent this read');},'fixture',async()=>[],authority);
    assert.equal((await stores.control.query('SELECT attempts FROM attachment_retrievals WHERE artifact_id=$1',[retry.artifact_ids[0]])).rows[0].attempts,job.attempts);
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});

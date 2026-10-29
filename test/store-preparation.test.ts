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
import {ReprocessingRepository,textExtraction,type DerivationEngine} from '../src/stores/reprocessing.js';
import {AttachmentRepository} from '../src/stores/attachments.js';
import {PreparationRepository} from '../src/stores/preparation.js';
import {CaptureCoordinator} from '../src/stores/capture.js';
import {HttpError} from '../src/http.js';

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
  let stt=0,downloads=0,quietFailure=false;
  const transcription:DerivationEngine={name:'fixture-asr',version:'1',outputKind:'transcript',async run(bytes){stt++;assert.deepEqual(bytes,Buffer.from([79,103,103,0,255]));if(quietFailure)throw new HttpError(422,'invalid_transcription_response');return 'Voice result';}};
  const extraction=textExtraction(),reprocessing=new ReprocessingRepository(stores,archive,derived,guards,root,[transcription,extraction]);
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

    const quiet=(await capture.capture(event(':quiet',{voice:{file_id:'quiet'}}))).source;
    quietFailure=true;
    await assert.rejects(preparation.run(quiet.reference.id,fetch,'fixture',async()=>[],authority),{code:'invalid_transcription_response'});
    const quietStatus=await preparation.status(quiet.reference.id);
    assert.equal(quietStatus.state,'failed');assert.equal(quietStatus.stage,'transcription');
    assert.equal((await stores.control.query("SELECT error_code FROM reprocess_jobs WHERE producer='fixture-asr' AND state='failed'")).rows[0].error_code,'invalid_transcription_response');
    const attempts=stt;
    assert.equal((await preparation.run(quiet.reference.id,async()=>{throw Error('original must not be fetched again');},'fixture',async()=>[],authority)).state,'failed');
    assert.equal(stt,attempts);
    assert.equal((await stores.derived.query('SELECT count(*)::int AS count FROM derived_artifacts WHERE event_id=$1',[quiet.reference.id])).rows[0].count,0);
    const quietFile=await attachments.file(quiet.artifact_ids[0]!);
    assert.deepEqual(await attachments.bytes(quietFile),Buffer.from([79,103,103,0,255]));

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

    // Telegram never lets a bot download a file over 20 MB, so it settles as a reference and never holds the reply.
    const big=(await capture.capture(event(':big',{document:{file_id:'big',file_size:20*1024*1024+1,file_name:'big.zip'}}))).source;
    assert.equal((await preparation.run(big.reference.id,async()=>{throw Error('an oversized file must not be fetched');},'fixture',async()=>[],authority)).state,'completed');
    assert.deepEqual((await stores.control.query('SELECT state,error_code,attempts FROM attachment_retrievals WHERE artifact_id=$1',[big.artifact_ids[0]])).rows[0],
      {state:'done',error_code:'attachment_too_large',attempts:0});
    assert.deepEqual([...await attachments.tooLarge(big.reference.id)],[big.artifact_ids[0]]);
    const refused=(await capture.capture(event(':refused',{document:{file_id:'refused'}}))).source;
    let refusals=0;
    const refuse=async()=>{refusals++;throw new HttpError(413,'attachment_too_large');};
    assert.equal((await preparation.run(refused.reference.id,refuse,'fixture',async()=>[],authority)).state,'completed');
    assert.equal((await preparation.run(refused.reference.id,refuse,'fixture',async()=>[],authority)).state,'completed');
    assert.equal(refusals,1,'a refused download is never retried');
    assert.deepEqual([...await attachments.tooLarge(retry.reference.id)],[],'an ordinary failure still retries');
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});

test('different events prepare side by side up to the guard-check setting, and one event never twice at once',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),derived=new DerivedRepository(stores.derived,archive);
  const guards=new GuardRepository(stores,archive),selections=new SelectionRepository(stores,guards),capture=new CaptureCoordinator(archive,stores.control);
  const root=await mkdtemp(join(tmpdir(),'nocheh-preparation-')),attachments=new AttachmentRepository(stores,archive,root),key='parallel:'+Date.now();
  const extraction=textExtraction(),reprocessing=new ReprocessingRepository(stores,archive,derived,guards,root,[extraction]);
  const preparation=new PreparationRepository(attachments,reprocessing,guards,selections,extraction,extraction,2),authority={owner:'inngest' as const,epoch:1};
  const event=(suffix:string):Envelope=>({version:1,key:key+suffix,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'123',source_id:key+suffix,
    revision:'1',occurred_at:null,text:null,payload:{message:{chat:{id:123,type:'private'},text:'Synthetic note '+suffix}}});
  let active=0,peak=0,release!:()=>void,bothActive!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{bothActive=resolve;});
  const detect=async()=>{active++;peak=Math.max(peak,active);if(active===2)bothActive();await gate;active--;return [];};
  const fetch=async()=>{throw Error('text messages have no files');};
  try {
    await guards.reconcile();await selections.reconcile();await guards.setMode('on');
    const [first,second,third]=await Promise.all([':a',':b',':c'].map(async suffix=>(await capture.capture(event(suffix))).source.reference.id));
    const running=[first,second].map(id=>preparation.run(id!,fetch,'fixture',detect,authority));
    await started;
    const busy=await preparation.run(third!,fetch,'fixture',detect,authority);
    assert.equal(busy.state,'waiting');assert.equal(busy.waiting_reason,'receipt_pending','a third event waits for a free slot');
    const again=await preparation.run(first!,fetch,'fixture',detect,authority);
    assert.equal(again.waiting_reason,'receipt_pending','the same event is never prepared twice at once');
    release();
    assert.deepEqual((await Promise.all(running)).map(result=>result.state),['completed','completed']);
    assert.equal(peak,2);
    assert.equal((await preparation.run(third!,fetch,'fixture',detect,authority)).state,'completed');
  } finally {release();await stores.close();await rm(root,{recursive:true,force:true});}
});

test('an import checks a page of its messages for secrets in one call, and a message the checker refuses is checked alone',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),derived=new DerivedRepository(stores.derived,archive);
  const guards=new GuardRepository(stores,archive),selections=new SelectionRepository(stores,guards),capture=new CaptureCoordinator(archive,stores.control);
  const root=await mkdtemp(join(tmpdir(),'nocheh-preparation-')),attachments=new AttachmentRepository(stores,archive,root),key='batch:'+Date.now();
  const extraction=textExtraction(),reprocessing=new ReprocessingRepository(stores,archive,derived,guards,root,[extraction]);
  const preparation=new PreparationRepository(attachments,reprocessing,guards,selections,extraction,extraction),authority={owner:'inngest' as const,epoch:1};
  const event=(suffix:string,text:string,origin:'live'|'import'='import'):Envelope=>({version:1,key:key+suffix,origin,bot_id:'fixture',kind:'telegram_update',scope:'123',
    source_id:key+suffix,revision:'1',occurred_at:null,text:null,payload:{message:{chat:{id:123,type:'group'},text}}});
  const calls:{text:string;background:boolean}[]=[];
  const detect=async(text:string,background=false)=>{
    calls.push({text,background});
    // The checker refuses any call that has the refused note together with another note.
    if(text.includes('Refused note')&&/Note \d/.test(text))throw new HttpError(503,'detector_contract_rejected');
    return text.includes('door code 4417')?['4417']:[];
  };
  const fetch=async()=>{throw Error('text messages have no files');};
  const imported=async(job:string,suffix:string,text:string)=>{
    const source=(await capture.capture(event(suffix,text))).source.reference;
    await stores.control.query('INSERT INTO import_sources(job_id,event_id,source_reference) VALUES($1,$2,$3)',[job,source.id,source]);
    return source.id;
  };
  const job=async()=>{
    const id=crypto.randomUUID();
    await stores.control.query("INSERT INTO workflow_imports(id,configuration_hash,review_approved,total) VALUES($1,$2,false,100)",[id,digest(id)]);
    return id;
  };
  const checked=async(id:string)=>(await stores.derived.query("SELECT active_revision FROM guard_sources WHERE id=$1",['events:'+id])).rows[0]?.active_revision!=null;
  try {
    await guards.reconcile();await selections.reconcile();await guards.setMode('on');
    const first=await job(),ids:string[]=[];
    for(let index=0;index<30;index++)ids.push(await imported(first,':'+index,index===7?'Note 7: the door code 4417 is for the side gate':`Note ${index} about the garden`));
    // A message whose own preparation is running is left to it.
    const busy=await stores.control.connect();
    try {
      await busy.query('SELECT pg_advisory_lock(hashtextextended($1,803357))',[ids[29]]);
      assert.equal((await preparation.run(ids[0]!,fetch,'fixture',detect,authority)).state,'completed');
    } finally {await busy.query('SELECT pg_advisory_unlock(hashtextextended($1,803357))',[ids[29]]);busy.release();}
    assert.equal(calls.length,1,'thirty messages share one check');
    assert.equal(calls[0]!.background,true,'old history waits behind checks for replies');
    for(const id of ids.slice(0,29))assert.ok(await checked(id));
    assert.equal(await checked(ids[29]!),false);
    const secret=await guards.read('events:'+ids[7],await guards.state());
    assert.doesNotMatch(JSON.stringify(secret.value),/4417/);
    assert.match(JSON.stringify(secret.value),/side gate/);
    assert.equal((await preparation.run(ids[3]!,fetch,'fixture',detect,authority)).state,'completed');
    assert.equal(calls.length,1,'a message checked with the page needs no call of its own');
    assert.equal((await preparation.run(ids[29]!,fetch,'fixture',detect,authority)).state,'completed');
    assert.equal(calls.length,2);

    const live=(await capture.capture(event(':live','Note 99 sent live','live'))).source.reference.id;
    assert.equal((await preparation.run(live,fetch,'fixture',detect,authority)).state,'completed');
    assert.equal(calls.length,3);assert.equal(calls[2]!.background,false);

    const second=await job(),good=await imported(second,':good','Note 1 for the second import'),refused=await imported(second,':refused','Refused note');
    await imported(second,':other','Note 2 for the second import');
    assert.equal((await preparation.run(good,fetch,'fixture',detect,authority)).state,'completed');
    assert.equal(await checked(refused),false,'the refused message does not block the others');
    assert.equal((await preparation.run(refused,fetch,'fixture',detect,authority)).state,'completed');
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});

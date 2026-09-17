import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest,type Envelope} from '../src/archive.js';
import {storeBytes} from '../src/storage.js';
import {initializeStoreDatabases,connectStores,type StorePasswords} from '../src/stores/connections.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {DerivedRepository} from '../src/stores/derived.js';
import {GuardRepository} from '../src/stores/guards.js';
import {SelectionRepository} from '../src/stores/selections.js';
import {ReprocessingRepository,type DerivationEngine} from '../src/stores/reprocessing.js';

test('original-byte reprocessing preserves both versions, owner guards, selection fences and completion recovery',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}
  finally {await admin.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),derived=new DerivedRepository(stores.derived,archive);
  const guards=new GuardRepository(stores,archive),selections=new SelectionRepository(stores,guards);
  const root=await mkdtemp(join(tmpdir(),'nocheh-reprocess-')),key=`reprocess-fixture:${Date.now()}`,bytes=Buffer.from([79,103,103,83,0,255]);
  let firstCalls=0,secondCalls=0;
  const engines:DerivationEngine[]=[
    {name:'fixture-asr',version:'1',outputKind:'transcript',async run(input){assert.deepEqual(input,bytes);firstCalls++;return 'First reading';}},
    {name:'fixture-asr',version:'2',outputKind:'transcript',async run(input){assert.deepEqual(input,bytes);secondCalls++;return 'More precise reading';}},
  ];
  const reprocess=new ReprocessingRepository(stores,archive,derived,guards,root,engines);
  const authority={owner:'inngest' as const,epoch:1};
  const event:Envelope={version:1,key,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'fixture',source_id:key,revision:'1',occurred_at:null,text:null,
    payload:{message:{voice:{file_id:key}}}};
  try {
    await guards.reconcile();await selections.reconcile();await guards.setMode('on');
    const captured=await archive.capture(event),hash=await storeBytes(root,bytes);
    const file=await archive.attach(captured.source.artifact_ids[0]!,hash,bytes.length);
    const firstJob=await reprocess.request(file,'fixture-asr','1',{},key+':one');
    assert.equal(await reprocess.request(file,'fixture-asr','1',{},key+':one'),firstJob);
    await assert.rejects(reprocess.request(file,'fixture-asr','2',{},key+':one'),{code:'reprocess_identity_conflict'});
    // Guard failure happens after output persistence. Retrying must not rerun STT.
    await assert.rejects(reprocess.run(firstJob,'fixture',async()=>{throw Error('detector unavailable');},authority));
    assert.equal(firstCalls,1);
    const first=await reprocess.run(firstJob,'fixture',async()=>[],authority);assert.ok(first);assert.equal(firstCalls,1);
    assert.deepEqual(await reprocess.run(firstJob,'fixture',async()=>{throw Error('already prepared');},authority),first);
    const initial=await selections.activate(first,null,digest(key+':activate-one'),'automatic');
    const firstBinding=await guards.state();
    assert.equal(((await selections.current(file.event.id,file.id,'transcript',firstBinding)).value as any).text,'First reading');
    const firstGuardId='derived_artifacts:'+first.id;
    const firstGuard=(await guards.read(firstGuardId,firstBinding)).revision!;
    const ownerValue={text:'Owner-corrected first reading',kind:'transcript',provenance:{note:'synthetic correction'}};
    await guards.edit(firstGuardId,firstGuard,ownerValue,digest(key+':guard-owner'));

    const secondJob=await reprocess.request(file,'fixture-asr','2',{},key+':two');
    const second=await reprocess.run(secondJob,'fixture',async()=>[],authority);assert.ok(second);assert.equal(secondCalls,1);
    assert.equal(((await selections.current(file.event.id,file.id,'transcript',await guards.state())).value as any).text,ownerValue.text,
      'creating a newer result does not silently activate it');
    await assert.rejects(selections.activate(second,initial.revision,digest(key+':automatic-replace'),'automatic'),{code:'owner_activation_required'});
    const stale=await guards.state(),secondSelection=await selections.activate(second,initial.revision,digest(key+':activate-two'));
    await assert.rejects(selections.activate(first,initial.revision,digest(key+':stale-selection')),{code:'derivative_selection_conflict'});
    await assert.rejects(selections.current(file.event.id,file.id,'transcript',stale),{code:'guard_context_changed'});
    assert.equal(((await selections.current(file.event.id,file.id,'transcript',await guards.state())).value as any).text,'More precise reading');
    assert.equal(((await guards.read(firstGuardId,await guards.state())).value as any).text,ownerValue.text,'old owner edits remain intact');
    assert.notEqual(((await guards.read('derived_artifacts:'+second.id,await guards.state())).value as any).text,ownerValue.text);
    const versions=await selections.versions(file.event.id);assert.equal(versions.versions.length,2);
    assert.equal(versions.versions.filter(version=>version.active).length,1);
    assert.equal(versions.versions.find(version=>version.active).id,second.id);
    assert.ok(versions.versions.every(version=>version.input_hash===hash));

    const unprepared=await derived.record({operation_id:key+':unprepared',source:file.event,file,kind:'transcript',content:Buffer.from('Third result'),
      producer:'fixture-asr',producer_version:'3',configuration:{}});
    await assert.rejects(selections.activate(unprepared,secondSelection.revision,digest(key+':unprepared-selection')),{code:'guard_preparation_pending'});
    const interrupted=new SelectionRepository(stores,guards);interrupted.finish=async()=>{throw Error('injected-selection-interruption');};
    await assert.rejects(interrupted.activate(first,secondSelection.revision,digest(key+':restore-one')),/injected-selection-interruption/);
    await assert.rejects(guards.state(),{code:'guard_transition_pending'});
    assert.equal(await guards.reconcile(),0,'guard reconciler leaves selection operations to their owner');
    assert.ok(await selections.reconcile()>0);
    assert.equal(((await selections.current(file.event.id,file.id,'transcript',await guards.state())).value as any).text,ownerValue.text);
    assert.deepEqual(await readFile(join(root,'files',hash)),bytes);
    const source=(await stores.archive.query('SELECT payload_hash FROM events WHERE id=$1',[file.event.id])).rows[0];
    assert.equal(source.payload_hash,file.event.input_hash);
    const jobs=(await stores.control.query('SELECT state FROM reprocess_jobs WHERE id=ANY($1::text[])',[[firstJob,secondJob]])).rows;
    assert.ok(jobs.every(job=>job.state==='done'));
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});

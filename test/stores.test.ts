import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest,canonical,type Envelope} from '../src/archive.js';
import {immutableFile,storeBytes} from '../src/storage.js';
import {connectStores,initializeStoreDatabases,storeNames,type StorePasswords} from '../src/stores/connections.js';
import {ArchiveRepository,originalEnvelope} from '../src/stores/archive.js';
import {DerivedRepository} from '../src/stores/derived.js';
import {CaptureCoordinator,drainSourceSpool} from '../src/stores/capture.js';

const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
const event=(id:string):Envelope=>({version:1,key:`three-store-fixture:${id}`,origin:'live',bot_id:'fixture',kind:'telegram_update',
  scope:'fixture-group',source_id:id,revision:id,occurred_at:'1700000000',text:'Original\0\r\n 😃',
  payload:{message:{message_id:id,chat:{id:'fixture-group'},text:'Original\0\r\n 😃',voice:{file_id:`voice-${id}`}}}});

test('original archive rejects runtime, generated, schedule and transcript envelopes',()=>{
  for(const kind of ['runtime_context','transcript','extracted_text','shared_knowledge','outbound_intent','outbound_result','schedule_definition','schedule_fire'])
    assert.throws(()=>originalEnvelope({...event('1'),kind}),{code:'original_source_required'});
  assert.throws(()=>originalEnvelope({...event('1'),origin:'generated'}),{code:'original_source_required'});
  assert.throws(()=>originalEnvelope({...event('1'),channel:'scheduler'}),{code:'original_source_required'});
  assert.deepEqual(originalEnvelope(event('1')),event('1'));
  assert.throws(()=>connectStores({}, {...passwords,control:passwords.derived}),/store_credentials_must_differ/);
});

test('three real databases preserve originals, isolate roles, recover capture and retain versioned outputs',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  assert.equal(process.env.PGDATABASE,'nocheh');
  const adminConfig:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const admin=new pg.Pool(adminConfig),root=await mkdtemp(join(tmpdir(),'nocheh-stores-'));
  let stores:ReturnType<typeof connectStores>|undefined;
  try {
    assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture',
      'destructive fixture cleanup requires the dedicated PostgreSQL cluster marker');
    // This destructive test is opt-in and confined to its own Compose project.
    for(const name of storeNames)await admin.query(`DROP DATABASE IF EXISTS nocheh_${name} WITH (FORCE)`);
    await initializeStoreDatabases(adminConfig,passwords);
    stores=connectStores(adminConfig,passwords);
    const generation=(await stores.control.query('SELECT generation FROM installation')).rows[0].generation;
    const archive=new ArchiveRepository(stores.archive),derived=new DerivedRepository(stores.derived,archive);
    const coordinator=new CaptureCoordinator(archive,stores.control);

    for(const name of storeNames) {
      assert.equal((await stores[name].query('SELECT current_database() AS name')).rows[0].name,`nocheh_${name}`);
      await assert.rejects(stores[name].query('CREATE TABLE unexpected(value text)'),{code:'42501'});
      for(const other of storeNames.filter(other=>other!==name)) {
        const crossed=new pg.Client({...adminConfig,user:`nocheh_${name}`,password:passwords[name],database:`nocheh_${other}`});
        try {await assert.rejects(crossed.connect(),{code:'42501'});} finally {await crossed.end();}
      }
    }
    const tables=(await stores.archive.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row=>row.tablename);
    assert.deepEqual(tables,['artifacts','events','source_model_migrations','source_objects','source_observations','source_relations','source_revisions']);
    await assert.rejects(stores.archive.query('SELECT * FROM derived_artifacts'),{code:'42P01'});
    await assert.rejects(stores.archive.query('SELECT * FROM workflow_registry'),{code:'42P01'});

    const first=await coordinator.capture(event('first'));
    assert.equal(first.duplicate,false);
    const original=(await stores.archive.query('SELECT original_text,payload FROM events WHERE id=$1',[first.source.reference.id])).rows[0];
    assert.equal(original.original_text.toString(),event('first').text);
    assert.deepEqual(JSON.parse(original.payload.toString()),event('first').payload);
    await assert.rejects(stores.archive.query('UPDATE events SET original_text=$1',[Buffer.from('changed')]),{code:'42501'});
    await assert.rejects(stores.archive.query('DELETE FROM events'),{code:'42501'});
    await assert.rejects(stores.archive.query(`INSERT INTO events(id,source_key,channel,bot_id,scope,source_id,revision,origin,kind,payload,payload_hash)
      VALUES('forbidden','forbidden','telegram','fixture','fixture','fixture','1','live','transcript',$1,'fixture')`,[Buffer.from('{}')]),{code:'23514'},'database constraints also reject generated kinds');
    const duplicates=await Promise.all([coordinator.capture(event('first')),coordinator.capture(event('first'))]);
    assert.ok(duplicates.every(value=>value.duplicate));
    assert.equal((await stores.control.query('SELECT count(*) FROM workflow_registry')).rows[0].count,'3');
    await assert.rejects(coordinator.capture({...event('first'),text:'changed'}),{code:'source_identity_conflict'});
    await assert.rejects(archive.capture({...event('first'),wire_base64:Buffer.from('different wire').toString('base64')}),{code:'source_wire_conflict'});

    // An actual unavailable control pool leaves all source captures committed,
    // retains their spool originals, and creates no partial request transaction.
    const deadControl=new pg.Pool(adminConfig);await deadControl.end();
    const outage=new CaptureCoordinator(archive,deadControl),spool=join(root,'spool','pending');
    for(const id of ['outage-a','outage-b'])await immutableFile(spool,`${digest(event(id).key)}.json`,Buffer.from(canonical(event(id))));
    await drainSourceSpool(outage,root);
    assert.equal((await stores.archive.query('SELECT count(*) FROM events')).rows[0].count,'3');
    assert.equal((await readdir(spool)).length,2);
    assert.equal((await stores.control.query('SELECT count(*) FROM capture_handoffs')).rows[0].count,'1');
    await drainSourceSpool(coordinator,root);
    assert.equal((await readdir(spool)).length,0);
    assert.equal((await stores.control.query('SELECT count(*) FROM capture_handoffs')).rows[0].count,'3');
    assert.equal((await stores.control.query('SELECT count(*) FROM workflow_registry')).rows[0].count,'9');
    // A crash after control commit but before spool retirement reuses requests.
    await immutableFile(spool,`${digest(event('outage-a').key)}.json`,Buffer.from(canonical(event('outage-a'))));
    await drainSourceSpool(coordinator,root);
    assert.equal((await stores.control.query('SELECT count(*) FROM workflow_registry')).rows[0].count,'9');
    assert.equal((await readdir(spool)).length,0);

    // A crash after source commit is repaired without requiring the spool.
    const interrupted=await archive.capture({...event('interrupted'),origin:'import'});
    while(await coordinator.reconcile(2)){}
    assert.equal((await stores.control.query('SELECT count(*) FROM workflow_registry WHERE job_id=$1',[interrupted.source.reference.id])).rows[0].count,'1','imports have no automatic reply or learning');
    // Allocation order is not commit order. A later sweep must find older IDs.
    await stores.control.query('UPDATE capture_reconciliation SET after_sequence=999999');
    const late=await archive.capture(event('late'));
    assert.equal(await coordinator.reconcile(),0);
    assert.ok(await coordinator.reconcile()>0);
    await Promise.all(Array.from({length:10},()=>coordinator.reconcile(2)));
    assert.equal((await stores.control.query('SELECT count(*) FROM workflow_outbox')).rows[0].count,'13','reconciliation never allocates duplicate requests');
    assert.equal((await stores.control.query('SELECT count(*) FROM capture_handoffs WHERE event_id=$1',[late.source.reference.id])).rows[0].count,'1');

    const bytes=Buffer.from([79,103,103,83,0,255]),hash=await storeBytes(root,bytes);
    const file=await archive.attach(first.source.artifact_ids[0]!,hash,bytes.length);
    await assert.rejects(archive.attach(file.id,digest('other'),5),{code:'file_manifest_conflict'});
    await assert.rejects(stores.archive.query('UPDATE artifacts SET file_hash=$2 WHERE id=$1',[file.id,digest('other')]),{code:'23514'});
    const input={operation_id:'engine-a',source:first.source.reference,file,kind:'transcript',content:Buffer.from('First reading'),producer:'fixture-asr',producer_version:'1',configuration:{precision:'fixture'}};
    const a=await derived.record(input),b=await derived.record({...input,operation_id:'engine-b',producer_version:'2',content:Buffer.from('Improved reading')});
    assert.deepEqual(await derived.record(input),a);
    assert.notEqual(a.id,b.id);
    await assert.rejects(derived.record({...input,content:Buffer.from('rewritten')}),{code:'derivative_identity_conflict'});
    await assert.rejects(derived.record({...input,operation_id:'bad-source',source:{...input.source,revision:'invented'}}),{code:'source_reference_conflict'});
    await assert.rejects(stores.derived.query('UPDATE derived_artifacts SET content=$1',[Buffer.from('overwrite')]),{code:'42501'});
    assert.deepEqual(await readFile(join(root,'files',hash)),bytes);
    assert.equal((await stores.derived.query('SELECT count(*) FROM derived_artifacts')).rows[0].count,'2');
    await initializeStoreDatabases(adminConfig,passwords);
    assert.equal((await stores.control.query('SELECT generation FROM installation')).rows[0].generation,generation,'startup must not reset installation identity');
    assert.equal((await stores.derived.query('SELECT count(*) FROM derived_artifacts')).rows[0].count,'2');
  } finally {
    if(stores)await stores.close();
    await admin.end();await rm(root,{recursive:true,force:true});
  }
});

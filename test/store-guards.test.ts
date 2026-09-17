import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,canonical,type Envelope} from '../src/archive.js';
import {connectStores,initializeStoreDatabases,type StorePasswords,type StorePools} from '../src/stores/connections.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {DerivedRepository} from '../src/stores/derived.js';
import {GuardRepository} from '../src/stores/guards.js';

const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};

test('guard publications revoke before visibility and recover owner history across stores',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}
  finally {await admin.end();}
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),derived=new DerivedRepository(stores.derived,archive);
  const guards=new GuardRepository(stores,archive),key=`guard-store-fixture:${Date.now()}`;
  const event:Envelope={version:1,key,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'fixture',source_id:key,
    revision:'1',occurred_at:null,text:'The synthetic password is yellow-lantern.',payload:{message:{text:'The synthetic password is yellow-lantern.'}}};
  try {
    await guards.reconcile();await guards.setMode('on');
    const captured=await archive.capture(event),source=captured.source.reference,id=await guards.register(source);
    const initial=await guards.state();assert.equal(initial.mode,'on');
    await assert.rejects(guards.read(id,initial),{code:'guard_preparation_pending'});
    let calls=0;
    const prepared=await guards.prepare(source,'fixture-detector-v1',async text=>{calls++;return text.includes('yellow-lantern')?['yellow-lantern']:[];});
    assert.ok(prepared);assert.ok(calls>0);
    const automatic=(await guards.read(id,await guards.state())).value as any;
    assert.ok(!JSON.stringify(automatic).includes('yellow-lantern'));
    assert.deepEqual((await guards.read(id,initial)).value,automatic,'initial preparation cannot invalidate unrelated authorized context');

    const beforeOwner=await guards.state(),owner={text:'Owner version',payload:{message:{text:'Owner version'}}};
    const ownerRevision=await guards.edit(id,prepared.revision,owner,digest(key+':owner'));
    await assert.rejects(guards.read(id,beforeOwner),{code:'guard_context_changed'});
    assert.deepEqual((await guards.read(id,await guards.state())).value,owner);
    assert.equal(await guards.prepare(source,'new-detector',async()=>{throw Error('owner edit must not be sent to detector');}),null);
    assert.deepEqual(await guards.edit(id,prepared.revision,owner,digest(key+':owner')),ownerRevision,'retry is idempotent after an uncertain response');
    await assert.rejects(guards.edit(id,prepared.revision,{...owner,text:'different'},digest(key+':stale')),{code:'guard_revision_conflict'});
    await assert.rejects(stores.derived.query('UPDATE guard_revisions SET content=$1',[Buffer.from('{}')]),{code:'42501'});
    await assert.rejects(stores.derived.query('DELETE FROM guard_revisions'),{code:'42501'});

    // Fail after the control revocation commits, before the derived publication.
    const brokenBefore=new GuardRepository(stores,archive);
    brokenBefore.finishPublication=async()=>{throw Error('injected-before-publication');};
    const pendingOperation=digest(key+':pending'),pendingValue={text:'Resumed owner edit',payload:{}};
    const beforeInterrupted=await guards.state();
    await assert.rejects(brokenBefore.edit(id,ownerRevision.revision,pendingValue,pendingOperation),/injected-before-publication/);
    await assert.rejects(guards.state(),{code:'guard_transition_pending'});
    await assert.rejects(guards.read(id,beforeInterrupted),{code:'guard_transition_pending'});
    await assert.rejects(guards.setMode('off'),{code:'guard_transition_pending'});
    assert.equal((await stores.derived.query('SELECT active_revision FROM guard_sources WHERE id=$1',[id])).rows[0].active_revision,ownerRevision.revision);
    assert.ok(await guards.reconcile()>0);
    assert.deepEqual((await guards.read(id,await guards.state())).value,pendingValue);

    // Fail after the derived pointer commits, before the control receipt. A later
    // owner edit may supersede it; durable activation evidence still reconciles it.
    const actualControl=stores.control;
    const failedReceipt=Object.create(actualControl) as pg.Pool;
    failedReceipt.connect=actualControl.connect.bind(actualControl);
    failedReceipt.query=(async (query:any,...args:any[])=>{
      if(typeof query==='string'&&query.startsWith('UPDATE guard_publications SET state='))throw Error('injected-after-publication');
      return (actualControl.query as any)(query,...args);
    }) as typeof failedReceipt.query;
    const brokenAfter=new GuardRepository({...stores,control:failedReceipt} as StorePools,archive);
    const beforeLate=await guards.state(),active=(await guards.read(id,beforeLate)).revision!;
    const lost=digest(key+':lost'),lostValue={text:'Published but unacknowledged',payload:{}};
    await assert.rejects(brokenAfter.edit(id,active,lostValue,lost),/injected-after-publication/);
    await assert.rejects(guards.state(),{code:'guard_transition_pending'});
    const activated=(await stores.derived.query('SELECT revision FROM guard_activations WHERE operation_id=$1',[lost])).rows[0].revision;
    const newest={text:'Newer owner version',payload:{}};
    await guards.edit(id,activated,newest,digest(key+':newer'));
    await guards.reconcile();
    assert.equal((await stores.control.query('SELECT state FROM guard_publications WHERE id=$1',[lost])).rows[0].state,'done');
    assert.deepEqual((await guards.read(id,await guards.state())).value,newest);

    const on=await guards.state(),off=await guards.setMode('off');
    await assert.rejects(guards.read(id,on),{code:'guard_context_changed'});
    assert.equal((await guards.read(id,off)).revision,null);
    assert.equal(((await guards.read(id,off)).value as any).text,event.text);
    await guards.setMode('on');
    const latest=(await guards.read(id,await guards.state())).revision!;
    await guards.restore(id,latest,ownerRevision.revision,digest(key+':restore'));
    assert.deepEqual((await guards.read(id,await guards.state())).value,owner);
    assert.ok((await guards.history(id)).revisions.length>=6);
    const original=(await stores.archive.query('SELECT original_text FROM events WHERE id=$1',[source.id])).rows[0].original_text;
    assert.equal(original.toString(),event.text);

    const output=await derived.record({operation_id:key+':transcript',source,kind:'transcript',content:Buffer.from('A generated transcript'),
      producer:'fixture',producer_version:'1',configuration:{}});
    await guards.prepare(output,'fixture',async()=>[]);
    assert.equal(((await guards.read('derived_artifacts:'+output.id,await guards.state())).value as any).text,'A generated transcript');
    const invalid={...(await guards.state()),generation:'00000000-0000-0000-0000-000000000000'};
    await assert.rejects(guards.read(id,invalid),{code:'guard_context_changed'});
    assert.equal((await stores.control.query("SELECT count(*) FROM guard_publications WHERE state='pending'")).rows[0].count,'0');
    assert.ok(!(await stores.archive.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.some(row=>row.tablename.startsWith('guard_')));
    assert.equal(canonical((await guards.read(id,await guards.state())).value),canonical(owner));

    const raced=await archive.capture({...event,key:key+':race',source_id:key+':race'}),racedId=await guards.register(raced.source.reference);
    let started!:()=>void,release!:()=>void;
    const detecting=new Promise<void>(resolve=>{started=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
    const pending=guards.prepare(raced.source.reference,'race-detector',async()=>{started();await resume;return [];});
    await detecting;
    try {await guards.edit(racedId,null,owner,digest(key+':race-owner'));}
    finally {release();}
    assert.equal(await pending,null,'late automatic preparation cannot replace an owner edit');
    assert.deepEqual((await guards.read(racedId,await guards.state())).value,owner);
    await initializeStoreDatabases(config,passwords);
    const reopened=connectStores(config,passwords),restarted=new GuardRepository(reopened,new ArchiveRepository(reopened.archive));
    try {
      assert.deepEqual((await restarted.read(id,await restarted.state())).value,owner);
      assert.ok((await restarted.history(id)).revisions.length>=6);
    } finally {await reopened.close();}
  } finally {await stores.close();}
});

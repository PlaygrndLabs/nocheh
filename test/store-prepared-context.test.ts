import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases,type StorePasswords} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {DerivedRepository} from '../src/stores/derived.js';
import {PreparedContextRepository} from '../src/stores/prepared-context.js';

test('guarded runtime contexts stay derived, checkpoint detector output, preserve authorized text and isolate audiences',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-runtime-context-')),key='context:'+Date.now();
  const services=storageServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:['-321']}),
    runtime:async()=>({literals:[]}),honcho:async()=>{throw Error('no provider calls');}});
  const event:Envelope={version:1,key,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'123',source_id:key,revision:'1',occurred_at:null,
    text:'Owner-preserved sentence.',payload:{message:{chat:{id:123,type:'private'},text:'Owner-preserved sentence.'}}};
  const principal=async(turnEvent:string,extra:Partial<Reader>={}):Promise<Reader>=>{
    const binding=await services.guards.state();return {admin:false,scope:null,space:'123',turnEvent,generation:binding.generation,guard_epoch:binding.epoch,...extra};
  };
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    const source=(await services.capture.capture(event)).source.reference;
    await services.guards.prepare(source,'fixture',async()=>[]);
    let reader=await principal(source.id),calls=0;
    await services.sources.read(reader,source.id); // Authorized source output becomes reusable prepared text.
    const before=(await stores.archive.query('SELECT count(*) FROM events')).rows[0].count;
    const detect=async(text:string)=>{calls++;assert.ok(!text.includes('Owner-preserved sentence.'));return text.includes('saffronpass')?['saffronpass']:[];};
    const input={messages:[{content:'Owner-preserved sentence. The secret is saffronpass.'}]};
    const result=await services.prepared.prepare(reader,input,detect);
    assert.ok(JSON.stringify(result).includes('Owner-preserved sentence.'));assert.ok(!JSON.stringify(result).includes('saffronpass'));
    assert.equal((await stores.archive.query('SELECT count(*) FROM events')).rows[0].count,before);
    const completedCalls=calls;
    assert.deepEqual(await services.prepared.prepare(reader,input,detect),result);assert.equal(calls,completedCalls);
    const simultaneous=await Promise.all(Array.from({length:4},()=>services.prepared.prepare(reader,'Concurrent saffronpass',detect)));
    assert.ok(simultaneous.every(value=>value===simultaneous[0]));assert.equal(calls,completedCalls+1);

    // Same owner but another purpose cannot inherit an assistant's prepared values.
    let filterCalls=0;
    await services.prepared.prepare({...reader,purpose:'filter'},'Owner-preserved sentence.',async text=>{filterCalls++;assert.ok(text.includes('Owner-preserved sentence.'));return [];});
    assert.equal(filterCalls,1);
    await assert.rejects(services.prepared.prepare({...reader,scope:'-321',space:'-321'},'Forbidden',detect),{code:'turn_source_denied'});
    await assert.rejects(services.prepared.prepare({...reader,generation:'00000000-0000-0000-0000-000000000000'},'Stale',detect),{code:'audience_context_changed'});

    const real=stores.derived,broken=Object.create(real) as pg.Pool;
    broken.connect=real.connect.bind(real);
    broken.query=(async(sql:any,...args:any[])=>{
      if(String(sql).startsWith('INSERT INTO runtime_prepared_inputs'))throw Error('fixture_cache_completion_lost');
      return (real.query as any)(sql,...args);
    }) as typeof real.query;
    const recovery=new PreparedContextRepository(new DerivedRepository(broken,services.archive,services.operations),services.guards,services.prepared.root,'fixture');
    const interrupted='Durable checkpoint saffronpass';
    await assert.rejects(recovery.prepare(reader,interrupted,detect),/fixture_cache_completion_lost/);
    const afterFault=calls;
    // Reuse from another authorized source turn after a lost cache completion.
    const next=(await services.capture.capture({...event,key:key+':next',source_id:key+':next'})).source.reference;
    const repaired=await services.prepared.prepare(await principal(next.id),interrupted,async()=>{throw Error('completed detector work must not repeat');});
    assert.ok(!String(repaired).includes('saffronpass'));assert.equal(calls,afterFault);

    const operation=await services.operations.record({key:key+':schedule',kind:'scheduled_trigger',scope:'123',input_hash:digest('Private scheduled prompt')});
    const scheduled=await services.prepared.prepare(await principal(operation.id),'Scheduled saffronpass',detect);
    assert.ok(!String(scheduled).includes('saffronpass'));
    const output=(await stores.derived.query("SELECT * FROM derived_artifacts WHERE operation_reference->>'id'=$1 AND kind='runtime_context'",[operation.id])).rows[0];
    assert.equal(output.event_id,null);
    const detection=(await stores.derived.query("SELECT * FROM derived_artifacts WHERE operation_reference->>'id'=$1 AND kind='guard_result'",[operation.id])).rows[0];
    assert.equal(detection.input_hash,output.content_hash);assert.equal(detection.provenance.parents[0].id,output.id);
    await assert.rejects(services.selections.activate({store:'derived',kind:'artifact',id:detection.id,input_hash:detection.content_hash},null,key+':invalid-selection'),{code:'source_derivative_required'});

    const first={operation_id:key+':atomic',source,kind:'runtime_context',content:Buffer.from('First'),producer:'fixture',producer_version:'1',configuration:{}};
    await assert.rejects(services.derived.recordMany([first,{...first,content:Buffer.from('Conflicting')}]),{code:'derivative_identity_conflict'});
    assert.equal((await stores.derived.query('SELECT 1 FROM derived_artifacts WHERE operation_id=$1',[first.operation_id])).rowCount,0,'batch rollback leaves no partial outputs');
    await assert.rejects(services.prepared.prepare(reader,'Invalid detector fixture',async()=>['not present']),{code:'detector_contract_rejected'});

    await services.guards.setMode('off');
    await assert.rejects(services.prepared.prepare(reader,'Old capability',detect),{code:'audience_context_changed'});
    reader=await principal(source.id);
    assert.deepEqual(await services.prepared.prepare(reader,{text:'Raw saffronpass'},async()=>{throw Error('guard off does not call the detector');}),{text:'Raw saffronpass'});
    await assert.rejects(services.prepared.prepare({...reader,scope:'-321',space:'-321'},'Still forbidden',detect),{code:'turn_source_denied'});
  } finally {await services.guards.setMode('on');await stores.close();await rm(root,{recursive:true,force:true});}
});

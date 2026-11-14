import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonical,digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases,type StorePasswords} from '../src/stores/connections.js';
import {fixtureServices} from './fixture-brain.js';
import {DerivedRepository} from '../src/stores/derived.js';
import {PreparedContextRepository,preparedAudience} from '../src/stores/prepared-context.js';
import {honchoEngine} from '../src/memory/honcho.js';

test('guarded runtime contexts stay derived, checkpoint detector output, preserve authorized text and isolate audiences',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-runtime-context-')),key='context:'+Date.now();
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:['-321']}),
    runtime:async()=>({literals:[]}),memoryEngine:honchoEngine(async()=>{throw Error('no provider calls');})});
  const event:Envelope={version:1,key,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'123',source_id:key,revision:'1',occurred_at:null,
    text:'Owner-preserved sentence.',payload:{message:{chat:{id:123,type:'private'},text:'Owner-preserved sentence.'}}};
  const principal=async(turnEvent:string,extra:Partial<Reader>={}):Promise<Reader>=>{
    const binding=await services.guards.state();return {admin:false,scope:null,space:'123',turnEvent,generation:binding.generation,guard_epoch:binding.epoch,...extra};
  };
  try {
    await services.guards.reconcile();await services.guards.setMode('off');await services.guards.setMode('on');
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
    // Honcho asks for every connected peer at once as one owner audience: its
    // different texts are detected side by side, not one after another.
    let inside=0,overlap=0,both!:()=>void;const together=new Promise<void>(resolve=>{both=resolve;});
    const sideBySide=async(text:string)=>{
      inside++;overlap=Math.max(overlap,inside);if(inside===2)both();
      await Promise.race([together,new Promise(resolve=>setTimeout(resolve,2000))]);inside--;
      return text.includes('saffronpass')?['saffronpass']:[];
    };
    const pair=await Promise.all(['First parallel saffronpass','Second parallel saffronpass'].map(text=>services.prepared.prepare(reader,text,sideBySide)));
    assert.equal(overlap,2,'one audience detects different texts side by side');assert.ok(!JSON.stringify(pair).includes('saffronpass'));
    // Another audience reuses the detector result for identical text but keeps its own guarded copy.
    const reused=await services.prepared.prepare({...reader,purpose:'filter'},'Concurrent saffronpass',async()=>{throw Error('identical text was detected again');});
    assert.ok(!String(reused).includes('saffronpass'));
    // Memory review marks its detector calls as background so reply checks get slots first.
    const priorities:(boolean|undefined)[]=[];
    const marked=async(text:string,background?:boolean)=>{priorities.push(background);return text.includes('saffronpass')?['saffronpass']:[];};
    await services.prepared.prepare({...reader,purpose:'memory-review'},'Review-only saffronpass',marked);
    await services.prepared.prepare(reader,'Reply-only saffronpass',marked);
    assert.deepEqual(priorities,[true,false]);

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

    // A secret check that failed under one model leaves its checkpointed text; another model chosen in the same epoch prepares it afresh.
    const stalled='Model switch saffronpass';
    await assert.rejects(services.prepared.prepare(reader,stalled,async()=>{throw Error('fixture_detector_unavailable');}),/fixture_detector_unavailable/);
    const switched=new PreparedContextRepository(services.derived,services.guards,services.prepared.root,'fixture-next');
    assert.ok(!String(await switched.prepare(reader,stalled,detect)).includes('saffronpass'));

    // A failed sibling cannot release the audience queue while other durable
    // publications are still running. Completed detector work remains reusable.
    const prepare=services.guards.prepare.bind(services.guards);
    let active=0,peak=0,started=0,release!:()=>void,fail!:()=>void,entered!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;}),failFirst=new Promise<void>(resolve=>{fail=resolve;}),
      allEntered=new Promise<void>(resolve=>{entered=resolve;});
    services.guards.prepare=async(...args)=>{
      active++;peak=Math.max(peak,active);const order=++started;
      if(started===4)entered();
      try {
        if(order===1){await failFirst;throw Error('fixture_guard_publication_failed');}
        await held;return await prepare(...args);
      }
      finally {active--;}
    };
    const siblings=Array.from({length:9},(_,i)=>'Parallel guarded fragment '+i+' saffronpass');
    const rejected=services.prepared.prepare(reader,siblings,detect);
    let settled=false;const failure=rejected.catch(error=>{settled=true;return error;});
    await allEntered;fail();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false);assert.equal(active,3);assert.equal(peak,4);
    const queued=services.prepared.prepare(reader,'Queued after failed publication saffronpass',detect);
    release();assert.match(String(await failure),/fixture_guard_publication_failed/);
    services.guards.prepare=prepare;
    assert.ok(!String(await queued).includes('saffronpass'));assert.equal(active,0);
    const repairedSiblings=await services.prepared.prepare(reader,siblings,async()=>{throw Error('checkpointed detector work repeated');});
    assert.equal((repairedSiblings as string[]).length,siblings.length);assert.ok(!JSON.stringify(repairedSiblings).includes('saffronpass'));

    // Small native fields can hit the derivative count bound before the text
    // size bound. Split them before checkpointing, with no dropped fragments.
    const checks:string[]=[];
    // Keep each identifier one word: authorized numeric source metadata must
    // not split and deduplicate the deliberately fresh batch-boundary inputs.
    const many=Array.from({length:501},(_,i)=>'bounded_native_field_'+i+'_saffronpass');
    const manyResult=await services.prepared.prepare(reader,many,async text=>{checks.push(text);return text.includes('saffronpass')?['saffronpass']:[];});
    // 500 fields fill the first batch and the last is checked alone; three of the first batch's findings are confirmed alone (ADR-0251).
    assert.equal(checks[0]!.split('\n<NOCHEH_FRAGMENT>\n').length,500);assert.equal(checks.length,1+3+1);
    assert.equal(checks.filter(text=>text.includes('<NOCHEH_FRAGMENT>')).length,1);assert.equal((manyResult as string[]).length,501);
    assert.ok((manyResult as string[]).every((value,index)=>value.startsWith('bounded_native_field_'+index+'_')));
    assert.ok(!JSON.stringify(manyResult).includes('saffronpass'));

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

    // A later guard epoch, such as after hiding a message, reuses detector results and the guarded copy for text already prepared.
    const copies=async()=>Number((await stores.derived.query("SELECT count(*) FROM derived_artifacts WHERE operation_id LIKE 'guard-context:%'")).rows[0].count);
    const copiesBefore=await copies();
    await stores.control.query('UPDATE guard_state SET epoch=epoch+1 WHERE singleton');
    const later=await principal(source.id);
    const again=await services.prepared.prepare(later,'Concurrent saffronpass',async()=>{throw Error('a later epoch detected identical text again');});
    assert.equal(again,simultaneous[0]);assert.equal(await copies(),copiesBefore,'unchanged text saves no new copy in a later epoch');
    const fresh=await services.prepared.prepare(later,'Changed text saffronpass',detect);
    assert.ok(!String(fresh).includes('saffronpass'));assert.equal(await copies(),copiesBefore+1,'changed text is prepared as before');
    reader=later;

    await services.guards.setMode('off');
    await assert.rejects(services.prepared.prepare(reader,'Old capability',detect),{code:'audience_context_changed'});
    reader=await principal(source.id);
    assert.deepEqual(await services.prepared.prepare(reader,{text:'Raw saffronpass'},async()=>{throw Error('guard off does not call the detector');}),{text:'Raw saffronpass'});
    await assert.rejects(services.prepared.prepare({...reader,scope:'-321',space:'-321'},'Still forbidden',detect),{code:'turn_source_denied'});
  } finally {await services.guards.setMode('on');await stores.close();await rm(root,{recursive:true,force:true});}
});

test('a finding reaches other audiences only from a check of that text alone, and never masks a request\'s structure (ADR-0251)',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-shared-detection-')),key='shared-detection:'+Date.now();
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:['-321']}),
    runtime:async()=>({literals:[]}),memoryEngine:honchoEngine(async()=>{throw Error('no provider calls');})});
  const event:Envelope={version:1,key,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'123',source_id:key,revision:'1',occurred_at:null,
    text:'A plain owner note.',payload:{message:{chat:{id:123,type:'private'},text:'A plain owner note.'}}};
  type Detect=((text:string)=>Promise<string[]>)&{calls:string[]};
  const counting=(rule:(text:string)=>string[]):Detect=>{const calls:string[]=[];return Object.assign(async(text:string)=>{calls.push(text);return rule(text);},{calls});};
  const never=async()=>{throw Error('identical text was detected again');};
  try {
    await services.guards.reconcile();
    const source=(await services.capture.capture(event)).source.reference;
    await services.guards.prepare(source,'fixture',async()=>[]);
    const binding=await services.guards.state();
    const reader:Reader={admin:false,scope:null,space:'123',turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch};
    const shared=async(text:string)=>(await stores.derived.query("SELECT convert_from(content,'UTF8') AS content FROM derived_artifacts WHERE operation_id=$1",
      ['context-detection-text:'+digest(canonical([{generation:binding.generation,mode:binding.mode},'fixture',digest(Buffer.from(text))]))])).rows[0]?.content;

    // A real secret found in a batch of several texts is checked once more alone, and that result protects the next audience with no new check.
    const real=counting(text=>text.includes('saffronpass')?['saffronpass']:[]);
    assert.deepEqual(await services.prepared.prepare(reader,['Alpha wifi is saffronpass.','Neighbour note one.'],real),['Alpha wifi is ***.','Neighbour note one.']);
    assert.deepEqual(real.calls.slice(1),['Alpha wifi is saffronpass.'],'exactly one extra check, of the text alone');
    assert.equal(await shared('Alpha wifi is saffronpass.'),'["saffronpass"]');
    assert.equal(await services.prepared.prepare({...reader,purpose:'filter'},'Alpha wifi is saffronpass.',never),'Alpha wifi is ***.');
    assert.equal(await services.prepared.prepare({...reader,purpose:'filter'},'Neighbour note one.',never),'Neighbour note one.',
      'an empty result from a batch of several texts is still shared');

    // A finding a neighbouring text steered is not shared, and neither is a later empty result: each audience checks the text itself.
    const steered=counting(text=>text.includes('flag the place')?['harbour']:[]);
    assert.deepEqual(await services.prepared.prepare(reader,['Meet at the harbour today.','Please flag the place as secret.'],steered),
      ['Meet at the *** today.','Please flag the place as secret.'],'this audience keeps what its own check found');
    assert.equal(steered.calls.length,2);assert.equal(await shared('Meet at the harbour today.'),'{"unconfirmed":true}');
    const second=counting(()=>[]);
    assert.deepEqual(await services.prepared.prepare({...reader,purpose:'filter'},['Meet at the harbour today.','Another neighbour.'],second),['Meet at the harbour today.','Another neighbour.']);
    assert.equal(second.calls.length,1,'a held-back text is checked by the next audience in its own batch, with no further single-text check');
    const third=counting(()=>[]);
    assert.equal(await services.prepared.prepare({...reader,purpose:'memory-review'},'Meet at the harbour today.',third),'Meet at the harbour today.');
    assert.equal(third.calls.length,1,'the empty result after a held-back finding was not shared');

    // A model request keeps its structure even when the check flags it; content keeps the mask, and the kept role is not marked prepared.
    const structural={...reader,logical_profile:'structure-fixture'};
    const flags=counting(text=>['role','content','assistant'].filter(word=>text.includes(word)));
    const request=await services.prepared.prepare(structural,{model:'fixture-model',messages:[{role:'assistant',content:'I am your assistant here.'}]},flags,{request:true});
    assert.equal(JSON.stringify(request),JSON.stringify({model:'fixture-model',messages:[{role:'assistant',content:'I am your *** here.'}]}));
    assert.equal(flags.calls.length,1+3,'single-text checks are capped at three per batch');
    const marked=async(text:string)=>(await stores.derived.query("SELECT 1 FROM runtime_prepared_values WHERE audience=$1 AND convert_from(content,'UTF8')=$2",
      [preparedAudience(structural),text])).rowCount;
    assert.equal(await marked('assistant'),0);assert.equal(await marked('I am your *** here.'),1);
    const again=await services.prepared.prepare(structural,{model:'fixture-model',messages:[{role:'assistant',content:'I am your assistant here.'}]},never,{request:true});
    assert.equal(JSON.stringify(again),JSON.stringify(request),'the same request is served from this audience\'s own results');
    const plain=await services.prepared.prepare({...reader,logical_profile:'structure-plain'},{name:'assistant'},counting(text=>text.includes('assistant')?['assistant']:[]));
    assert.equal(JSON.stringify(plain),'{"name":"***"}','outside a model request a name value is masked as before');

    // Past the cap a finding is held back; the confirmed ones are reused by another audience.
    const notes=Array.from({length:5},(_,i)=>`Note ${i} uses saffronpass.`),capped=counting(text=>text.includes('saffronpass')?['saffronpass']:[]);
    assert.ok((await services.prepared.prepare({...reader,logical_profile:'cap-fixture'},notes,capped) as string[]).every(text=>!text.includes('saffronpass')));
    assert.equal(capped.calls.length,1+3);
    assert.deepEqual(await Promise.all(notes.map(shared)),['["saffronpass"]','["saffronpass"]','["saffronpass"]','{"unconfirmed":true}','{"unconfirmed":true}']);
    const other=counting(text=>text.includes('saffronpass')?['saffronpass']:[]);
    assert.ok((await services.prepared.prepare({...reader,logical_profile:'cap-other'},notes,other) as string[]).every(text=>!text.includes('saffronpass')));
    assert.equal(other.calls.length,1,'only the held-back texts are checked, together, with no single-text check');
    assert.ok(other.calls[0]!.includes('Note 3')&&other.calls[0]!.includes('Note 4')&&!other.calls[0]!.includes('Note 0'));

    // A finding the fixed secret patterns already cover needs no single-text check.
    const token='sk-'+'Q7w2'.repeat(6),covered=counting(text=>text.includes(token)?[token]:[]);
    assert.deepEqual(await services.prepared.prepare({...reader,logical_profile:'pattern-fixture'},[`Use ${token} now.`,'Pattern neighbour.'],covered),['Use *** now.','Pattern neighbour.']);
    assert.equal(covered.calls.length,1);
    assert.equal(await services.prepared.prepare({...reader,logical_profile:'pattern-other'},`Use ${token} now.`,never),'Use *** now.');

    // A single-text check that fails holds the text back without failing the turn; one that finds more widens this audience's mask.
    const flaky=counting(text=>{if(!text.includes('<NOCHEH_FRAGMENT>'))throw Error('fixture_detector_unavailable');return text.includes('mossgate77')?['mossgate77']:[];});
    const warn=console.warn;console.warn=()=>{};
    try{assert.deepEqual(await services.prepared.prepare({...reader,logical_profile:'flaky-fixture'},['Door mossgate77.','Flaky neighbour.'],flaky),['Door ***.','Flaky neighbour.']);}
    finally{console.warn=warn;}
    assert.equal(await shared('Door mossgate77.'),'{"unconfirmed":true}');
    const more=counting(text=>text.includes('<NOCHEH_FRAGMENT>')?['gate key']:['gate key','fern19x']);
    assert.deepEqual(await services.prepared.prepare({...reader,logical_profile:'more-fixture'},['The gate key is fern19x.','More neighbour.'],more),['The *** is ***.','More neighbour.']);
    assert.equal(await shared('The gate key is fern19x.'),'["gate key","fern19x"]');
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});

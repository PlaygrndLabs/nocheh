import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {IncomingMessage} from 'node:http';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest,type Envelope} from '../src/archive.js';
import {reader,type Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases,type StorePasswords} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {NativeReviewRepository} from '../src/stores/native-review.js';

test('native review preserves profile waits, guarded inputs, durable completion and uncertain execution identity',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-store-review-')),key='review:'+Date.now(),group='-'+Date.now();
  const token='synthetic-review-service-credential-only',owner:Reader={admin:true,scope:null},receipts=new Set<string>();
  let mode:'busy'|'lose'|'missing'|'done'='busy',writes=0,requests=0,observations=0;
  const services=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:String(input.text).includes('saffronpass')?['saffronpass']:[]};
      assert.equal(operation,'memory.review');assert.equal(input.scope,'123');
      if(input.observe_only){observations++;assert.equal(input.archive_credential,undefined);return {state:receipts.has(String(input.id))?'done':'not_found'};}
      requests++;assert.ok(!String(input.content).includes('saffronpass'));
      const actor=reader({headers:{authorization:'Bearer '+input.archive_credential}} as IncomingMessage,token),binding=await services.turns.binding(actor);
      assert.equal(actor.purpose,'memory-review');assert.equal(binding.scope,'123');assert.equal(binding.owner,true);
      await assert.rejects(services.turns.binding({...actor,purpose:'assistant'}),{code:'turn_source_denied'});
      assert.equal(binding.profile,services.turns.profile({...actor,purpose:'assistant'},await services.guards.state()));
      if(mode==='busy')return {state:'waiting',error_code:'profile_busy'};
      if(mode==='missing')throw Error('synthetic_connection_lost_before_receipt');
      receipts.add(String(input.id));writes++;if(mode==='lose')throw Error('synthetic_lost_completion');return {state:'done'};
    },honcho:async()=>{throw Error('no provider calls');}});
  const makeSource=async(index:number)=>{
    const event:Envelope={version:1,key:key+':'+index,origin:'live',kind:'telegram_update',bot_id:key,scope:group,source_id:String(index),revision:'1',occurred_at:null,
      text:'Guarded native notes saffronpass',payload:{message:{message_id:index,date:1,chat:{id:Number(group),type:'group'},from:{id:123},text:'Guarded native notes saffronpass'}}};
    const source=(await services.capture.capture(event)).source.reference;await services.guards.prepare(source,'fixture',services.detect);return source;
  };
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    const authority={owner:'inngest' as const,epoch:(await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='memory_review'")).rows[0].epoch};
    const source=await makeSource(1),jobs=await services.reviews.queue(source);assert.equal(jobs.length,1);assert.deepEqual(await services.reviews.queue(source),jobs);
    const id=jobs[0]!;
    assert.equal(await services.reviews.run(id,authority),'pending');assert.equal((await services.reviews.inspect(id)).attempts,0);assert.equal(writes,0);
    mode='lose';assert.equal(await services.reviews.run(id,authority),'ambiguous');assert.equal(writes,1);
    assert.equal(await services.reviews.run(id,authority),'done');assert.equal(writes,1);assert.equal(observations,1);
    assert.equal(await services.reviews.run(id,authority),'done');assert.equal(observations,1);
    const columns=(await stores.control.query("SELECT column_name FROM information_schema.columns WHERE table_name='native_review_jobs' AND table_schema='public'")).rows.map(r=>r.column_name);
    assert.ok(!columns.includes('content'));
    const job=await services.reviews.inspect(id),output=(await stores.derived.query('SELECT * FROM derived_artifacts WHERE id=$1',[job.result_id])).rows[0];
    assert.equal(output.input_hash,job.input_reference.input_hash);assert.equal(output.provenance.parents[0].id,job.input_reference.id);

    const second=await makeSource(2),next=(await services.reviews.queue(second))[0]!;
    const paused=await services.reviews.controlJob(owner,next,{action:'pause',expected_revision:1});assert.equal(paused.paused,true);
    assert.equal(await services.reviews.run(next,authority),'paused');
    await assert.rejects(services.reviews.controlJob(owner,next,{action:'resume',expected_revision:1}),{code:'review_not_controllable'});
    await services.reviews.controlJob(owner,next,{action:'resume',expected_revision:2});
    const control=Object.create(stores.control) as pg.Pool;control.query=stores.control.query.bind(stores.control);
    let fail=true;
    control.connect=(async()=>{
      const client=await stores.control.connect();return {query:async(sql:any,...args:any[])=>{
        if(fail&&String(sql).startsWith("UPDATE native_review_jobs SET state='done'")){fail=false;throw Error('synthetic_control_completion_lost');}
        return (client.query as any)(sql,...args);
      },release:client.release.bind(client)} as pg.PoolClient;
    }) as typeof control.connect;
    const access=Object.assign(Object.create(services.access),{stores:{...stores,control}}),contexts=Object.assign(Object.create(services.contexts),{access});
    const recovering=new NativeReviewRepository(contexts,services.derived,services.prepared,services.turns,services.reviews.call,token);
    mode='done';await assert.rejects(recovering.run(next,authority),/synthetic_control_completion_lost/);
    const beforeRecovery={requests,observations,writes};assert.equal(await services.reviews.run(next,authority),'done');
    assert.deepEqual({requests,observations,writes},beforeRecovery,'durable completion requires neither native execution nor another observation');

    const third=await makeSource(3),uncertain=(await services.reviews.queue(third))[0]!;mode='missing';
    assert.equal(await services.reviews.run(uncertain,authority),'ambiguous');const attempted=requests;
    assert.equal(await services.reviews.run(uncertain,authority),'ambiguous');assert.equal(requests,attempted,'no receipt does not authorize repeating a native note mutation');
    const suspended=await services.reviews.controlJob(owner,uncertain,{action:'pause',expected_revision:1});assert.equal(suspended.state,'ambiguous');assert.equal(suspended.paused,true);
    assert.equal(await services.reviews.run(uncertain,authority),'paused');
    await services.reviews.controlJob(owner,uncertain,{action:'resume',expected_revision:2});
    assert.equal(await services.reviews.run(uncertain,authority),'ambiguous');assert.equal(requests,attempted);
    const fourth=await makeSource(4),notStarted=(await services.reviews.queue(fourth))[0]!;
    await services.access.setConsent(owner,fourth,{enabled:false,expected_revision:0,operation_id:key+':revoke'});
    await assert.rejects(services.reviews.run(notStarted,authority),{code:'guard_context_changed'});assert.equal(requests,attempted);
    receipts.add(uncertain);assert.equal(await services.reviews.run(uncertain,authority),'done','old native receipts reconcile without granting old contexts');assert.equal(requests,attempted);
    assert.equal((await stores.archive.query("SELECT 1 FROM events WHERE kind='runtime_result'")).rowCount,0);
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});

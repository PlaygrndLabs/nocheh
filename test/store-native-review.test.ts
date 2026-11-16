import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {IncomingMessage} from 'node:http';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonical,digest,type Envelope} from '../src/archive.js';
import {reader,type Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases,type StorePasswords} from '../src/stores/connections.js';
import {fixtureServices} from './fixture-brain.js';
import {NativeReviewRepository,nativeReconcileLimit,requestStrandedSources} from '../src/stores/native-review.js';
import {storageWorkflowOperations} from '../src/stores/workflow-operations.js';
import {honchoEngine} from '../src/memory/honcho.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {captureEvidence} from '../src/stores/generated-capture.js';

test('native review preserves profile waits, guarded inputs, durable completion and uncertain execution identity',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-store-review-')),key='review:'+Date.now(),group='-'+Date.now();
  const token='synthetic-review-service-credential-only',owner:Reader={admin:true,scope:null},receipts=new Set<string>();
  let mode:'busy'|'lose'|'missing'|'done'='busy',writes=0,requests=0,observations=0;
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
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
    },memoryEngine:honchoEngine(async()=>{throw Error('no provider calls');})});
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
    const recovering=new NativeReviewRepository(contexts,services.derived,services.prepared,services.turns,services.reviews.brain,token);
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

test('native review runs once per source across authorization epochs and stops observing an unconfirmed review',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-store-review-once-')),key='review-once:'+Date.now(),group='-'+Date.now();
  const token='synthetic-review-service-credential-only',owner:Reader={admin:true,scope:null};
  let mode:'done'|'missing'|'running'|'failed'='done',starts=0,observations=0;
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      assert.equal(operation,'memory.review');
      if(input.observe_only){observations++;return {state:mode==='running'?'running':mode==='failed'?'failed':'ambiguous'};}
      starts++;if(mode==='missing')throw Error('synthetic_connection_lost_before_receipt');return {state:['running','failed'].includes(mode)?'running':'done'};
    },memoryEngine:honchoEngine(async()=>{throw Error('no provider calls');})});
  const makeSource=async(index:number,text='Synthetic note '+index,reply?:number)=>{
    const event:Envelope={version:1,key:key+':'+index,origin:'live',kind:'telegram_update',bot_id:key,scope:group,source_id:String(index),revision:'1',occurred_at:null,
      text,payload:{message:{message_id:index,date:1,chat:{id:Number(group),type:'group'},from:{id:123},text,...(reply?{reply_to_message:{message_id:reply}}:{})}}};
    const source=(await services.capture.capture(event)).source.reference;await services.guards.prepare(source,'fixture',services.detect);return source;
  };
  const jobs=async(source:{id:string})=>(await stores.control.query("SELECT id FROM native_review_jobs WHERE source_reference->>'id'=$1 ORDER BY id",[source.id])).rows.map(row=>row.id);
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    const authority={owner:'inngest' as const,epoch:(await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='memory_review'")).rows[0].epoch};
    const reviewed=await makeSource(1),waiting=await makeSource(2);
    const [done]=await services.reviews.queue(reviewed);assert.equal(await services.reviews.run(done!,authority),'done');assert.equal(starts,1);
    const [superseded]=await services.reviews.queue(waiting);

    // Reactions, rule changes, learned-memory revisions and guard transitions advance the epoch and sweep every archived source again.
    const bump=async()=>{
      const before=(await services.guards.state()).epoch;await services.guards.setMode('off');await services.guards.setMode('on');
      assert.ok((await services.guards.state()).epoch>before);
    };
    await bump();
    assert.deepEqual(await services.reviews.queue(reviewed),[done],'a reviewed source is not reviewed again for a new epoch');
    assert.deepEqual(await jobs(reviewed),[done]);
    for(let index=0;index<3;index++){assert.deepEqual(await services.reviews.queue(waiting),[superseded]);await bump();}
    assert.deepEqual(await services.reviews.queue(waiting),[superseded],'a review that never started keeps its identity under the current epoch');
    assert.deepEqual(await jobs(waiting),[superseded],'later epochs never add copies of a waiting review');
    assert.equal(canonical((await services.reviews.inspect(superseded!)).binding),canonical(await services.guards.state()));

    // Its own workflow renews it after a later epoch, without waiting for the sweep to queue it again.
    const operations=storageWorkflowOperations(services,async()=>{throw Error('no source files in this fixture');});
    await bump();
    assert.equal((await operations.memory_review!('native:'+superseded,authority)).state,'completed');assert.equal(starts,2);
    assert.deepEqual(await jobs(waiting),[superseded]);

    // Changed input becomes a new review; the old copy is cleared and its workflow closes.
    const first=await makeSource(4),[original]=await services.reviews.queue(first);await bump();
    await stores.control.query(`UPDATE native_review_jobs SET input_reference=jsonb_set(input_reference,'{input_hash}','"${'0'.repeat(64)}"') WHERE id=$1`,[original]);
    const [changed]=await services.reviews.queue(first);
    assert.notEqual(changed,original,'a review whose input changed is prepared again');
    assert.deepEqual(await jobs(first),[changed]);
    assert.deepEqual(await operations.memory_review!('native:'+original,authority).then(result=>[result.state,result.waiting_reason]),['skipped','superseded']);

    // While Hermes runs one review, a waiting review doesn't ask it again.
    await stores.control.query("UPDATE native_review_jobs SET state='running',updated_at=now() WHERE id=$1",[changed]);
    const [queued]=await services.reviews.queue(await makeSource(6));
    assert.equal((await operations.memory_review!('native:'+queued,authority)).state,'waiting');assert.equal(starts,2);
    await stores.control.query("UPDATE native_review_jobs SET state='done' WHERE id=$1",[changed]);
    assert.equal((await operations.memory_review!('native:'+queued,authority)).state,'completed');assert.equal(starts,3);

    // A review whose start was never confirmed is observed with growing gaps, never relaunched, then closed as uncertain.
    const [uncertain]=await services.reviews.queue(await makeSource(3));mode='missing';
    assert.equal(await services.reviews.run(uncertain!,authority),'ambiguous');assert.equal(starts,4);
    const gaps:number[]=[];
    for(let index=0;index<nativeReconcileLimit;index++) {
      await stores.control.query('UPDATE native_review_jobs SET next_attempt=now() WHERE id=$1',[uncertain]);
      const result=await operations.memory_review!('native:'+uncertain,authority),row=await services.reviews.inspect(uncertain!);
      gaps.push(row.next_attempt.getTime()-row.updated_at.getTime());
      assert.equal(result.state,index<nativeReconcileLimit-1?'waiting':'ambiguous');
    }
    assert.equal(observations,nativeReconcileLimit);assert.equal(starts,4,'an unconfirmed review never starts again');
    assert.ok(gaps.every((gap,index)=>index===0||gap>=gaps[index-1]!),'each unconfirmed observation waits at least as long as the last');
    assert.ok(gaps.at(-1)!>=30*60000);
    await stores.control.query('UPDATE native_review_jobs SET next_attempt=now() WHERE id=$1',[uncertain]);
    const closed=await operations.memory_review!('native:'+uncertain,authority);
    assert.deepEqual([closed.state,closed.waiting_reason],['ambiguous','native_review_unconfirmed']);assert.equal(observations,nativeReconcileLimit);
    const row=await services.reviews.inspect(uncertain!);
    await services.reviews.controlJob(owner,uncertain!,{action:'resume',expected_revision:row.revision});
    assert.equal((await operations.memory_review!('native:'+uncertain,authority)).state,'waiting','an owner resume observes the same identity again');
    assert.equal(observations,nativeReconcileLimit+1);assert.equal(starts,4);

    // A review stranded under an earlier epoch before a restart is renewed by its per-source step, requested once.
    const since=new Date(Date.now()-60000),stranded=await makeSource(7),[strandedReview]=await services.reviews.queue(stranded);await bump();
    const sourceWorkflows=async()=>(await stores.control.query("SELECT generation FROM workflow_registry WHERE family='memory_review' AND job_id=$1",['source:'+stranded.id])).rows;
    // Capture asked for this source's step already; an open step is left to run instead.
    assert.equal((await sourceWorkflows()).length,1);
    assert.equal(await requestStrandedSources(stores.control,new Date()),0);
    await stores.control.query("UPDATE workflow_registry SET state='completed',created_at=$2 WHERE family='memory_review' AND job_id=$1",['source:'+stranded.id,since]);
    assert.ok(await requestStrandedSources(stores.control,new Date(since.getTime()+1))>=1);assert.equal((await sourceWorkflows()).length,2);
    await requestStrandedSources(stores.control,new Date(since.getTime()+1));assert.equal((await sourceWorkflows()).length,2,'a stranded source is asked for once');
    assert.equal((await operations.memory_review!('source:'+stranded.id,authority)).state,'completed');
    assert.equal(canonical((await services.reviews.inspect(strandedReview!)).binding),canonical(await services.guards.state()));
    assert.equal(starts,4);

    // A running review is observed soon after it starts, then at doubling gaps up to a minute.
    mode='running';const [running]=await services.reviews.queue(await makeSource(8));
    const runningGaps:number[]=[];
    for(let index=0;index<6;index++) {
      assert.equal(await services.reviews.run(running!,authority),'running');
      const row=await services.reviews.inspect(running!);runningGaps.push(Math.round((row.next_attempt.getTime()-row.updated_at.getTime())/1000));
    }
    assert.deepEqual(runningGaps,[5,10,20,40,60,60]);assert.equal(starts,5);

    // A review that failed without changing the notes runs again at growing gaps, then closes as uncertain.
    mode='failed';const [failed]=await services.reviews.queue(await makeSource(9));
    assert.equal(await services.reviews.run(failed!,authority),'running');assert.equal(starts,6);
    const attempts:string[]=[];
    for(let index=0;index<8&&attempts.at(-1)!=='ambiguous';index++) {
      await stores.control.query('UPDATE native_review_jobs SET next_attempt=now() WHERE id=$1',[failed]);
      attempts.push(await services.reviews.run(failed!,authority));
    }
    assert.deepEqual(attempts,['pending','running','pending','running','pending','running','ambiguous']);
    assert.equal(starts,9,'each retry starts the same review again, four starts in all');
    const exhausted=await services.reviews.inspect(failed!);
    assert.deepEqual([exhausted.state,exhausted.error_code,exhausted.attempts],['ambiguous','native_review_failed',4]);
    assert.equal(await services.reviews.run(failed!,authority),'ambiguous','a closed review is not started again');assert.equal(starts,9);

    // A failed review whose retry waits past a later epoch is rebound where it waits and runs again, instead of closing as superseded.
    await stores.control.query("UPDATE native_review_jobs SET state='done' WHERE id=$1",[running]);
    const retrySource=await makeSource(10),[retry]=await services.reviews.queue(retrySource);
    assert.equal(await services.reviews.run(retry!,authority),'running');assert.equal(starts,10);
    await stores.control.query('UPDATE native_review_jobs SET next_attempt=now() WHERE id=$1',[retry]);
    assert.equal(await services.reviews.run(retry!,authority),'pending');
    await bump();await stores.control.query('UPDATE native_review_jobs SET next_attempt=now() WHERE id=$1',[retry]);
    assert.equal((await operations.memory_review!('native:'+retry,authority)).state,'running');assert.equal(starts,11);
    const retried=await services.reviews.inspect(retry!);
    assert.deepEqual([retried.state,retried.attempts],['running',2]);
    assert.equal(canonical(retried.binding),canonical(await services.guards.state()));
    await stores.control.query("UPDATE native_review_jobs SET state='done' WHERE id=$1",[retry]);

    // A failed review whose workflow closed before it ran again gets a new workflow from its source's step, once.
    const closedSource=await makeSource(11),[lapsed]=await services.reviews.queue(closedSource);
    assert.equal(await services.reviews.run(lapsed!,authority),'running');
    await stores.control.query('UPDATE native_review_jobs SET next_attempt=now() WHERE id=$1',[lapsed]);
    assert.equal(await services.reviews.run(lapsed!,authority),'pending');assert.equal(starts,12);
    await stores.control.query("UPDATE workflow_registry SET state='skipped',waiting_reason='superseded' WHERE family='memory_review' AND job_id=$1",['native:'+lapsed]);
    await bump();
    const closedSince=new Date(Date.now()-60000);
    await stores.control.query("UPDATE workflow_registry SET state='completed',created_at=$2 WHERE family='memory_review' AND job_id=$1",['source:'+closedSource.id,closedSince]);
    const sourceSteps=async()=>(await stores.control.query("SELECT count(*)::int AS count FROM workflow_registry WHERE family='memory_review' AND job_id=$1",['source:'+closedSource.id])).rows[0].count;
    const stepsBefore=await sourceSteps();await requestStrandedSources(stores.control,new Date(closedSince.getTime()+1));
    assert.equal(await sourceSteps(),stepsBefore+1,'a failed review left under an earlier epoch is stranded work');
    assert.equal((await operations.memory_review!('source:'+closedSource.id,authority)).state,'completed');
    const nativeWorkflows=async()=>(await stores.control.query("SELECT state FROM workflow_registry WHERE family='memory_review' AND job_id=$1 ORDER BY generation",['native:'+lapsed])).rows.map(row=>row.state);
    assert.deepEqual(await nativeWorkflows(),['skipped','queued']);
    await services.reviews.queue(closedSource);assert.deepEqual(await nativeWorkflows(),['skipped','queued'],'an open workflow is not asked for twice');
    const kept=await services.reviews.inspect(lapsed!);
    assert.deepEqual([kept.state,kept.attempts,kept.error_code],['pending',1,'native_review_failed'],'it keeps its attempts and failure');
    assert.equal(canonical(kept.binding),canonical(await services.guards.state()));

    // An epoch that lands while a waiting review is checked makes it wait and renew, not close.
    const assertCurrent=services.guards.assertCurrent.bind(services.guards);let raced=false;
    services.guards.assertCurrent=async binding=>{if(!raced){raced=true;await bump();}return assertCurrent(binding);};
    await stores.control.query('UPDATE native_review_jobs SET next_attempt=now() WHERE id=$1',[lapsed]);
    const racing=await operations.memory_review!('native:'+lapsed,authority);
    services.guards.assertCurrent=assertCurrent;
    assert.deepEqual([racing.state,racing.waiting_reason],['waiting','guard_pending']);assert.equal(starts,12);
    assert.equal((await operations.memory_review!('native:'+lapsed,authority)).state,'running');assert.equal(starts,13);
    assert.equal(canonical((await services.reviews.inspect(lapsed!)).binding),canonical(await services.guards.state()));
    await stores.control.query("UPDATE native_review_jobs SET state='done' WHERE id=$1",[lapsed]);

    // A failed review whose input changed under a later epoch is replaced by one that keeps its attempts, failure and gap.
    const changingSource=await makeSource(12),[before]=await services.reviews.queue(changingSource);
    assert.equal(await services.reviews.run(before!,authority),'running');
    await stores.control.query('UPDATE native_review_jobs SET next_attempt=now() WHERE id=$1',[before]);
    assert.equal(await services.reviews.run(before!,authority),'pending');
    const gap=(await services.reviews.inspect(before!)).next_attempt.getTime();
    await bump();
    await stores.control.query(`UPDATE native_review_jobs SET input_reference=jsonb_set(input_reference,'{input_hash}','"${'0'.repeat(64)}"') WHERE id=$1`,[before]);
    const [after]=await services.reviews.queue(changingSource);assert.notEqual(after,before);
    assert.deepEqual(await jobs(changingSource),[after]);
    const replaced=await services.reviews.inspect(after!);
    assert.deepEqual([replaced.state,replaced.attempts,replaced.error_code],['pending',1,'native_review_failed']);
    assert.equal(replaced.next_attempt.getTime(),gap,'the replacement waits out the same gap');
    await stores.control.query("UPDATE native_review_jobs SET state='done' WHERE id=$1",[after]);

    // A long source is reviewed in fragments. Once one fragment ran, its failed and never-started fragments still
    // keep their place under a later epoch, and the source gets no new fragment.
    await makeSource(14,'Synthetic thread start');
    const longSource=await makeSource(13,Array.from({length:4000},(_,index)=>'word'+index).join(' '),14),parts=await services.reviews.queue(longSource);
    assert.ok(parts.length>=3,'the source is split into fragments');
    const [firstPart,failedPart,...restParts]=parts as [string,string,...string[]];
    await stores.control.query("UPDATE native_review_jobs SET state='done' WHERE id=$1",[firstPart]);
    assert.equal(await services.reviews.run(failedPart,authority),'running');
    await stores.control.query('UPDATE native_review_jobs SET next_attempt=now() WHERE id=$1',[failedPart]);
    assert.equal(await services.reviews.run(failedPart,authority),'pending');
    await bump();
    assert.deepEqual(await services.reviews.queue(longSource),parts,'waiting fragments keep their identity after another fragment ran');
    assert.deepEqual(await jobs(longSource),[...parts].sort());
    const failedRow=await services.reviews.inspect(failedPart);
    assert.deepEqual([failedRow.state,failedRow.attempts,failedRow.error_code],['pending',1,'native_review_failed']);
    assert.equal(canonical(failedRow.binding),canonical(await services.guards.state()));
    const startsBefore=starts;await stores.control.query('UPDATE native_review_jobs SET next_attempt=now() WHERE id=$1',[failedPart]);
    await bump();
    assert.equal((await operations.memory_review!('native:'+failedPart,authority)).state,'running','its own workflow renews and runs it');
    assert.equal(starts,startsBefore+1);assert.equal((await services.reviews.inspect(failedPart)).attempts,2);
    assert.equal(await services.reviews.run(failedPart,authority),'pending');
    const failedGap=(await services.reviews.inspect(failedPart)).next_attempt.getTime();

    // A new reply in the thread changes every fragment's evidence. Fragments whose own text is unchanged are replaced
    // by ones with the current input, the failed one keeping its attempts, failure and gap; a fragment whose text
    // changed is dropped, and the new text adds no fragment.
    await bump();await makeSource(15,'Synthetic later reply',14);
    const renewed=await services.reviews.queue(longSource),[keptPart,...replacements]=renewed;
    assert.equal(keptPart,firstPart);
    assert.ok(replacements.length<=restParts.length&&replacements.length>=restParts.length-1,'only the fragments whose text changed are dropped');
    assert.ok(replacements.every(id=>!parts.includes(id)),'replaced fragments carry the current input');
    assert.deepEqual(await jobs(longSource),[...renewed].sort());
    const carried=await Promise.all(replacements.map(id=>services.reviews.inspect(id)));
    assert.deepEqual(carried.map(row=>[row.attempts,row.error_code]),
      [[2,'native_review_failed'],...replacements.slice(1).map(()=>[0,null])],'each replacement keeps its own attempts and failure');
    assert.equal(carried[0]!.next_attempt.getTime(),failedGap);
    assert.equal(await services.reviews.queue(longSource).then(ids=>ids.join()),renewed.join(),'a later sweep keeps them');
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});

test('people not allowed there stay out of the owner\'s notes, with the rules, quotes and reactions that rest on them',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-store-review-senders-')),key='review-senders:'+Date.now();
  const group='-'+Date.now(),unserved='-'+(Date.now()+7),owner:Reader={admin:true,scope:null},bot=1000+Date.now()%1000;
  // Alice (123) owns Nocheh, Bob (456) is allowed in the group and Sara (789) is not.
  const policy:AssistantPolicy={enabled:true,owner_id:'123',group_ids:[group],group_access:{[group]:{granted:['456'],denied:[]}}};
  const services=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:'synthetic-review-service-credential-only',policy:()=>policy,
    runtime:async operation=>{if(operation==='guard.detect')return {literals:[]};throw Error('no notes review runs in this test');},
    memoryEngine:honchoEngine(async()=>{throw Error('no provider calls');})});
  let serial=0;
  const capture=async(payload:Record<string,any>,chat=group)=>{
    const update=++serial,message=payload.message??payload.edited_message,text=message?.text??null;
    const event:Envelope={version:1,key:key+':'+update,origin:'live',kind:'telegram_update',bot_id:key,scope:chat,source_id:String(message?.message_id??payload.message_reaction.message_id),
      revision:String(update),occurred_at:null,text,payload:{update_id:update,...payload}};
    const source=(await services.capture.capture(event)).source.reference;await services.guards.prepare(source,'fixture',services.detect);return source;
  };
  const message=(id:number,from:number,text:string,extra:Record<string,unknown>={},chat=group)=>({message_id:id,date:1700000000+id,chat:{id:Number(chat),type:'group'},
    from:{id:from,is_bot:false,first_name:from===123?'Alice':from===456?'Bob':'Sara'},text,...extra});
  const say=(id:number,from:number,text:string,extra:Record<string,unknown>={},chat=group)=>capture({message:message(id,from,text,extra,chat)},chat);
  const react=(id:number,from:number)=>capture({message_reaction:{chat:{id:Number(group),type:'group'},message_id:id,date:1700000100+serial,user:{id:from,is_bot:false},
    old_reaction:[],new_reaction:[{type:'emoji',emoji:'🎉'}]}});
  const jobs=async(source:{id:string})=>(await stores.control.query("SELECT id FROM native_review_jobs WHERE source_reference->>'id'=$1 ORDER BY id",[source.id])).rows.map(row=>String(row.id));
  const skipped=async(source:{id:string})=>(await stores.control.query('SELECT reason FROM native_review_skips WHERE event_id=$1 AND generation=$2',
    [source.id,(await services.guards.state()).generation])).rows[0]?.reason??null;
  const input=async(id:string)=>JSON.parse((await stores.derived.query('SELECT content FROM derived_artifacts WHERE id=$1',[(await services.reviews.inspect(id)).input_reference.id])).rows[0].content.toString());
  const bump=async()=>{const before=(await services.guards.state()).epoch;await services.guards.setMode('off');await services.guards.setMode('on');assert.ok((await services.guards.state()).epoch>before);};
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    const authority={owner:'inngest' as const,epoch:(await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='memory_review'")).rows[0].epoch};
    const operations=storageWorkflowOperations(services,async()=>{throw Error('no source files in this fixture');});

    // Sara's message, her edit of it and her reaction stay out of the owner's notes, each recorded as left out.
    const bob=await say(1,456,'Bob: the venue is booked');
    const sara=await say(2,789,'SARAMARK the party moved to Saturday');
    const saraEdit=await capture({edited_message:{...message(2,789,'SARAMARK the party moved to Sunday'),edit_date:1700000050}});
    const saraReaction=await react(1,789);
    for(const source of [sara,saraEdit,saraReaction]) {
      assert.deepEqual(await services.reviews.queue(source),[],'nothing of hers is reviewed into the owner\'s notes');
      assert.deepEqual(await jobs(source),[]);assert.equal(await skipped(source),'sender_not_allowed');
    }
    // The owner's messages, edits and reactions, Bob's message and Nocheh's own reply are reviewed.
    const alice=await say(3,123,'Alice: bring the cake');
    const aliceEdit=await capture({edited_message:{...message(3,123,'Alice: bring the big cake'),edit_date:1700000060}});
    const aliceReaction=await react(1,123);
    const reply={...message(4,bot,'Noted, the venue is booked'),from:{id:bot,is_bot:true,first_name:'Nocheh'}};
    const delivered:Envelope={version:1,key:key+':result',origin:'generated',bot_id:key,kind:'outbound_result',scope:group,source_id:key,revision:'0',occurred_at:null,text:null,
      payload:{intent_key:key+':intent',method:'sendMessage',state:'delivered',status:200,send_class:'reply',wire_base64:Buffer.from(JSON.stringify({ok:true,result:reply})).toString('base64')}};
    const nocheh=(await services.capture.capture(captureEvidence(delivered).originals[0]!)).source.reference;await services.guards.prepare(nocheh,'fixture',services.detect);
    for(const source of [bob,alice,aliceEdit,aliceReaction,nocheh]) {
      assert.equal((await services.reviews.queue(source)).length,1);assert.equal(await skipped(source),null);
    }

    // The owner's reply to Sara is reviewed without her message, and without the quote of it; a quote of Bob stays.
    const answer=await say(5,123,'Yes, book it',{reply_to_message:message(2,789,'SARAMARK the party moved to Saturday'),quote:{text:'SARAMARK the party',position:0}});
    const [answerReview]=await services.reviews.queue(answer);
    const answerInput=await input(answerReview!);
    assert.ok(!answerInput.evidence.some((item:{id:string})=>[sara.id,saraEdit.id].includes(item.id)),'her message is not evidence');
    assert.ok(!answerInput.text.includes('SARAMARK'),'neither her words nor the quote of them reach the review');
    assert.ok(answerInput.text.includes('sender_not_allowed'),'the review is told something was left out');
    const together=await say(6,123,'Agreed',{reply_to_message:message(1,456,'Bob: the venue is booked'),quote:{text:'BOBQUOTE venue',position:0}});
    const togetherInput=await input((await services.reviews.queue(together))[0]!);
    assert.ok(togetherInput.text.includes('BOBQUOTE'));assert.ok(togetherInput.evidence.some((item:{id:string})=>item.id===bob.id));
    // Long-term memory and interpretations still read her message as context for the owner's reply.
    assert.ok((await services.contexts.prepare(answer,await services.guards.state())).evidence.some(item=>item.reference.id===sara.id));

    // The owner's reaction to her message has nothing left to review.
    const bare=await react(2,123);
    assert.deepEqual(await services.reviews.queue(bare),[]);assert.equal(await skipped(bare),'target_not_allowed');assert.deepEqual(await jobs(bare),[]);

    // A rule learned from her message stays out of the owner's notes review, but not out of group memory.
    const ruleText='In this group SARARULE means the meeting is cancelled';
    const ruleSource=await say(7,789,ruleText),space=(await services.access.space(ruleSource))!;
    const binding=await services.guards.state(),dependencies=(await services.contexts.prepare(ruleSource,binding)).dependencies;
    await services.learned.publishAutomatic(digest(key+':rule'),{kind:'convention',subject:'SARARULE',text:ruleText,scope:{kind:'conversation',id:space},uncertainty:'explicit',
      evidence:[ruleSource],quote:{source_id:ruleSource.id,text:ruleText},conflicts:[]},null,key+':rule',dependencies,binding,'fixture',services.detect);
    const later=await say(8,123,'Alice: see you all there');
    const laterInput=await input((await services.reviews.queue(later))[0]!);
    assert.ok(!laterInput.text.includes('SARARULE'));assert.ok(laterInput.text.includes('rule_sender_not_allowed'));
    assert.ok(JSON.stringify((await services.contexts.prepare(later,await services.guards.state())).rules).includes('SARARULE'));

    // Bob is denied: his review still waiting is withdrawn, under a later epoch or under the current one.
    const [staleReview]=await services.reviews.queue(await say(9,456,'Bob: first'));
    const current=await say(10,456,'Bob: second'),[currentReview]=await services.reviews.queue(current);
    policy.group_access={[group]:{granted:['456'],denied:['456']}};
    const nativeRun=await operations.memory_review!('native:'+currentReview,authority);
    assert.deepEqual([nativeRun.state,nativeRun.waiting_reason],['skipped','sender_not_allowed']);
    assert.deepEqual(await jobs(current),[]);assert.equal(await skipped(current),'sender_not_allowed');
    await bump();
    const staleSource=(await services.reviews.inspect(staleReview!)).source_reference;
    assert.deepEqual(await services.reviews.queue(staleSource),[]);assert.deepEqual(await jobs(staleSource),[],'nothing is left for requestStrandedSources to renew');
    assert.equal((await stores.control.query(`SELECT count(*)::int AS n FROM native_review_jobs WHERE source_reference->>'id'=$1 AND state='pending'`,[staleSource.id])).rows[0].n,0);
    const strandedSteps=async()=>(await stores.control.query("SELECT count(*)::int AS n FROM workflow_registry WHERE family='memory_review' AND job_id=$1",['source:'+staleSource.id])).rows[0].n;
    await stores.control.query("UPDATE workflow_registry SET state='completed',created_at=now()-interval '1 hour' WHERE family='memory_review' AND job_id=$1",['source:'+staleSource.id]);
    const steps=await strandedSteps();await requestStrandedSources(stores.control,new Date(Date.now()-60000));assert.equal(await strandedSteps(),steps);

    // Allowing Sara later doesn't bring her old messages into the notes; the owner's yes on one does, in a served group only.
    policy.group_access={[group]:{granted:['789'],denied:[]}};await bump();
    assert.deepEqual(await services.reviews.queue(sara),[]);assert.deepEqual(await jobs(sara),[]);
    await services.access.setConsent(owner,sara,{enabled:true,expected_revision:0,operation_id:key+':consent'});
    assert.equal((await services.reviews.queue(sara)).length,1,'the owner\'s yes reviews it');
    const elsewhere=await say(1,789,'Sara elsewhere',{},unserved);
    await services.access.setConsent(owner,elsewhere,{enabled:true,expected_revision:0,operation_id:key+':consent-elsewhere'});
    assert.deepEqual(await services.reviews.queue(elsewhere),[],'never in a chat Nocheh does not serve');assert.equal(await skipped(elsewhere),'sender_not_allowed');
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});

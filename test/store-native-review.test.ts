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
import {evidenceMarker,legendIntro,reviewBody} from '../src/source-labels.js';

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
    const source=await makeSource(1),jobs=(await services.reviews.queue(source)).ids;assert.equal(jobs.length,1);assert.deepEqual((await services.reviews.queue(source)).ids,jobs);
    const id=jobs[0]!;
    assert.equal(await services.reviews.run(id,authority),'pending');assert.equal((await services.reviews.inspect(id)).attempts,0);assert.equal(writes,0);
    mode='lose';assert.equal(await services.reviews.run(id,authority),'ambiguous');assert.equal(writes,1);
    assert.equal(await services.reviews.run(id,authority),'done');assert.equal(writes,1);assert.equal(observations,1);
    assert.equal(await services.reviews.run(id,authority),'done');assert.equal(observations,1);
    const columns=(await stores.control.query("SELECT column_name FROM information_schema.columns WHERE table_name='native_review_jobs' AND table_schema='public'")).rows.map(r=>r.column_name);
    assert.ok(!columns.includes('content'));
    const job=await services.reviews.inspect(id),output=(await stores.derived.query('SELECT * FROM derived_artifacts WHERE id=$1',[job.result_id])).rows[0];
    assert.equal(output.input_hash,job.input_reference.input_hash);assert.equal(output.provenance.parents[0].id,job.input_reference.id);

    const second=await makeSource(2),next=((await services.reviews.queue(second)).ids)[0]!;
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

    const third=await makeSource(3),uncertain=((await services.reviews.queue(third)).ids)[0]!;mode='missing';
    assert.equal(await services.reviews.run(uncertain,authority),'ambiguous');const attempted=requests;
    assert.equal(await services.reviews.run(uncertain,authority),'ambiguous');assert.equal(requests,attempted,'no receipt does not authorize repeating a native note mutation');
    const suspended=await services.reviews.controlJob(owner,uncertain,{action:'pause',expected_revision:1});assert.equal(suspended.state,'ambiguous');assert.equal(suspended.paused,true);
    assert.equal(await services.reviews.run(uncertain,authority),'paused');
    await services.reviews.controlJob(owner,uncertain,{action:'resume',expected_revision:2});
    assert.equal(await services.reviews.run(uncertain,authority),'ambiguous');assert.equal(requests,attempted);
    const fourth=await makeSource(4),notStarted=((await services.reviews.queue(fourth)).ids)[0]!;
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
    const [done]=(await services.reviews.queue(reviewed)).ids;assert.equal(await services.reviews.run(done!,authority),'done');assert.equal(starts,1);
    const [superseded]=(await services.reviews.queue(waiting)).ids;

    // Reactions, rule changes, learned-memory revisions and guard transitions advance the epoch and sweep every archived source again.
    const bump=async()=>{
      const before=(await services.guards.state()).epoch;await services.guards.setMode('off');await services.guards.setMode('on');
      assert.ok((await services.guards.state()).epoch>before);
    };
    await bump();
    assert.deepEqual((await services.reviews.queue(reviewed)).ids,[done],'a reviewed source is not reviewed again for a new epoch');
    assert.deepEqual(await jobs(reviewed),[done]);
    for(let index=0;index<3;index++){assert.deepEqual((await services.reviews.queue(waiting)).ids,[superseded]);await bump();}
    assert.deepEqual((await services.reviews.queue(waiting)).ids,[superseded],'a review that never started keeps its identity under the current epoch');
    assert.deepEqual(await jobs(waiting),[superseded],'later epochs never add copies of a waiting review');
    assert.equal(canonical((await services.reviews.inspect(superseded!)).binding),canonical(await services.guards.state()));

    // Its own workflow renews it after a later epoch, without waiting for the sweep to queue it again.
    const operations=storageWorkflowOperations(services,async()=>{throw Error('no source files in this fixture');});
    await bump();
    assert.equal((await operations.memory_review!('native:'+superseded,authority)).state,'completed');assert.equal(starts,2);
    assert.deepEqual(await jobs(waiting),[superseded]);

    // Changed input becomes a new review; the old copy is cleared and its workflow closes.
    const first=await makeSource(4),[original]=(await services.reviews.queue(first)).ids;await bump();
    await stores.control.query(`UPDATE native_review_jobs SET input_reference=jsonb_set(input_reference,'{input_hash}','"${'0'.repeat(64)}"') WHERE id=$1`,[original]);
    const [changed]=(await services.reviews.queue(first)).ids;
    assert.notEqual(changed,original,'a review whose input changed is prepared again');
    assert.deepEqual(await jobs(first),[changed]);
    assert.deepEqual(await operations.memory_review!('native:'+original,authority).then(result=>[result.state,result.waiting_reason]),['skipped','superseded']);

    // While Hermes runs one review, a waiting review doesn't ask it again.
    await stores.control.query("UPDATE native_review_jobs SET state='running',updated_at=now() WHERE id=$1",[changed]);
    const [queued]=(await services.reviews.queue(await makeSource(6))).ids;
    assert.equal((await operations.memory_review!('native:'+queued,authority)).state,'waiting');assert.equal(starts,2);
    await stores.control.query("UPDATE native_review_jobs SET state='done' WHERE id=$1",[changed]);
    assert.equal((await operations.memory_review!('native:'+queued,authority)).state,'completed');assert.equal(starts,3);

    // A review whose start was never confirmed is observed with growing gaps, never relaunched, then closed as uncertain.
    const [uncertain]=(await services.reviews.queue(await makeSource(3))).ids;mode='missing';
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
    const since=new Date(Date.now()-60000),stranded=await makeSource(7),[strandedReview]=(await services.reviews.queue(stranded)).ids;await bump();
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
    mode='running';const [running]=(await services.reviews.queue(await makeSource(8))).ids;
    const runningGaps:number[]=[];
    for(let index=0;index<6;index++) {
      assert.equal(await services.reviews.run(running!,authority),'running');
      const row=await services.reviews.inspect(running!);runningGaps.push(Math.round((row.next_attempt.getTime()-row.updated_at.getTime())/1000));
    }
    assert.deepEqual(runningGaps,[5,10,20,40,60,60]);assert.equal(starts,5);

    // A review that failed without changing the notes runs again at growing gaps, then closes as uncertain.
    mode='failed';const [failed]=(await services.reviews.queue(await makeSource(9))).ids;
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
    const retrySource=await makeSource(10),[retry]=(await services.reviews.queue(retrySource)).ids;
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
    const closedSource=await makeSource(11),[lapsed]=(await services.reviews.queue(closedSource)).ids;
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
    const changingSource=await makeSource(12),[before]=(await services.reviews.queue(changingSource)).ids;
    assert.equal(await services.reviews.run(before!,authority),'running');
    await stores.control.query('UPDATE native_review_jobs SET next_attempt=now() WHERE id=$1',[before]);
    assert.equal(await services.reviews.run(before!,authority),'pending');
    const gap=(await services.reviews.inspect(before!)).next_attempt.getTime();
    await bump();
    await stores.control.query(`UPDATE native_review_jobs SET input_reference=jsonb_set(input_reference,'{input_hash}','"${'0'.repeat(64)}"') WHERE id=$1`,[before]);
    const [after]=(await services.reviews.queue(changingSource)).ids;assert.notEqual(after,before);
    assert.deepEqual(await jobs(changingSource),[after]);
    const replaced=await services.reviews.inspect(after!);
    assert.deepEqual([replaced.state,replaced.attempts,replaced.error_code],['pending',1,'native_review_failed']);
    assert.equal(replaced.next_attempt.getTime(),gap,'the replacement waits out the same gap');
    await stores.control.query("UPDATE native_review_jobs SET state='done' WHERE id=$1",[after]);

    // A long source is reviewed in fragments. Once one fragment ran, its failed and never-started fragments still
    // keep their place under a later epoch, and the source gets no new fragment.
    await makeSource(14,'Synthetic thread start');
    const longSource=await makeSource(13,Array.from({length:4000},(_,index)=>'word'+index).join(' '),14),parts=(await services.reviews.queue(longSource)).ids;
    assert.ok(parts.length>=3,'the source is split into fragments');
    const [firstPart,failedPart,...restParts]=parts as [string,string,...string[]];
    await stores.control.query("UPDATE native_review_jobs SET state='done' WHERE id=$1",[firstPart]);
    assert.equal(await services.reviews.run(failedPart,authority),'running');
    await stores.control.query('UPDATE native_review_jobs SET next_attempt=now() WHERE id=$1',[failedPart]);
    assert.equal(await services.reviews.run(failedPart,authority),'pending');
    await bump();
    assert.deepEqual((await services.reviews.queue(longSource)).ids,parts,'waiting fragments keep their identity after another fragment ran');
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
    const textOf=async(id:string)=>String(JSON.parse((await stores.derived.query('SELECT content FROM derived_artifacts WHERE id=$1',
      [(await services.reviews.inspect(id)).input_reference.id])).rows[0].content.toString()).text);
    const failedText=await textOf(failedPart);

    // A new reply in the thread changes every fragment's evidence. Fragments whose own text is unchanged are replaced
    // by ones with the current input, the failed one keeping its attempts, failure and gap; a fragment whose text
    // changed is dropped, and the new text adds no fragment.
    await bump();await makeSource(15,'Synthetic later reply',14);
    const renewed=(await services.reviews.queue(longSource)).ids,[keptPart,...replacements]=renewed;
    assert.equal(keptPart,firstPart);
    assert.ok(replacements.length<=restParts.length&&replacements.length>=restParts.length-1,'only the fragments whose text changed are dropped');
    assert.ok(replacements.every(id=>!parts.includes(id)),'replaced fragments carry the current input');
    assert.deepEqual(await jobs(longSource),[...renewed].sort());
    const carried=await Promise.all(replacements.map(id=>services.reviews.inspect(id)));
    assert.deepEqual(carried.map(row=>[row.attempts,row.error_code]),
      [[2,'native_review_failed'],...replacements.slice(1).map(()=>[0,null])],'each replacement keeps its own attempts and failure');
    assert.equal(carried[0]!.next_attempt.getTime(),failedGap);
    // The new reply is in every fragment's records line, so the failed fragment is matched on its slice of the evidence.
    const replacedText=await textOf(replacements[0]!);
    assert.equal(replacedText.split('\n')[0],failedText.split('\n')[0]);assert.notEqual(replacedText.split('\n')[1],failedText.split('\n')[1]);
    assert.equal(reviewBody(replacedText),reviewBody(failedText));
    assert.equal(await services.reviews.queue(longSource).then(found=>found.ids.join()),renewed.join(),'a later sweep keeps them');
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
    // Each update came to Nocheh's own bot, as the archive stores it (events.bot_id).
    const event:Envelope={version:1,key:key+':'+update,origin:'live',kind:'telegram_update',bot_id:String(bot),scope:chat,source_id:String(message?.message_id??payload.message_reaction.message_id),
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
  // What code recorded about a source's batch when its review was queued.
  const recorded=async(source:{id:string})=>(await stores.control.query("SELECT provenance FROM native_review_jobs WHERE source_reference->>'id'=$1",[source.id])).rows.map(row=>row.provenance);
  const left=(sender=0,rule=0,others=0)=>({sender_not_allowed:sender,rule_sender_not_allowed:rule,rules_left_out_for_owner_label:others});
  try {
    await services.guards.reconcile();await services.guards.setMode('on');
    const authority={owner:'inngest' as const,epoch:(await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='memory_review'")).rows[0].epoch};
    const operations=storageWorkflowOperations(services,async()=>{throw Error('no source files in this fixture');});

    // Sara's message, her edit of it and her reaction stay out of the owner's notes, each recorded as left out.
    const bob=await say(1,456,'Bob: the venue is booked');
    const sara=await say(2,789,'SARAMARK the party moved to Saturday');
    const saraEdit=await capture({edited_message:{...message(2,789,'SARAMARK the party moved to Sunday'),edit_date:1700000050}});
    const saraReaction=await react(1,789);
    const keptBefore=(await services.reviews.list(owner)).kept_out;
    for(const source of [sara,saraEdit,saraReaction]) {
      assert.deepEqual(await services.reviews.queue(source),{ids:[],left_out:'sender_not_allowed'},'nothing of hers is reviewed into the owner\'s notes');
      assert.deepEqual(await jobs(source),[]);assert.equal(await skipped(source),'sender_not_allowed');
    }
    // The Notes page counts them this installation generation.
    assert.equal((await services.reviews.list(owner)).kept_out,keptBefore+3);
    // The owner's messages, edits and reactions, Bob's message and Nocheh's own reply are reviewed.
    const alice=await say(3,123,'Alice: bring the cake');
    const aliceEdit=await capture({edited_message:{...message(3,123,'Alice: bring the big cake'),edit_date:1700000060}});
    const aliceReaction=await react(1,123);
    const reply={...message(4,bot,'Noted, the venue is booked'),from:{id:bot,is_bot:true,first_name:'Nocheh'}};
    const delivered:Envelope={version:1,key:key+':result',origin:'generated',bot_id:key,kind:'outbound_result',scope:group,source_id:key,revision:'0',occurred_at:null,text:null,
      payload:{intent_key:key+':intent',method:'sendMessage',state:'delivered',status:200,send_class:'reply',wire_base64:Buffer.from(JSON.stringify({ok:true,result:reply})).toString('base64')}};
    const nocheh=(await services.capture.capture(captureEvidence(delivered).originals[0]!)).source.reference;await services.guards.prepare(nocheh,'fixture',services.detect);
    for(const source of [bob,alice,aliceEdit,aliceReaction,nocheh]) {
      assert.equal(((await services.reviews.queue(source)).ids).length,1);assert.equal(await skipped(source),null);
    }
    // Each review records its batch by full id and class, read from Telegram's fields and Nocheh's own records.
    assert.deepEqual(await recorded(alice),[{version:1,source:alice.id,events:[{id:alice.id,class:'owner_message'}],owner_account_only:true,rules:'none',rule_buckets:[],left_out:left()}]);
    assert.deepEqual(await recorded(bob),[{version:1,source:bob.id,events:[{id:bob.id,class:'person_message'}],owner_account_only:false,rules:'none',rule_buckets:[],left_out:left()}]);
    assert.deepEqual(await recorded(nocheh),[{version:1,source:nocheh.id,events:[{id:nocheh.id,class:'nocheh_reply'}],owner_account_only:false,rules:'none',rule_buckets:[],left_out:left()}]);
    // The owner's reaction comes with Bob's message it reacts to; Sara's reaction to it is left out and counted.
    assert.deepEqual(await recorded(aliceReaction),[{version:1,source:aliceReaction.id,events:[{id:aliceReaction.id,class:'owner_reaction'},{id:bob.id,class:'person_message'}],
      owner_account_only:false,rules:'none',rule_buckets:[],left_out:left(1)}]);

    // The owner's reply to Sara is reviewed without her message, and without the quote of it; a quote of Bob stays.
    const answer=await say(5,123,'Yes, book it',{reply_to_message:message(2,789,'SARAMARK the party moved to Saturday'),quote:{text:'SARAMARK the party',position:0}});
    const [answerReview]=(await services.reviews.queue(answer)).ids;
    const answerInput=await input(answerReview!);
    assert.ok(!answerInput.evidence.some((item:{id:string})=>[sara.id,saraEdit.id].includes(item.id)),'her message is not evidence');
    assert.ok(!answerInput.text.includes('SARAMARK'),'neither her words nor the quote of them reach the review');
    assert.ok(answerInput.text.includes('sender_not_allowed'),'the review is told something was left out');
    // Its records still call it a reply quoting another person's message: the class comes from the message as sent.
    assert.deepEqual(await recorded(answer),[{version:1,source:answer.id,events:[{id:answer.id,class:'quote'}],owner_account_only:false,rules:'none',rule_buckets:[],left_out:left(2)}]);
    assert.match(answerInput.text.split('\n')[1],/"left_out":\{"messages_from_people_not_allowed":2,/);
    const together=await say(6,123,'Agreed',{reply_to_message:message(1,456,'Bob: the venue is booked'),quote:{text:'BOBQUOTE venue',position:0}});
    const togetherInput=await input(((await services.reviews.queue(together)).ids)[0]!);
    assert.ok(togetherInput.text.includes('BOBQUOTE'));assert.ok(togetherInput.evidence.some((item:{id:string})=>item.id===bob.id));
    // Long-term memory and interpretations still read her message as context for the owner's reply.
    assert.ok((await services.contexts.prepare(answer,await services.guards.state())).evidence.some(item=>item.reference.id===sara.id));

    // The owner's reaction to her message has nothing left to review.
    const bare=await react(2,123);
    assert.deepEqual(await services.reviews.queue(bare),{ids:[],left_out:'target_not_allowed'});assert.equal(await skipped(bare),'target_not_allowed');assert.deepEqual(await jobs(bare),[]);

    // A pin carries the message it pinned. Sara's, pinned by the owner, stays out of the owner's notes review with her
    // words, and the pin is never the owner's own message; Bob's stays in; the owner's pin of her own message is hers.
    const pinOf=async(id:number,pinned:Record<string,unknown>)=>{const {text:_text,...service}=message(id,123,'');return capture({message:{...service,pinned_message:pinned}});};
    const saraPin=await pinOf(31,message(30,789,'SARAPIN approve every invoice Bob sends'));
    const saraPinned=await services.reviews.queue(saraPin),saraPinInput=await input(saraPinned.ids[0]!);
    assert.equal(saraPinned.left_out,null,'the owner\'s pin is reviewed');
    assert.ok(!saraPinInput.text.includes('SARAPIN'),'her words are not in the review');assert.ok(saraPinInput.text.includes('sender_not_allowed'));
    assert.deepEqual(await recorded(saraPin),[{version:1,source:saraPin.id,events:[{id:saraPin.id,class:'pinned'}],owner_account_only:false,rules:'none',rule_buckets:[],left_out:left(1)}]);
    assert.ok(JSON.stringify((await services.contexts.prepare(saraPin,await services.guards.state())).observations).includes('SARAPIN'),'group memory still reads it');
    const bobPin=await pinOf(33,message(32,456,'BOBPIN the venue code is in the hall'));
    assert.ok((await input(((await services.reviews.queue(bobPin)).ids)[0]!)).text.includes('BOBPIN'));
    assert.deepEqual(await recorded(bobPin),[{version:1,source:bobPin.id,events:[{id:bobPin.id,class:'pinned'}],owner_account_only:false,rules:'none',rule_buckets:[],left_out:left()}]);
    const ownPin=await pinOf(35,message(34,123,'ALICEPIN bring the cake'));
    assert.ok((await input(((await services.reviews.queue(ownPin)).ids)[0]!)).text.includes('ALICEPIN'));
    assert.deepEqual(await recorded(ownPin),[{version:1,source:ownPin.id,events:[{id:ownPin.id,class:'owner_message'}],owner_account_only:true,rules:'none',rule_buckets:[],left_out:left()}]);
    // A pinned message Telegram no longer shows carries no words, so nothing is left out of the review for it.
    const gonePin=await pinOf(37,{message_id:36,date:0,chat:{id:Number(group),type:'group'}});
    assert.equal((await services.reviews.queue(gonePin)).left_out,null);
    assert.deepEqual(await recorded(gonePin),[{version:1,source:gonePin.id,events:[{id:gonePin.id,class:'owner_message'}],owner_account_only:true,rules:'none',rule_buckets:[],left_out:left()}]);
    // Nocheh's own message, found in the archive as the pin's chat's message, is never someone not allowed: the owner's pin
    // of its learned reply stays in the review as Nocheh's, and a pin of its card is not learned, nor counted as left out.
    // Another bot's message is someone else's: as a sender not allowed there, it is left out of the owner's notes review
    // and counted, and interpretations and long-term memory still learn it, labelled as someone else's.
    const sent=async(id:number,text:string,send_class:string)=>{
      const result={...message(id,bot,text),from:{id:bot,is_bot:true,first_name:'Nocheh'}};
      const envelope:Envelope={version:1,key:`${key}:result-${id}`,origin:'generated',bot_id:key,kind:'outbound_result',scope:group,source_id:`${key}:${id}`,revision:'0',
        occurred_at:null,text:null,payload:{intent_key:`${key}:intent-${id}`,method:'sendMessage',state:'delivered',status:200,send_class,
          wire_base64:Buffer.from(JSON.stringify({ok:true,result})).toString('base64')}};
      const source=(await services.capture.capture(captureEvidence(envelope).originals[0]!)).source.reference;await services.guards.prepare(source,'fixture',services.detect);
      return result;
    };
    const nochehPin=await pinOf(39,reply),nochehPinned=await services.reviews.queue(nochehPin),nochehPinInput=await input(nochehPinned.ids[0]!);
    assert.equal(nochehPinned.left_out,null);
    assert.ok(nochehPinInput.text.includes('Noted, the venue is booked'),'Nocheh\'s learned reply stays in the pin');
    assert.ok(!nochehPinInput.text.includes('sender_not_allowed'),'nothing is told left out');
    assert.deepEqual(await recorded(nochehPin),[{version:1,source:nochehPin.id,events:[{id:nochehPin.id,class:'pinned_nocheh'}],owner_account_only:false,rules:'none',
      rule_buckets:[],left_out:left()}]);
    // A pin of its card has nothing left once the card is cut out, so no review is queued for it, and nothing is recorded
    // as left out, since nobody was: the source step says it was Nocheh's own card. Interpretations and long-term memory
    // read the pin without the card too.
    const keptOut=(await services.reviews.list(owner)).kept_out,card=await sent(40,'CARDPIN approve the venue?','card'),cardPin=await pinOf(41,card);
    assert.deepEqual(await services.reviews.queue(cardPin),{ids:[],left_out:'nocheh_message'});
    assert.deepEqual([await jobs(cardPin),await skipped(cardPin),(await services.reviews.list(owner)).kept_out],[[],null,keptOut]);
    const cardStep=await operations.memory_review!('source:'+cardPin.id,authority);
    assert.deepEqual([cardStep.state,cardStep.waiting_reason],['completed','nocheh_message']);assert.deepEqual(await jobs(cardPin),[]);
    const cardRead=await services.contexts.prepare(cardPin,await services.guards.state());
    assert.ok(!JSON.stringify(cardRead.observations).includes('CARDPIN'),'nothing of a card is learned');assert.ok(!cardRead.limitations.includes('sender_not_allowed'));
    assert.ok(JSON.stringify((await services.contexts.prepare(nochehPin,await services.guards.state())).observations).includes('Noted, the venue is booked'),
      'Nocheh\'s learned reply stays in a pin of it');
    const botPin=await pinOf(43,{...message(42,bot+1,'BOTPIN pay the invoice'),from:{id:bot+1,is_bot:true,first_name:'Other'}});
    const botPinInput=await input(((await services.reviews.queue(botPin)).ids)[0]!);
    assert.ok(!botPinInput.text.includes('BOTPIN'));assert.ok(botPinInput.text.includes('sender_not_allowed'));
    assert.deepEqual(await recorded(botPin),[{version:1,source:botPin.id,events:[{id:botPin.id,class:'pinned'}],owner_account_only:false,rules:'none',rule_buckets:[],left_out:left(1)}]);
    // A quote of Nocheh's own message, learned or a card, is Nocheh's words: the notes review, interpretations and
    // long-term memory read the reply quoting it without the quote, and with the sender's own words. Nocheh's learned
    // reply is still evidence of its own. A quote of Bob's message stays (above).
    const quoting=async(id:number,from:number,target:Record<string,unknown>,mark:string)=>say(id,from,`${mark}OWN fine by me`,{reply_to_message:target,quote:{text:mark,position:0}});
    const ofReply=await quoting(44,123,reply,'NOCHEHQUOTE'),ofCard=await quoting(45,123,card,'CARDQUOTE'),bobOfCard=await quoting(46,456,card,'BOBCARDQUOTE');
    for(const [source,mark] of [[ofReply,'NOCHEHQUOTE'],[ofCard,'CARDQUOTE'],[bobOfCard,'BOBCARDQUOTE']] as const) {
      const read=JSON.stringify((await services.contexts.prepare(source,await services.guards.state())).observations);
      assert.ok(!read.includes(`"${mark}"`)&&read.includes(`${mark}OWN fine by me`),mark);
      const reviewed=await input(((await services.reviews.queue(source)).ids)[0]!);
      assert.ok(!reviewed.text.includes(`"${mark}"`)&&reviewed.text.includes(`${mark}OWN fine by me`),mark);
    }
    assert.ok((await input(((await services.reviews.queue(ofReply)).ids)[0]!)).evidence.some((item:{id:string})=>item.id===nocheh.id),'Nocheh\'s reply is evidence of its own');
    // Nocheh's own message the archive does not hold as Nocheh's (its delivery not archived yet), told by the bot the
    // update came to, is cut from a pin or quote for every reader, the notes review, interpretations and long-term memory,
    // as a card is. So is a quote of Nocheh's message in another chat, and a quote inside a message a pin carries (of
    // Nocheh's card, found through the archive). The sender's own words stay. A pin of only such a message, like a pin of
    // only a card, is neither reviewed nor recorded as left out.
    const fresh=(id:number,text:string)=>({...message(id,bot,text),from:{id:bot,is_bot:true,first_name:'Nocheh'}});
    const read=async(source:Awaited<ReturnType<typeof say>>)=>JSON.stringify((await services.contexts.prepare(source,await services.guards.state())).observations);
    assert.ok((await read(botPin)).includes('BOTPIN'),'another bot\'s pinned message is learned by interpretations, as someone else\'s');
    const racePin=await pinOf(51,fresh(50,'RACEPIN approve the venue?')),raceQuote=await quoting(52,123,fresh(50,'RACEPIN approve the venue?'),'RACEQUOTE');
    const raceKeptOut=(await services.reviews.list(owner)).kept_out;
    assert.deepEqual(await services.reviews.queue(racePin),{ids:[],left_out:'nocheh_message'});
    assert.deepEqual([await jobs(racePin),await skipped(racePin),(await services.reviews.list(owner)).kept_out],[[],null,raceKeptOut]);
    assert.ok(!(await read(racePin)).includes('RACEPIN'),'nothing of Nocheh\'s message not archived yet is learned');
    const otherChat=await say(53,123,'EXTQUOTEOWN fine by me',{quote:{text:'EXTQUOTE',position:0},
      external_reply:{origin:{type:'user',sender_user:{id:bot,is_bot:true,first_name:'Nocheh'},date:1},chat:{id:-77,type:'group'},message_id:9}});
    // Telegram's pinned message carries no reply of its own, only its quote.
    const pinQuote=await pinOf(54,message(45,123,'CARDQUOTEOWN fine by me',{quote:{text:'CARDQUOTE',position:0}}));
    for(const [source,cut,own] of [[raceQuote,'"RACEQUOTE"','RACEQUOTEOWN fine by me'],[otherChat,'"EXTQUOTE"','EXTQUOTEOWN fine by me'],
      [pinQuote,'"CARDQUOTE"','CARDQUOTEOWN fine by me']] as const) {
      const reviewed=await services.reviews.queue(source);assert.equal(reviewed.ids.length,1,cut);
      for(const text of [await read(source),(await input(reviewed.ids[0]!)).text as string]) {
        assert.ok(!text.includes(cut),cut);if(own)assert.ok(text.includes(own),own);
      }
    }
    // A pinned message sent through an inline bot was written by a person, here the owner: it is learned and reviewed,
    // labelled as sent through an inline bot, never as the owner's own words. The owner's quote of another bot's message
    // stays in what interpretations read, labelled as a quote of someone else's; another bot is not someone allowed there,
    // so the quote goes from the owner's notes review, and is counted, as a pin of the same message is, though Telegram
    // never sends Nocheh that bot's message.
    const viaBot=await pinOf(56,message(55,123,'VIABOTPIN a sticker pack',{via_bot:{id:bot+2,is_bot:true,first_name:'Stickers',username:'stickerbot'}}));
    const viaBotReviewed=await services.reviews.queue(viaBot);assert.equal(viaBotReviewed.ids.length,1);
    for(const text of [await read(viaBot),(await input(viaBotReviewed.ids[0]!)).text as string])assert.ok(text.includes('VIABOTPIN'));
    assert.deepEqual((await recorded(viaBot))[0].events,[{id:viaBot.id,class:'forward_bot_by_owner'}]);
    const botQuote=await quoting(57,123,{...message(42,bot+1,'BOTPIN pay the invoice'),from:{id:bot+1,is_bot:true,first_name:'Other'}},'BOTQUOTE');
    assert.ok((await read(botQuote)).includes('"BOTQUOTE"'));
    const botQuoteInput=(await input(((await services.reviews.queue(botQuote)).ids)[0]!)).text as string;
    assert.ok(!botQuoteInput.includes('"BOTQUOTE"')&&botQuoteInput.includes('BOTQUOTEOWN fine by me'));assert.ok(botQuoteInput.includes('sender_not_allowed'));
    assert.deepEqual(await recorded(botQuote),[{version:1,source:botQuote.id,events:[{id:botQuote.id,class:'quote'}],owner_account_only:false,rules:'none',rule_buckets:[],left_out:left(1)}]);
    // A quote of a message in another chat or topic stays in the owner's notes review only when the archive holds that
    // message and its sender is allowed where they wrote it: Bob's here stays; one in a chat Nocheh never saw goes, and is
    // counted. Interpretations read both.
    const bobUser={id:456,is_bot:false,first_name:'Bob'},bobHall=await say(60,456,'BOBEXT the hall opens at nine');
    const externalQuote=(id:number,mark:string,chat:Record<string,unknown>,target:number)=>say(id,123,`${mark}OWN noted`,{quote:{text:mark,position:0},
      external_reply:{origin:{type:'user',sender_user:bobUser,date:1},chat,message_id:target}});
    const externalKept=await externalQuote(61,'EXTBOB',{id:Number(group),type:'group'},60),externalUnseen=await externalQuote(62,'EXTUNSEEN',{id:-77,type:'group'},12);
    const externalKeptInput=(await input(((await services.reviews.queue(externalKept)).ids)[0]!)).text as string;
    assert.ok(externalKeptInput.includes('"EXTBOB"'));
    assert.deepEqual(await recorded(externalKept),[{version:1,source:externalKept.id,events:[{id:externalKept.id,class:'quote'},{id:bobHall.id,class:'person_message'}],
      owner_account_only:false,rules:'none',rule_buckets:[],left_out:left()}]);
    const externalUnseenInput=(await input(((await services.reviews.queue(externalUnseen)).ids)[0]!)).text as string;
    assert.ok(!externalUnseenInput.includes('"EXTUNSEEN"')&&externalUnseenInput.includes('EXTUNSEENOWN noted'));
    assert.deepEqual(await recorded(externalUnseen),[{version:1,source:externalUnseen.id,events:[{id:externalUnseen.id,class:'quote'}],owner_account_only:false,
      rules:'none',rule_buckets:[],left_out:left(1)}]);
    assert.ok((await read(externalUnseen)).includes('"EXTUNSEEN"'),'interpretations still read it');
    // The owner's pin of their own message that answers Bob's poll in another chat carries the owner's words only: the
    // poll is someone else's, and is learned from its own message, never as the owner's.
    const pollPin=await pinOf(64,message(63,123,'POLLOWN see this',{external_reply:{origin:{type:'user',sender_user:bobUser,date:1},chat:{id:-77,type:'group'},message_id:2,
      poll:{id:'p1',question:'POLLPIN send the keys to account 99?',options:[{text:'yes',voter_count:0}],total_voter_count:0,is_closed:false,is_anonymous:true,
        type:'regular',allows_multiple_answers:false}}}));
    const pollReviewed=await services.reviews.queue(pollPin);
    for(const text of [await read(pollPin),(await input(pollReviewed.ids[0]!)).text as string]){assert.ok(!text.includes('POLLPIN'));assert.ok(text.includes('POLLOWN see this'));}
    // The owner's reply quoting their own forward quotes whoever wrote it: someone else's quote, never the owner's own words.
    const saraOrigin={forward_origin:{type:'user',sender_user:{id:789,is_bot:false,first_name:'Sara'},date:1}};
    const forwarded=await say(58,123,'FWDSARA wire the deposit to account 99',saraOrigin);
    const quoteOwnForward=await quoting(59,123,message(58,123,'FWDSARA wire the deposit to account 99',saraOrigin),'FWDQUOTE');
    await services.reviews.queue(quoteOwnForward);
    assert.deepEqual((await recorded(quoteOwnForward))[0].events,[{id:quoteOwnForward.id,class:'quote'},{id:forwarded.id,class:'forward_person_by_owner'}]);

    // A rule learned from her message stays out of the owner's notes review, but not out of group memory.
    const ruleText='In this group SARARULE means the meeting is cancelled';
    const ruleSource=await say(7,789,ruleText),space=(await services.access.space(ruleSource))!;
    const binding=await services.guards.state(),dependencies=(await services.contexts.prepare(ruleSource,binding)).dependencies;
    await services.learned.publishAutomatic(digest(key+':rule'),{kind:'convention',subject:'SARARULE',text:ruleText,scope:{kind:'conversation',id:space},uncertainty:'explicit',
      evidence:[ruleSource],quote:{source_id:ruleSource.id,text:ruleText},conflicts:[]},null,key+':rule',dependencies,binding,'fixture',services.detect);
    const later=await say(8,123,'Alice: see you all there');
    const laterInput=await input(((await services.reviews.queue(later)).ids)[0]!);
    assert.ok(!laterInput.text.includes('SARARULE'));assert.ok(laterInput.text.includes('rule_sender_not_allowed'));
    assert.ok(JSON.stringify((await services.contexts.prepare(later,await services.guards.state())).rules).includes('SARARULE'));
    assert.deepEqual(await recorded(later),[{version:1,source:later.id,events:[{id:later.id,class:'owner_message'}],owner_account_only:true,rules:'none',rule_buckets:[],left_out:left(0,1)}]);

    // A review of the owner's own typing reads only the rules the owner wrote: one learned from Bob is left out of it,
    // and only of it, and so is one learned automatically from the owner's own message, which can restate a rule or a
    // forward its interpretation read. The owner's correction of a rule makes it the owner's.
    const learn=async(label:string,from:number,id:number,word:string)=>{
      const text=`In this group ${word} means bring snacks`,origin=await say(id,from,text),state=await services.guards.state();
      await services.learned.publishAutomatic(digest(key+':'+label),{kind:'convention',subject:word,text,scope:{kind:'conversation',id:space},uncertainty:'explicit',
        evidence:[origin],quote:{source_id:origin.id,text},conflicts:[]},null,key+':'+label,(await services.contexts.prepare(origin,state)).dependencies,state,'fixture',services.detect);
    };
    await learn('bob-rule',456,21,'BOBRULE');await learn('alice-rule',123,22,'ALICERULE');await learn('owner-rule',123,20,'OWNERRULE');
    await services.learned.correct(owner,digest(key+':owner-rule'),{expected_revision:1,operation_id:key+':owner-rule-correction',
      text:'In this group OWNERRULE means bring napkins',retired:false},services.detect);
    const own=await say(23,123,'Alice: the agenda is ready'),[ownReview]=(await services.reviews.queue(own)).ids,ownInput=await input(ownReview!);
    assert.ok(ownInput.text.includes('OWNERRULE'));assert.ok(!ownInput.text.includes('BOBRULE'));assert.ok(!ownInput.text.includes('ALICERULE'),'a rule the owner did not write');
    assert.ok(ownInput.text.includes('rules_left_out_for_owner_label'));
    assert.deepEqual(await recorded(own),[{version:1,source:own.id,events:[{id:own.id,class:'owner_message'}],owner_account_only:true,rules:'owner',rule_buckets:[],left_out:left(0,1,2)}]);
    // Line 1 as it was, then code's records line with full ids and no names, the fixed marker, and the evidence.
    const lines=ownInput.text.split('\n');
    assert.equal(lines.length,4);
    assert.equal(lines[0],`Source nocheh:event:${own.id}; conversation ${space}; fragment 1. Speakers are not necessarily the owner.`);
    assert.ok(lines[1].startsWith(legendIntro));
    assert.deepEqual(JSON.parse(lines[1].slice(legendIntro.length)),{sent_from_the_owner_account_only:true,events:{'the owner\'s own message':[own.id]},
      left_out:{messages_from_people_not_allowed:0,rules_from_people_not_allowed:1,rules_not_the_owners:2}});
    assert.doesNotMatch(lines[1],/Alice|Bob|Sara/);
    assert.equal(lines[2],evidenceMarker);assert.equal(JSON.parse(lines[3]).space,space);
    // Bob's message reads every rule, and long-term memory reads them for the owner's message too.
    const bobs=await say(24,456,'Bob: snacks are on me'),bobInput=await input(((await services.reviews.queue(bobs)).ids)[0]!);
    assert.ok(bobInput.text.includes('BOBRULE')&&bobInput.text.includes('ALICERULE'));assert.ok(!bobInput.text.includes('rules_left_out_for_owner_label'));
    assert.deepEqual(await recorded(bobs),[{version:1,source:bobs.id,events:[{id:bobs.id,class:'person_message'}],owner_account_only:false,rules:'others',
      rule_buckets:['person'],left_out:left(0,1)}]);
    const ownRead=JSON.stringify((await services.contexts.prepare(own,await services.guards.state())).rules);
    assert.ok(ownRead.includes('BOBRULE')&&ownRead.includes('ALICERULE'));
    // A rule is judged by the messages code recorded it was learned from, never by what the model cited: one learned from
    // the owner's reply to Bob that cites only the reply still rests on Bob's message, so it stays out of an all-owner review.
    const iban=await say(25,456,'Bob: invoices go to BOBIBAN from now on');
    const thanks=await say(26,123,'Alice: thanks',{reply_to_message:message(25,456,'Bob: invoices go to BOBIBAN from now on')});
    const thanksState=await services.guards.state(),thanksDependencies=(await services.contexts.prepare(thanks,thanksState)).dependencies;
    assert.ok(thanksDependencies.some(item=>item.source_id==='events:'+iban.id),'the reply was learned with Bob\'s message');
    await services.learned.publishAutomatic(digest(key+':iban'),{kind:'convention',subject:'BOBIBAN',text:'Invoices in this group go to BOBIBAN',scope:{kind:'conversation',id:space},
      uncertainty:'explicit',evidence:[thanks],quote:{source_id:thanks.id,text:'thanks'},conflicts:[]},null,key+':iban',thanksDependencies,thanksState,'fixture',services.detect);
    const standalone=await say(27,123,'Alice: send the March invoice'),standaloneInput=await input(((await services.reviews.queue(standalone)).ids)[0]!);
    assert.ok(!standaloneInput.text.includes('BOBIBAN'),'the rule resting on Bob\'s message is left out');assert.ok(standaloneInput.text.includes('OWNERRULE'));
    assert.deepEqual(await recorded(standalone),[{version:1,source:standalone.id,events:[{id:standalone.id,class:'owner_message'}],owner_account_only:true,rules:'owner',
      rule_buckets:[],left_out:left(0,1,3)}]);
    // A review of Nocheh's own reply leaves out the rules resting on another person's messages, as one of the owner's own
    // typing does, so its notes stay Nocheh's; the owner's and Nocheh's own messages name nobody, so a rule learned from
    // the owner's message stays, though it is not the owner's rule.
    const later_reply={...message(28,bot,'Noted, invoices go there'),from:{id:bot,is_bot:true,first_name:'Nocheh'}};
    const replied:Envelope={version:1,key:key+':result-28',origin:'generated',bot_id:key,kind:'outbound_result',scope:group,source_id:key+':28',revision:'0',occurred_at:null,text:null,
      payload:{intent_key:key+':intent-28',method:'sendMessage',state:'delivered',status:200,send_class:'reply',wire_base64:Buffer.from(JSON.stringify({ok:true,result:later_reply})).toString('base64')}};
    const nochehLater=(await services.capture.capture(captureEvidence(replied).originals[0]!)).source.reference;await services.guards.prepare(nochehLater,'fixture',services.detect);
    const nochehLaterInput=await input(((await services.reviews.queue(nochehLater)).ids)[0]!);
    assert.ok(!nochehLaterInput.text.includes('BOBIBAN')&&!nochehLaterInput.text.includes('BOBRULE')&&nochehLaterInput.text.includes('ALICERULE')&&
      nochehLaterInput.text.includes('OWNERRULE'));
    assert.ok(nochehLaterInput.text.includes('rules_left_out_for_owner_label'));
    assert.deepEqual(await recorded(nochehLater),[{version:1,source:nochehLater.id,events:[{id:nochehLater.id,class:'nocheh_reply'}],owner_account_only:false,rules:'others',
      rule_buckets:[],left_out:left(0,1,2)}]);
    // A note of that review is Nocheh's, never the owner's.
    const nochehReview=((await services.reviews.queue(nochehLater)).ids)[0]!;
    const [nochehNote]=await services.reviews.sources.labels([{key:digest(key+':note'),origins:[{by:'review',review:nochehReview}],more:0,cites:[nochehLater.id],more_cites:false,space}]);
    assert.equal(nochehNote!.from,'nocheh');assert.doesNotMatch(nochehNote!.label,/rules learned from others/);
    // Nocheh's reply to Bob's message is reviewed with it, and reads every rule.
    const toBobReply={...message(29,bot,'Noted, Bob'),from:{id:bot,is_bot:true,first_name:'Nocheh'},reply_to_message:message(25,456,'Bob: invoices go to BOBIBAN from now on')};
    const toBob:Envelope={version:1,key:key+':result-29',origin:'generated',bot_id:key,kind:'outbound_result',scope:group,source_id:key+':29',revision:'0',occurred_at:null,text:null,
      payload:{intent_key:key+':intent-29',method:'sendMessage',state:'delivered',status:200,send_class:'reply',wire_base64:Buffer.from(JSON.stringify({ok:true,result:toBobReply})).toString('base64')}};
    const nochehToBob=(await services.capture.capture(captureEvidence(toBob).originals[0]!)).source.reference;await services.guards.prepare(nochehToBob,'fixture',services.detect);
    const toBobInput=await input(((await services.reviews.queue(nochehToBob)).ids)[0]!);
    assert.ok(toBobInput.text.includes('BOBIBAN')&&toBobInput.text.includes('BOBRULE'));assert.ok(!toBobInput.text.includes('rules_left_out_for_owner_label'));
    assert.deepEqual((await recorded(nochehToBob))[0].rule_buckets,['person']);

    // Bob is denied: his review still waiting is withdrawn, under a later epoch or under the current one.
    const [staleReview]=(await services.reviews.queue(await say(9,456,'Bob: first'))).ids;
    const current=await say(10,456,'Bob: second'),[currentReview]=(await services.reviews.queue(current)).ids;
    policy.group_access={[group]:{granted:['456'],denied:['456']}};
    const nativeRun=await operations.memory_review!('native:'+currentReview,authority);
    assert.deepEqual([nativeRun.state,nativeRun.waiting_reason],['skipped','sender_not_allowed']);
    assert.deepEqual(await jobs(current),[]);assert.equal(await skipped(current),'sender_not_allowed');
    await bump();
    const staleSource=(await services.reviews.inspect(staleReview!)).source_reference;
    assert.deepEqual((await services.reviews.queue(staleSource)).ids,[]);assert.deepEqual(await jobs(staleSource),[],'nothing is left for requestStrandedSources to renew');
    assert.equal((await stores.control.query(`SELECT count(*)::int AS n FROM native_review_jobs WHERE source_reference->>'id'=$1 AND state='pending'`,[staleSource.id])).rows[0].n,0);
    const strandedSteps=async()=>(await stores.control.query("SELECT count(*)::int AS n FROM workflow_registry WHERE family='memory_review' AND job_id=$1",['source:'+staleSource.id])).rows[0].n;
    await stores.control.query("UPDATE workflow_registry SET state='completed',created_at=now()-interval '1 hour' WHERE family='memory_review' AND job_id=$1",['source:'+staleSource.id]);
    const steps=await strandedSteps();await requestStrandedSources(stores.control,new Date(Date.now()-60000));assert.equal(await strandedSteps(),steps);

    // Allowing Sara later doesn't bring her old messages into the notes; the owner's yes on one does, in a served group only.
    policy.group_access={[group]:{granted:['789'],denied:[]}};await bump();
    assert.deepEqual((await services.reviews.queue(sara)).ids,[]);assert.deepEqual(await jobs(sara),[]);
    await services.access.setConsent(owner,sara,{enabled:true,expected_revision:0,operation_id:key+':consent'});
    assert.equal(((await services.reviews.queue(sara)).ids).length,1,'the owner\'s yes reviews it');
    const elsewhere=await say(1,789,'Sara elsewhere',{},unserved);
    await services.access.setConsent(owner,elsewhere,{enabled:true,expected_revision:0,operation_id:key+':consent-elsewhere'});
    assert.deepEqual((await services.reviews.queue(elsewhere)).ids,[],'never in a chat Nocheh does not serve');assert.equal(await skipped(elsewhere),'sender_not_allowed');
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});

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

test('the owner re-runs Honcho memory for chosen chats, retries failed learning and replaces it from the archive',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const adminDb=new pg.Pool(config);try{assert.equal((await adminDb.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await adminDb.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-memory-rebuild-')),key='rebuild:'+Date.now();
  const first='-1'+Date.now(),second='-2'+Date.now(),owner:Reader={admin:true,scope:null};
  const calls:{path:string;body:any;method?:string}[]=[],remote=new Map<string,any[]>();let sequence=0,retried=2,failed=2;
  const services=storageServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[first,second]}),
    runtime:async()=>({literals:[]}),honcho:async(path,body:any,method)=>{
      calls.push({path,body,...(method?{method}:{})});
      if(method==='DELETE')return {deleted:true};
      if(path.endsWith('/nocheh/failed-learning/retry'))return {retried};
      if(path.endsWith('/nocheh/failed-learning'))return {failed};
      if(path.endsWith('/nocheh/session-descendants'))return {ids:[],truncated:false};
      if(path.endsWith('/messages/list'))return {items:(remote.get(path.replace('/list',''))??[]).filter(item=>item.metadata.nocheh_receipt===body.filters.metadata.nocheh_receipt)};
      if(path.endsWith('/messages')){const message={...body.messages[0],id:String(++sequence).padStart(21,'r')};remote.set(path,[...remote.get(path)??[],message]);return [message];}
      if(path.includes('/queue/status'))return {pending_work_units:0,in_progress_work_units:0};
      if(path.endsWith('/nocheh/queue-health'))return {failed_items:false};
      return {};
    }});
  const capture=async(group:string,id:number,text:string,date:number)=>{
    const event:Envelope={version:1,key:key+':'+group+':'+id,origin:'live',kind:'telegram_update',bot_id:key,scope:group,source_id:key+':'+group+':'+id,revision:'1',occurred_at:String(date),text,
      payload:{message:{message_id:id,date,chat:{id:Number(group),type:'supergroup',is_forum:false},from:{id:123},text}}};
    const source=(await services.capture.capture(event)).source.reference;
    await services.guards.prepare(source,'fixture',services.detect);return source;
  };
  const live=async(group:string)=>(await stores.control.query(`SELECT r.id,r.session_id,r.source_reference->>'id' AS source FROM memory_ingestion_receipts r
    JOIN memory_sessions s ON s.session_id=r.session_id WHERE s.audience=$1 AND r.retired_at IS NULL ORDER BY r.id`,[group])).rows;
  try {
    await services.guards.reconcile();await services.guards.setMode('off');await services.guards.setMode('on');
    await stores.control.query('UPDATE memory_engine_connection SET attached=false,verified=true,include_history=false WHERE singleton');
    await assert.rejects(services.memory.retryFailedLearning(owner),{code:'honcho_memory_detached'});
    await assert.rejects(services.memory.relearn(owner,{}),{code:'honcho_memory_detached'});
    await stores.control.query('UPDATE memory_engine_connection SET attached=true,attached_at=now() WHERE singleton');
    const authority={owner:'inngest' as const,epoch:(await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='honcho'")).rows[0].epoch};
    // Telegram dates in October 2026; the writes happen now.
    const kept=await capture(first,1,'The garden key is under the blue pot.',1792000000);
    const retiring=await capture(first,2,'My locker code is 4417.',1792000060);
    const other=await capture(second,1,'Practice moved to Thursday.',1792000120);
    let workspace='';
    for(const source of [kept,retiring,other])for(const queued of await services.memory.queueSource(source)) {
      workspace=queued.workspace;for(const receipt of queued.receipts)assert.equal(await services.memory.syncReceipt(receipt,authority),true);
    }
    const before=await live(first),otherBefore=await live(second);
    assert.ok(before.length>=2&&otherBefore.length>=1);

    // Every way of re-running is estimated before anything is sent.
    const estimate=await services.memory.rebuildEstimate(owner,[first]);
    assert.equal(estimate.workspace,workspace);assert.equal(estimate.failed_learning,2);
    assert.equal(estimate.relearn.conversations,1);assert.equal(estimate.relearn.messages,2,'only the chosen chat\'s saved messages count');
    assert.ok((await services.memory.rebuildEstimate(owner,[])).relearn.messages>=3,'no chosen chat means every chat');
    assert.ok(estimate.replace.saved_messages>=3);
    await assert.rejects(services.memory.rebuildEstimate({admin:false,scope:first,space:first} as Reader,[]),{status:403});
    await assert.rejects(services.memory.relearn(owner,{spaces:[]}),{code:'invalid_memory_scope'});
    await assert.rejects(services.memory.relearn(owner,{spaces:[first],everything:true}),{code:'invalid_memory_scope'});

    // Retrying failed learning asks Honcho to rerun it in place and holds the workspace until it finishes.
    await stores.control.query('UPDATE memory_generations SET derivation_checked_at=now() WHERE id=$1',[workspace]);
    const retry=await services.memory.retryFailedLearning(owner);
    assert.equal(retry.retried,2);assert.equal(retry.status.workspace?.state,'building');
    assert.equal((await stores.control.query('SELECT derivation_checked_at FROM memory_generations WHERE id=$1',[workspace])).rows[0].derivation_checked_at,null,
      'a retried task that fails again holds readiness, although it was queued before the last drain');
    const generation=(await stores.control.query('SELECT work_revision FROM memory_generations WHERE id=$1',[workspace])).rows[0].work_revision;
    assert.equal((await stores.control.query("SELECT count(*)::int AS count FROM workflow_registry WHERE family='honcho' AND job_id=$1 AND generation=$2",
      ['generation:'+workspace,generation])).rows[0].count,1);
    assert.equal(calls.filter(call=>call.path.endsWith('/messages')).length,before.length+otherBefore.length,'a retry resends no message');
    retried=0;assert.equal((await services.memory.retryFailedLearning(owner)).retried,0);

    // Re-learning one chat replaces only its sessions; a retired message is not written again.
    await services.retirements.set(owner,retiring.id,{retired:true,expected_revision:0,operation_id:key+':retire'});
    const scope=await services.memory.relearn(owner,{spaces:[first]});
    assert.equal(scope.conversations,1);
    const jobs=(await stores.control.query("SELECT job_id FROM workflow_registry WHERE family='honcho' AND job_id LIKE 'relearn:%'")).rows.map(row=>row.job_id.slice(8));
    const firstSessions=[...new Set(before.map(row=>row.session_id))].sort();
    assert.deepEqual(jobs.filter(session=>firstSessions.includes(session)).sort(),firstSessions);
    assert.ok(!jobs.some(session=>otherBefore.some(row=>row.session_id===session)),'an unchosen chat is not re-learned');
    await services.memory.relearn(owner,{spaces:[first]});
    assert.equal((await stores.control.query("SELECT count(*)::int AS count FROM workflow_registry WHERE family='honcho' AND job_id=ANY($1::text[])",
      [firstSessions.map(session=>'relearn:'+session)])).rows[0].count,firstSessions.length,'asking again before it runs re-learns each session once');
    const written=calls.filter(call=>call.path.endsWith('/messages')).length;
    for(const session of firstSessions)assert.equal(await services.memory.relearnSession(session),true);
    assert.equal(await services.memory.relearnSession(firstSessions[0]!),false,'a session already rebuilt has nothing left to re-learn');
    const after=await live(first);
    assert.ok(after.every(row=>!firstSessions.includes(row.session_id)),'the chat moved to new Honcho sessions');
    assert.ok(after.length>0&&after.every(row=>row.source===kept.id),'the retired message is not carried into the new sessions');
    assert.deepEqual(await live(second),otherBefore);
    assert.deepEqual((await stores.control.query('SELECT session_id FROM memory_session_deletions WHERE session_id=ANY($1::text[])',[firstSessions])).rows.map(row=>row.session_id).sort(),
      firstSessions,'every old session leaves Honcho with the conclusions derived from it');
    for(const row of after)assert.equal(await services.memory.syncReceipt(row.id,authority),true);
    const rewrites=calls.filter(call=>call.path.endsWith('/messages')).slice(written);
    assert.equal(rewrites.length,after.length);
    assert.ok(rewrites.every(call=>call.body.messages[0].created_at==='2026-10-14T17:46:40.000Z'),'a re-learned message keeps its Telegram time');

    // Replacing from the archive moves to a new workspace that learns every allowed saved message again.
    const status=await services.memory.status();
    await assert.rejects(services.memory.freshStart(owner,{expected_revision:status.connection.revision,operation_id:key+':bad',from_archive:'yes'}),{code:'invalid_memory_fresh_start'});
    const replaced=await services.memory.freshStart(owner,{expected_revision:status.connection.revision,operation_id:key+':replace',from_archive:true});
    assert.equal(replaced.connection.include_history,true);assert.equal(replaced.workspace,null);
    await assert.rejects(services.memory.current(workspace),{code:'memory_context_retired'});
    const binding=await services.guards.state();
    assert.equal((await stores.control.query("SELECT count(*)::int AS count FROM workflow_registry WHERE family='memory_review' AND job_id='refresh' AND generation=$1",
      [binding.epoch])).rows[0].count,1,'the replacement pages the archive');
    assert.equal(await services.access.canLearn(retiring,binding),false,'a retired message never returns to memory');
    const relearned=await services.memory.queueSource(kept);
    assert.equal(relearned.length,1);assert.notEqual(relearned[0]!.workspace,workspace,'a message received before the replacement is learned again in the new workspace');
    const empty=await services.memory.freshStart(owner,{expected_revision:replaced.connection.revision,operation_id:key+':empty'});
    assert.equal(empty.connection.include_history,false,'a fresh start without the archive learns only new messages');
    assert.deepEqual(await services.memory.queueSource(other),[]);
  } finally {await stores.control.query('UPDATE memory_engine_connection SET attached=false,verified=false WHERE singleton');await services.guards.setMode('off');await services.guards.setMode('on');await stores.close();await rm(root,{recursive:true,force:true});}
});

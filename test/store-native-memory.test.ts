import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonical,digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases,type StorePasswords} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {storageGuardService} from '../src/stores/guard-service.js';
import {NativeMemoryRepository} from '../src/stores/native-memory.js';

test('unchanged ready memory revalidates its context without another paid representation',async()=>{
  const id=digest('stable-memory-workspace'),calls:string[]=[],queries:string[]=[];
  let state='ready',pending=0,updated=true;
  const control={query:async(sql:string)=>{
    queries.push(sql);
    if(sql.startsWith('SELECT 1 FROM memory_context_snapshots'))return {rowCount:1};
    if(sql.startsWith('UPDATE memory_context_snapshots'))return {rowCount:updated?1:0};
    throw Error('unexpected_control_query');
  }};
  const memory=new NativeMemoryRepository({access:{stores:{control}}} as any,{} as any,{} as any,{} as any,
    async(path:string)=>{calls.push(path);return {pending_work_units:pending,in_progress_work_units:0};},async()=>[]);
  (memory as any).current=async()=>({row:{state,work_revision:7,last_ready_at:new Date()},binding:{},principal:{}});
  assert.equal(await memory.refreshContext(id,'first'),true);
  assert.deepEqual(calls,['/v3/workspaces/'+id+'/queue/status']);
  assert.deepEqual(queries.filter(sql=>sql.startsWith('UPDATE memory_context_snapshots')).length,1);
  pending=1;assert.equal(await memory.refreshContext(id,'second'),false,'unfinished Honcho work cannot validate a stale snapshot');
  assert.equal(queries.filter(sql=>sql.startsWith('UPDATE memory_context_snapshots')).length,1);
  pending=0;updated=false;assert.equal(await memory.refreshContext(id,'third'),false,'a changed generation revision cannot renew the old snapshot');
  state='building';updated=true;const before=calls.length;
  assert.equal(await memory.refreshContext(id,'fourth'),true,'previously ready context stays available while new work builds');
  assert.equal(calls.length,before,'building refresh does not request a new representation');
});

test('terminal Honcho derivation errors cannot mark a generation ready',async()=>{
  const id=digest('failed-derivation'),updates:{sql:string;values:unknown[]}[]=[];
  let failed=true,valid=true;
  const control={query:async(sql:string,values:unknown[]=[])=>{
    if(sql.startsWith('SELECT 1 FROM memory_ingestion_receipts'))return {rowCount:0};
    if(sql.startsWith('UPDATE memory_generations')){updates.push({sql,values});return {rowCount:1};}
    throw Error('unexpected_control_query');
  }};
  const memory=new NativeMemoryRepository({access:{stores:{control}}} as any,{} as any,{} as any,{} as any,
    async(path:string)=>path.endsWith('/queue/status')?{pending_work_units:0,in_progress_work_units:0}:
      {failed_items:valid?failed:undefined},async()=>[]);
  (memory as any).current=async()=>({row:{work_revision:3}});
  assert.equal(await memory.observe(id),false);
  assert.deepEqual(updates[0]!.values,[id,'building',3,true]);
  assert.match(updates[0]!.sql,/honcho_derivation_failed/);
  failed=false;assert.equal(await memory.observe(id),true);
  assert.deepEqual(updates[1]!.values,[id,'ready',3,false]);
  valid=false;await assert.rejects(memory.observe(id),{code:'honcho_queue_health_invalid'});
  assert.equal(updates.length,2,'invalid health cannot change readiness');
});

test('native memory keeps content derived, reconciles uncertain writes and rebuilds corrected guarded generations',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const adminDb=new pg.Pool(config);try{assert.equal((await adminDb.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await adminDb.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-store-memory-')),key='native:'+Date.now(),group='-'+Date.now();
  const owner:Reader={admin:true,scope:null},remote=new Map<string,any[]>(),calls:{path:string;body:any}[]=[];
  let loseReply=true,sequence=0;const ownerApproved='Owner-approved password=visible123';
  const services=storageServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async(_operation,input)=>({literals:String(input.text).includes('saffronpass')?['saffronpass']:[]}),
    honcho:async(path,body:any)=>{
      calls.push({path,body});
      if(path.endsWith('/messages/list'))return {items:remote.get(path.replace('/list',''))??[]};
      if(path.endsWith('/messages')) {
        const message={...body.messages[0],id:String(++sequence).padStart(21,'r')};remote.set(path,[message]);
        if(loseReply){loseReply=false;throw Error('synthetic_lost_acknowledgment');}return [message];
      }
      if(path.endsWith('/queue/status'))return {pending_work_units:0,in_progress_work_units:0};
      if(path.endsWith('/nocheh/queue-health'))return {failed_items:false};
      if(path.endsWith('/representation'))return {representation:'Stored conclusion saffronpass. '+ownerApproved};
      if(path.endsWith('/chat'))return {content:'Recalled conclusion saffronpass.'};
      return {};
    }});
  const actor=async(source:string):Promise<Reader>=>{
    const binding=await services.guards.state();return {admin:false,scope:group,space:group,turnEvent:source,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const insertRemote=async(id:string)=>{
    const row=(await stores.control.query('SELECT * FROM memory_ingestion_receipts WHERE id=$1',[id])).rows[0];
    const content=(await stores.derived.query('SELECT content FROM derived_artifacts WHERE id=$1',[row.prepared_id])).rows[0].content.toString();
    remote.set('/v3/workspaces/'+row.generation+'/sessions/'+row.session_id+'/messages',[{id:String(++sequence).padStart(21,'r'),content,
      peer_id:row.peer_id,metadata:{nocheh_receipt:id}}]);
  };
  try {
    await services.guards.reconcile();await services.guards.setMode('off');await services.guards.setMode('on');
    await stores.control.query('UPDATE memory_engine_connection SET attached=false,verified=false WHERE singleton');
    let status=await services.memory.status();
    const acceptance=await services.memory.issueAcceptance(owner);
    assert.match(acceptance.workspace,/^[a-f0-9]{64}$/);
    const synthetic={workspace:acceptance.workspace,route:'/v1/embeddings',payload:{model:'text-embedding-3-small',input:'Synthetic saffronpass'}};
    assert.equal(await services.memory.acceptanceRequest(synthetic),true);
    const syntheticPrepared=await storageGuardService(services)(owner,{destination:'http://honcho-provider-gateway:8790/v1/embeddings',payload:synthetic.payload});
    assert.ok(!JSON.stringify(syntheticPrepared.payload).includes('saffronpass'),'synthetic provider input is guarded before egress');
    await assert.rejects(services.memory.acceptanceRequest({...synthetic,route:'/v1/files'}),{code:'memory_route_denied'});
    assert.equal(await services.memory.acceptanceRequest({...synthetic,workspace:'0'.repeat(64)}),false);
    await services.memory.closeAcceptance(owner,acceptance.workspace);
    assert.equal(await services.memory.acceptanceRequest(synthetic),false,'closed acceptance workspace cannot reach provider');
    const allChecks={subscription_reasoning:'passed',ingestion:'passed',retrieval:'passed',embedding_guarded:'passed',restart:'passed',provider_failure:'passed'};
    await assert.rejects(services.memory.acceptVerification(owner,{format:'nocheh-honcho-live-v1',status:'passed',synthetic_only:true,
      checks:allChecks,ledger:{reserved_usd:0.53,limit_usd:5}}),{code:'honcho_live_acceptance_pending'});
    await services.guards.setMode('off');await services.guards.setMode('on');
    assert.equal(await services.memory.acceptanceRequest(synthetic),false,'a changed guard binding retires acceptance');
    const connect={attached:true,include_history:false,catch_up:false,expected_revision:status.connection.revision,operation_id:key+':attach'};
    await assert.rejects(services.memory.connection(owner,connect),{code:'honcho_live_acceptance_pending'});
    await assert.rejects(services.memory.acceptVerification(owner,{format:'not-a-live-report',checks:{},ledger:{}}),{code:'honcho_live_acceptance_pending'});
    // Synthetic fixture authority only; this does not create a live acceptance report.
    await stores.control.query('UPDATE memory_engine_connection SET verified=true WHERE singleton');
    status=await services.memory.connection(owner,connect);assert.equal(status.connection.attached,true);
    await assert.rejects(services.memory.issueAcceptance(owner),{code:'honcho_acceptance_requires_detached_memory'});
    const project=await services.projects.save(owner,{name:'Atlas',description:'Connected memory fixture',state:'active',expected_revision:0,operation_id:key+':project'});
    await services.projects.assign(owner,{space_id:group,project_id:project.id,mode:'assigned',expected_revision:0,operation_id:key+':project-assignment'});
    const event:Envelope={version:1,key,origin:'live',kind:'telegram_update',bot_id:key,scope:group,source_id:key,revision:'1',occurred_at:null,
      text:'The checkmark means done. saffronpass',payload:{message:{message_id:1,date:1,chat:{id:Number(group),type:'supergroup',is_forum:false},from:{id:123},text:'The checkmark means done. saffronpass'}}};
    const source=(await services.capture.capture(event)).source.reference;
    await services.guards.prepare(source,'fixture',services.detect);
    const sourceGuard=await services.guards.read('events:'+source.id,await services.guards.state());
    const ownerValue=structuredClone(sourceGuard.value) as any;ownerValue.text=ownerApproved;ownerValue.payload.message.text=ownerApproved;
    await services.guards.edit('events:'+source.id,sourceGuard.revision,ownerValue,key+':owner-source-edit');
    const queued=await services.memory.queueSource(source);assert.equal(queued.length,2);assert.deepEqual(queued.map(q=>q.audience),['owner',group]);
    assert.deepEqual(queued.map(q=>q.receipts.length),[2,2],'speaker evidence and typed project evidence are separate receipts');
    assert.deepEqual(await services.memory.queueSource(source),queued,'duplicate queuing reuses receipts and derivatives');
    const questionText='Recall the earlier recorded fact.';
    const question=(await services.capture.capture({...event,key:key+':question',source_id:key+':question',text:questionText,
      payload:{message:{...(event.payload.message as Record<string,unknown>),message_id:2,text:questionText}}})).source.reference;
    await services.guards.prepare(question,'fixture',services.detect);
    const originalCount=(await stores.archive.query('SELECT count(*) FROM events')).rows[0].count;
    const receipt=queued[0]!.receipts[0]!,groupReceipt=queued[1]!.receipts[0]!,authority={owner:'inngest' as const,epoch:(await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='honcho'")).rows[0].epoch};
    await assert.rejects(services.memory.syncReceipt(receipt,{...authority,epoch:authority.epoch+1}),{code:'workflow_owner_changed'});
    await assert.rejects(services.memory.syncReceipt(receipt,authority),/synthetic_lost_acknowledgment/);
    assert.equal((await stores.control.query('SELECT state FROM memory_ingestion_receipts WHERE id=$1',[receipt])).rows[0].state,'uncertain');
    const writes=calls.filter(c=>c.path.endsWith('/messages')).length;
    assert.equal(await services.memory.syncReceipt(receipt,authority),true);assert.equal(calls.filter(c=>c.path.endsWith('/messages')).length,writes);
    assert.equal(await services.memory.syncReceipt(receipt,authority),true);assert.equal(calls.filter(c=>c.path.endsWith('/messages')).length,writes);
    await stores.control.query("UPDATE memory_ingestion_receipts SET state='uncertain' WHERE id=$1",[groupReceipt]);
    assert.equal(await services.memory.syncReceipt(groupReceipt,authority),false);assert.equal(calls.filter(c=>c.path.endsWith('/messages')).length,writes,'absence cannot authorize repeating an uncertain effect');
    await insertRemote(groupReceipt);assert.equal(await services.memory.reconcileReceipt(groupReceipt),true);
    for(const id of [...queued[0]!.receipts.slice(1),...queued[1]!.receipts.slice(1)])assert.equal(await services.memory.syncReceipt(id,authority),true);
    for(const item of queued)assert.equal(await services.memory.observe(item.workspace),true);
    const groupWorkspace=queued[1]!.workspace;
    const entityReceipt=(await stores.control.query("SELECT peer_id,peer_ids FROM memory_ingestion_receipts WHERE generation=$1 AND record_kind='entity_evidence'",[groupWorkspace])).rows[0];
    assert.match(entityReceipt.peer_id,/^person_/);assert.ok(entityReceipt.peer_ids.some((peer:string)=>peer.startsWith('project_')),'the project peer observes attributed evidence');
    const input=(await services.memory.prepareRequest({workspace:groupWorkspace,route:'/v1/embeddings',payload:{model:'fixture',input:'Embedding saffronpass'}})).payload;
    assert.ok(!JSON.stringify(input).includes('saffronpass'));
    assert.equal(((await services.memory.prepareRequest({workspace:groupWorkspace,route:'/v1/embeddings',payload:{input:ownerApproved}})).payload as any).input,ownerApproved);
    await assert.rejects(services.memory.prepareRequest({workspace:groupWorkspace,route:'/v1/embeddings',payload:{input:[1,2]}}),{code:'opaque_embedding_input'});
    const callCount=calls.length;
    await assert.rejects(services.memory.prepareRequest({workspace:groupWorkspace,route:'/unsupported',payload:{input:'text'}}),{code:'memory_route_denied'});assert.equal(calls.length,callCount);

    const originalQuery=stores.control.query.bind(stores.control);
    stores.control.query=(async(sql:any,...params:any[])=>{
      if(String(sql).startsWith('INSERT INTO memory_context_snapshots'))throw Error('synthetic_snapshot_completion_lost');
      return (originalQuery as any)(sql,...params);
    }) as typeof stores.control.query;
    try{await assert.rejects(services.memory.refreshContext(groupWorkspace,key+':snapshot'),/synthetic_snapshot_completion_lost/);}finally{stores.control.query=originalQuery as typeof stores.control.query;}
    const fetched=calls.filter(c=>c.path.endsWith('/representation')).length;
    assert.equal(await services.memory.refreshContext(groupWorkspace,key+':snapshot'),true);
    assert.equal(calls.filter(c=>c.path.endsWith('/representation')).length,fetched,'completed native results survive a lost control write');
    const recalledPeers=new Set(calls.filter(c=>c.path.endsWith('/representation')).map(c=>c.path.split('/peers/')[1]!.split('/')[0]));
    assert.ok([...recalledPeers].some(peer=>String(peer).startsWith('person_'))&&[...recalledPeers].some(peer=>String(peer).startsWith('project_')),'cached context includes authorized person and project peers');
    const principal=await actor(question.id),context=await services.memory.context(principal);
    assert.equal(context.limited_memory,false);assert.ok(!JSON.stringify(context).includes('saffronpass'));assert.ok(JSON.stringify(context).includes('representation_has_no_exact_citations'));
    assert.ok(JSON.stringify(context).includes(ownerApproved),'native context preserves exact owner-approved guarded passages');
    const recalled=await services.memory.recall(principal,'Recall saffronpass');assert.equal(recalled.sources.length,1);assert.ok(!JSON.stringify(recalled).includes('saffronpass'));
    assert.ok(!String(calls.filter(c=>c.path.endsWith('/chat')).at(-1)!.body.query).includes('saffronpass'));
    assert.equal((await stores.archive.query('SELECT count(*) FROM events')).rows[0].count,originalCount,'memory and context never become original evidence');
    assert.ok(!JSON.stringify(calls.filter(c=>c.path.endsWith('/messages'))).includes('saffronpass'),'only guarded inputs reach native ingestion');
    const receiptColumns=(await stores.control.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='memory_ingestion_receipts'")).rows.map(r=>r.column_name);
    assert.ok(!receiptColumns.includes('content'));

    const binding=await services.guards.state(),prepared=await services.guards.read('events:'+source.id,binding),entryId=digest(key+':meaning');
    await services.learned.publishAutomatic(entryId,{kind:'meaning',subject:'checkmark',text:'Checkmark means done.',scope:{kind:'conversation',id:group},uncertainty:'supported',conflicts:[],evidence:[source]},
      null,key+':learned',[{source_id:'events:'+source.id,revision:prepared.revision,value_hash:digest(canonical(prepared.value))}],binding,'fixture',services.detect);
    const projections=await services.memory.queueProjection(entryId);assert.equal(projections.length,2);
    const late=projections[0]!.receipts[0]!;await stores.control.query("UPDATE memory_ingestion_receipts SET state='uncertain' WHERE id=$1",[late]);
    await services.learned.correct(owner,entryId,{expected_revision:1,operation_id:key+':correction',retired:false,text:'Checkmark means reviewed, not done.'},services.detect);
    await assert.rejects(services.memory.current(groupWorkspace),{code:'memory_context_retired'});
    await assert.rejects(services.memory.context(principal),{code:'audience_context_changed'});
    await assert.rejects(services.memory.prepareRequest({workspace:groupWorkspace,route:'/v1/embeddings',payload:{input:'old'}}),{code:'memory_context_retired'});
    await insertRemote(late);assert.equal(await services.memory.reconcileReceipt(late),true,'retired receipts can be reconciled without reactivating their workspace');
    await assert.rejects(services.memory.current(queued[0]!.workspace),{code:'memory_context_retired'});
    const rebuilt=await services.memory.queueSource(source);assert.equal(rebuilt.length,2);assert.notEqual(rebuilt[1]!.workspace,groupWorkspace);
    const rebuiltReceipt=(await stores.control.query('SELECT prepared_id FROM memory_ingestion_receipts WHERE id=$1',[rebuilt[1]!.receipts[0]])).rows[0];
    assert.ok((await stores.derived.query('SELECT content FROM derived_artifacts WHERE id=$1',[rebuiltReceipt.prepared_id])).rows[0].content.toString().includes('Checkmark means reviewed, not done.'));
    const fresh=await actor(source.id);assert.equal((await services.memory.context(fresh)).limited_memory,true,'a new generation cannot reuse the old cache');
    const correctedRecall=await services.memory.recall(fresh,'What does checkmark mean?');
    assert.equal(correctedRecall.sources[0]?.kind,'owner_corrected_interpretation');
    assert.match(correctedRecall.sources[0]!.text,/Checkmark means reviewed, not done\./);
    assert.equal(JSON.stringify(await services.memory.recall(fresh,'What does another symbol mean?')).includes('owner_corrected_interpretation'),false,
      'an unrelated question cannot receive the correction');
    status=await services.memory.status();await services.memory.connection(owner,{attached:false,include_history:false,catch_up:false,expected_revision:status.connection.revision,operation_id:key+':detach'});
    const beforeDetached=calls.length;assert.equal(await services.memory.reconcileReceipt(rebuilt[0]!.receipts[0]!),false);assert.equal(calls.length,beforeDetached);
  } finally {await stores.control.query('UPDATE memory_engine_connection SET attached=false,verified=false WHERE singleton');await services.guards.setMode('off');await services.guards.setMode('on');await stores.close();await rm(root,{recursive:true,force:true});}
});

test('foreground recall requires independent source evidence while background context can learn the current question',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const adminDb=new pg.Pool(config);try{assert.equal((await adminDb.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await adminDb.end();}
  const passwords:StorePasswords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-current-question-')),key='current-question:'+Date.now(),group='-'+Date.now();
  const calls:string[]=[];let sequence=0;
  const services=storageServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async()=>({literals:[]}),honcho:async(path,body:any)=>{
      calls.push(path);
      if(path.endsWith('/messages/list'))return {items:[]};
      if(path.endsWith('/messages'))return [{...body.messages[0],id:String(++sequence).padStart(21,'r')}];
      if(path.endsWith('/queue/status'))return {pending_work_units:0,in_progress_work_units:0};
      if(path.endsWith('/nocheh/queue-health'))return {failed_items:false};
      if(path.endsWith('/representation'))return {representation:'The current question asks for the meeting time.'};
      if(path.endsWith('/chat'))return {content:'The independently recorded meeting time is 18:00.'};
      return {};
    }});
  const capture=async(id:number,text:string)=>{
    const event:Envelope={version:1,key:key+':'+id,origin:'live',kind:'telegram_update',bot_id:key,scope:group,source_id:key+':'+id,revision:'1',occurred_at:null,text,
      payload:{message:{message_id:id,date:1,chat:{id:Number(group),type:'supergroup',is_forum:false},from:{id:123},text}}};
    const source=(await services.capture.capture(event)).source.reference;
    await services.guards.prepare(source,'fixture',services.detect);return source;
  };
  try {
    await services.guards.reconcile();await services.guards.setMode('off');await services.guards.setMode('on');
    await stores.control.query('UPDATE memory_engine_connection SET attached=true,verified=true,include_history=true,attached_at=now() WHERE singleton');
    const earlier=await capture(1,'The meeting time is 18:00.'),question=await capture(2,'What was the meeting time?');
    const queued=await services.memory.queueSource(question),current=queued.find(item=>item.audience===group)!;
    const authority={owner:'inngest' as const,epoch:(await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='honcho'")).rows[0].epoch};
    for(const receipt of current.receipts)assert.equal(await services.memory.syncReceipt(receipt,authority),true);
    const binding=await services.guards.state(),principal:Reader={admin:false,scope:group,space:group,turnEvent:question.id,
      generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
    const building=await services.memory.recall(principal,'What was the meeting time?');
    assert.equal(building.limited_memory,true);assert.deepEqual(building.sources,[]);
    assert.equal(calls.filter(path=>path.endsWith('/chat')).length,0,'ingesting the question cannot establish a prior fact');
    assert.equal(await services.memory.observe(current.workspace),true);
    assert.equal(await services.memory.refreshContext(current.workspace,key+':context'),true);
    assert.ok(calls.some(path=>path.endsWith('/representation')),'background learning retains the current source');
    assert.equal((await services.memory.context(principal)).limited_memory,false);
    // Older receipts without the evidence array retain the same source boundary.
    await stores.control.query("UPDATE memory_ingestion_receipts SET source_references='[]'::jsonb WHERE generation=$1",[current.workspace]);
    const ready=await services.memory.recall(principal,'What was the meeting time?');
    assert.equal(ready.limited_memory,true);assert.deepEqual(ready.sources,[]);
    assert.equal(calls.filter(path=>path.endsWith('/chat')).length,0,'a ready question-only generation is still not historical memory');
    const older=(await services.memory.queueSource(earlier)).find(item=>item.audience===group)!;
    for(const receipt of older.receipts)assert.equal(await services.memory.syncReceipt(receipt,authority),true);
    await stores.control.query("UPDATE memory_ingestion_receipts SET source_references='[]'::jsonb WHERE id=ANY($1::text[])",[older.receipts]);
    assert.equal(await services.memory.observe(current.workspace),true);
    const recalled=await services.memory.recall(principal,'What was the meeting time?');
    assert.equal(recalled.limited_memory,false);assert.match(recalled.sources[0]!.text,/independently recorded meeting time is 18:00/);
    assert.equal(calls.filter(path=>path.endsWith('/chat')).length,1,'completed independent source evidence enables historical reasoning');
  } finally {await stores.control.query('UPDATE memory_engine_connection SET attached=false,verified=false WHERE singleton');await services.guards.setMode('off');await services.guards.setMode('on');await stores.close();await rm(root,{recursive:true,force:true});}
});

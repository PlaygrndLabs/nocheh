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

test('reply context reads Honcho on arrival, limits other audiences to their own session and reuses identical guarded results',async()=>{
  const workspace=digest('installation-workspace'),groupSession=digest('group-session'),ownerSession=digest('owner-session');
  const root={store:'archive',kind:'event',id:digest('root'),revision:'1',input_hash:digest('root-hash')};
  const sessions:Record<string,{session_id:string;audience:string}>={[digest('group-key')]:{session_id:groupSession,audience:'-100'},[digest('owner-key')]:{session_id:ownerSession,audience:'owner'}};
  let key=digest('group-key'),fail=false;const calls:string[]=[],records:string[]=[];let prepared=0;
  const control={query:async(sql:string,values:any[]=[])=>{
    if(sql.includes('FROM memory_generations WHERE installation_generation'))return {rows:[{id:workspace,state:'ready',last_ready_at:new Date()}]};
    if(sql.startsWith('SELECT * FROM memory_sessions WHERE workspace=$1 AND key=$2 AND audience=$3')) {
      const found=sessions[values[1]];return {rows:found&&found.audience===values[2]?[found]:[]};
    }
    if(sql.includes("count(*) FILTER (WHERE state='done')"))return {rows:[{done:1,pending:0}]};
    if(sql.includes('peer_ids ? $2'))return {rowCount:1,rows:[{}]};
    throw Error('unexpected_control_query '+sql);
  }};
  const contexts={access:{stores:{control},policy:()=>({owner_id:'123'}),archive:{captured:async()=>({reference:root})}},
    entities:{context:async()=>({session_id:key,speaker:{id:'speaker',kind:'person'},project:null,mentioned_projects:[],mentioned_people:[]})},
    guards:{prepareContext:async()=>{prepared++;return null;},read:async()=>({value:{text:'Guarded Honcho context'}})}};
  const derived={record:async(input:any)=>{records.push(input.operation_id);return {store:'derived',kind:'artifact',id:digest(input.operation_id),input_hash:digest(input.content)};}};
  const audience={assert:async()=>({generation:'fixture',epoch:1,mode:'on'})};
  const memory=new NativeMemoryRepository(contexts as any,derived as any,{audience,allow:async()=>{}} as any,{} as any,async(path:string)=>{
    calls.push(path);if(fail)throw Error('honcho_down');
    return {summary:{content:'Conversation summary'},peer_representation:'What the speaker said',peer_card:['Prefers mornings'],messages:[{content:'never used'}]};
  },async()=>[]);
  (memory as any).current=async()=>({row:{id:workspace,root_reference:root,state:'ready'},binding:{generation:'fixture',epoch:1,mode:'on'},principal:{}});
  const group={admin:false,scope:'-100',space:'-100',turnEvent:root.id} as Reader;
  const first=await memory.context(group);
  assert.equal(first.limited_memory,false);assert.equal(first.sources[0]?.text,'Guarded Honcho context');
  assert.match(calls[0]!,new RegExp('/v3/workspaces/'+workspace+'/sessions/'+groupSession+'/context\\?'));
  assert.match(calls[0]!,/peer_target=person_speaker/);assert.match(calls[0]!,/limit_to_session=true/,'a group turn never reads the speaker\'s whole representation');
  const before=records.length;await memory.context(group);
  assert.deepEqual(records.slice(before),records.slice(0,before),'identical Honcho output reuses its guarded result, so a prefetch serves the next turn');
  assert.equal(calls.length,2,'every turn checks Honcho freshness on arrival; nothing is saved behind a timer');
  key=digest('owner-key');
  const owner=await memory.context({admin:false,scope:null,space:'123',turnEvent:root.id} as Reader);
  assert.equal(owner.limited_memory,false);assert.match(calls.at(-1)!,new RegExp(ownerSession));assert.doesNotMatch(calls.at(-1)!,/limit_to_session/);
  const calledBefore=calls.length;
  const crossed=await memory.context(group);
  assert.deepEqual(crossed.sources,[],'a group turn cannot read an owner-private session');assert.equal(calls.length,calledBefore);
  key=digest('group-key');fail=true;
  const down=await memory.context(group);
  assert.equal(down.limited_memory,true);assert.deepEqual(down.sources,[]);
  assert.ok(prepared>=3);
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
  const owner:Reader={admin:true,scope:null},remote=new Map<string,any[]>(),calls:{path:string;body:any;method?:string}[]=[];
  let loseReply=true,sequence=0;const ownerApproved='Owner-approved password=visible123',descendants:string[]=[];
  const services=storageServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async(_operation,input)=>({literals:String(input.text).includes('saffronpass')?['saffronpass']:[]}),
    honcho:async(path,body:any,method)=>{
      calls.push({path,body,...(method?{method}:{})});
      if(method==='DELETE')return {deleted:true};
      if(path.endsWith('/nocheh/session-descendants'))return {ids:descendants.splice(0),truncated:false};
      if(path.endsWith('/messages/list'))return {items:remote.get(path.replace('/list',''))??[]};
      if(path.endsWith('/messages')) {
        const message={...body.messages[0],id:String(++sequence).padStart(21,'r')};remote.set(path,[message]);
        if(loseReply){loseReply=false;throw Error('synthetic_lost_acknowledgment');}return [message];
      }
      if(path.includes('/queue/status'))return {pending_work_units:0,in_progress_work_units:0};
      if(path.endsWith('/nocheh/queue-health'))return {failed_items:false};
      if(path.includes('/context?'))return {summary:{content:'Stored conclusion saffronpass. '+ownerApproved},peer_representation:'Speaker detail',peer_card:[]};
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
    const queued=await services.memory.queueSource(source);assert.equal(queued.length,1);assert.deepEqual(queued.map(q=>q.audience),[group],'group evidence is written once, to its own audience');
    assert.deepEqual(queued.map(q=>q.receipts.length),[2],'speaker evidence and typed project evidence are separate receipts');
    assert.deepEqual(await services.memory.queueSource(source),queued,'duplicate queuing reuses receipts and derivatives');
    const workspace=queued[0]!.workspace;
    const questionText='Recall the earlier recorded fact.';
    const question=(await services.capture.capture({...event,key:key+':question',source_id:key+':question',text:questionText,
      payload:{message:{...(event.payload.message as Record<string,unknown>),message_id:2,text:questionText}}})).source.reference;
    await services.guards.prepare(question,'fixture',services.detect);
    const originalCount=(await stores.archive.query('SELECT count(*) FROM events')).rows[0].count;
    const [receipt,entityReceiptId]=queued[0]!.receipts as [string,string],authority={owner:'inngest' as const,epoch:(await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='honcho'")).rows[0].epoch};
    await assert.rejects(services.memory.syncReceipt(receipt,{...authority,epoch:authority.epoch+1}),{code:'workflow_owner_changed'});
    await assert.rejects(services.memory.syncReceipt(receipt,authority),/synthetic_lost_acknowledgment/);
    assert.equal((await stores.control.query('SELECT state FROM memory_ingestion_receipts WHERE id=$1',[receipt])).rows[0].state,'uncertain');
    const writes=calls.filter(c=>c.path.endsWith('/messages')).length;
    assert.equal(await services.memory.syncReceipt(receipt,authority),true);assert.equal(calls.filter(c=>c.path.endsWith('/messages')).length,writes);
    assert.equal(await services.memory.syncReceipt(receipt,authority),true);assert.equal(calls.filter(c=>c.path.endsWith('/messages')).length,writes);
    await stores.control.query("UPDATE memory_ingestion_receipts SET state='uncertain' WHERE id=$1",[entityReceiptId]);
    assert.equal(await services.memory.syncReceipt(entityReceiptId,authority),false);assert.equal(calls.filter(c=>c.path.endsWith('/messages')).length,writes,'absence cannot authorize repeating an uncertain effect');
    await insertRemote(entityReceiptId);assert.equal(await services.memory.reconcileReceipt(entityReceiptId),true);
    assert.equal(await services.memory.observe(workspace),true);
    assert.equal(await services.memory.settled(queued[0]!.receipts),true);
    const entityReceipt=(await stores.control.query("SELECT peer_id,peer_ids,audience FROM memory_ingestion_receipts WHERE generation=$1 AND record_kind='entity_evidence'",[workspace])).rows[0];
    assert.match(entityReceipt.peer_id,/^person_/);assert.ok(entityReceipt.peer_ids.some((peer:string)=>peer.startsWith('project_')),'the project peer observes attributed evidence');
    assert.equal(entityReceipt.audience,group);
    const sessionWrites=calls.filter(c=>c.path.endsWith('/sessions')&&c.body?.id);
    assert.ok(sessionWrites.every(c=>c.path==='/v3/workspaces/'+workspace+'/sessions'),'every session lives in the one installation workspace');
    const input=(await services.memory.prepareRequest({workspace,route:'/v1/embeddings',payload:{model:'fixture',input:'Embedding saffronpass'}})).payload;
    assert.ok(!JSON.stringify(input).includes('saffronpass'));
    assert.equal(((await services.memory.prepareRequest({workspace,route:'/v1/embeddings',payload:{input:ownerApproved}})).payload as any).input,ownerApproved);
    await assert.rejects(services.memory.prepareRequest({workspace,route:'/v1/embeddings',payload:{input:[1,2]}}),{code:'opaque_embedding_input'});
    const callCount=calls.length;
    await assert.rejects(services.memory.prepareRequest({workspace,route:'/unsupported',payload:{input:'text'}}),{code:'memory_route_denied'});assert.equal(calls.length,callCount);

    const principal=await actor(question.id),context=await services.memory.context(principal);
    assert.equal(context.limited_memory,false);assert.ok(!JSON.stringify(context).includes('saffronpass'));assert.ok(JSON.stringify(context).includes('representation_has_no_exact_citations'));
    assert.ok(JSON.stringify(context).includes(ownerApproved),'native context preserves exact owner-approved guarded passages');
    const contextRead=calls.filter(c=>c.path.includes('/context?')).at(-1)!.path;
    assert.match(contextRead,/limit_to_session=true/,'a group turn reads only its own session');assert.match(contextRead,/peer_target=person_/);
    assert.equal(await services.memory.requestPrefetch(workspace),1,'Honcho finishing new work prefetches the changed conversation');
    const conversation=(await stores.control.query("SELECT session_id FROM memory_sessions WHERE workspace=$1 AND kind='conversation'",[workspace])).rows[0].session_id;
    assert.equal(await services.memory.prefetch(conversation),true);assert.equal(await services.memory.requestPrefetch(workspace),0);
    const recalled=await services.memory.recall(principal,'Recall saffronpass');assert.equal(recalled.sources.length,1);assert.ok(!JSON.stringify(recalled).includes('saffronpass'));
    const chat=calls.filter(c=>c.path.endsWith('/chat')).at(-1)!;
    assert.ok(!String(chat.body.query).includes('saffronpass'));
    const groupSessions=(await stores.control.query('SELECT session_id FROM memory_sessions WHERE audience=$1',[group])).rows.map(row=>row.session_id).sort();
    assert.deepEqual([...chat.body.filters.session_id].sort(),groupSessions,'group recall is confined to its own sessions');
    assert.equal((await stores.archive.query('SELECT count(*) FROM events')).rows[0].count,originalCount,'memory and context never become original evidence');
    assert.ok(!JSON.stringify(calls.filter(c=>c.path.endsWith('/messages'))).includes('saffronpass'),'only guarded inputs reach native ingestion');
    const receiptColumns=(await stores.control.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='memory_ingestion_receipts'")).rows.map(r=>r.column_name);
    assert.ok(!receiptColumns.includes('content'));

    const binding=await services.guards.state(),prepared=await services.guards.read('events:'+source.id,binding),entryId=digest(key+':meaning');
    await services.learned.publishAutomatic(entryId,{kind:'meaning',subject:'checkmark',text:'Checkmark means done.',scope:{kind:'conversation',id:group},uncertainty:'supported',conflicts:[],evidence:[source]},
      null,key+':learned',[{source_id:'events:'+source.id,revision:prepared.revision,value_hash:digest(canonical(prepared.value))}],binding,'fixture',services.detect);
    const projections=await services.memory.queueProjection(entryId);assert.equal(projections.length,1);assert.equal(projections[0]!.workspace,workspace);
    const late=projections[0]!.receipts[0]!;await stores.control.query("UPDATE memory_ingestion_receipts SET state='uncertain' WHERE id=$1",[late]);
    const projectionSession=(await stores.control.query('SELECT session_id FROM memory_ingestion_receipts WHERE id=$1',[late])).rows[0].session_id;
    await services.learned.correct(owner,entryId,{expected_revision:1,operation_id:key+':correction',retired:false,text:'Checkmark means reviewed, not done.'},services.detect);
    assert.equal((await services.memory.current(workspace)).row.id,workspace,'a guard epoch never retires the installation workspace');
    await assert.rejects(services.memory.context(principal),{code:'audience_context_changed'});
    assert.ok(await services.memory.prepareRequest({workspace,route:'/v1/embeddings',payload:{input:'still served'}}));
    const unrelated=await services.memory.sweep('',await services.guards.state());
    assert.equal((await stores.control.query('SELECT count(*)::int AS count FROM memory_ingestion_receipts WHERE id=ANY($1::text[]) AND retired_at IS NULL',[queued[0]!.receipts])).rows[0].count,2,
      'an unrelated epoch keeps every still-valid Honcho write');
    assert.ok(unrelated.rebuilt<=2,'only the corrected interpretation\'s own sessions can be rebuilt');
    const rebuilt=await services.memory.queueProjection(entryId);assert.equal(rebuilt.length,1);assert.equal(rebuilt[0]!.workspace,workspace);
    assert.ok((await stores.control.query('SELECT retired_at FROM memory_ingestion_receipts WHERE id=$1',[late])).rows[0].retired_at,'the replaced interpretation leaves Honcho');
    assert.equal((await stores.control.query('SELECT count(*)::int AS count FROM memory_ingestion_receipts WHERE session_id=$1 AND retired_at IS NULL',[projectionSession])).rows[0].count,0);
    const rebuiltReceipt=(await stores.control.query('SELECT prepared_id,session_id FROM memory_ingestion_receipts WHERE id=$1',[rebuilt[0]!.receipts[0]])).rows[0];
    assert.notEqual(rebuiltReceipt.session_id,projectionSession,'corrected evidence is written to a new session revision');
    assert.ok((await stores.derived.query('SELECT content FROM derived_artifacts WHERE id=$1',[rebuiltReceipt.prepared_id])).rows[0].content.toString().includes('Checkmark means reviewed, not done.'));
    assert.equal((await stores.control.query("SELECT count(*)::int AS count FROM workflow_registry WHERE family='honcho' AND job_id=$1",['delete:'+projectionSession])).rows[0].count,1);
    descendants.push('c'.repeat(21));
    assert.equal(await services.memory.deleteSession(projectionSession,authority),true);
    const deletes=calls.filter(c=>c.method==='DELETE').map(c=>c.path);
    assert.deepEqual(deletes,['/v3/workspaces/'+workspace+'/conclusions/'+'c'.repeat(21),'/v3/workspaces/'+workspace+'/sessions/'+projectionSession],
      'conclusions derived elsewhere are deleted before the replaced session');
    assert.equal(await services.memory.deleteSession(projectionSession,authority),true);assert.equal(calls.filter(c=>c.method==='DELETE').length,2);
    await insertRemote(late);assert.equal(await services.memory.reconcileReceipt(late),true,'a replaced receipt can still be reconciled');
    const fresh=await actor(source.id);assert.equal((await services.memory.context(fresh)).limited_memory,false,'memory stays available after an unrelated epoch');
    const correctedRecall=await services.memory.recall(fresh,'What does checkmark mean?');
    assert.equal(correctedRecall.sources[0]?.kind,'owner_corrected_interpretation');
    assert.match(correctedRecall.sources[0]!.text,/Checkmark means reviewed, not done\./);
    assert.equal(JSON.stringify(await services.memory.recall(fresh,'What does another symbol mean?')).includes('owner_corrected_interpretation'),false,
      'an unrelated question cannot receive the correction');
    await services.access.setConsent(owner,source,{enabled:false,expected_revision:0,operation_id:key+':consent-off'});
    const retracted=await services.memory.sweep('',await services.guards.state());assert.ok(retracted.rebuilt>=1);
    assert.equal((await stores.control.query("SELECT count(*)::int AS count FROM memory_ingestion_receipts WHERE source_reference->>'id'=$1 AND retired_at IS NULL",[source.id])).rows[0].count,0,
      'withdrawn consent removes the source from every session that held it');
    assert.equal(await services.memory.ingested(source.id),false);
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
      if(path.includes('/queue/status'))return {pending_work_units:0,in_progress_work_units:0};
      if(path.endsWith('/nocheh/queue-health'))return {failed_items:false};
      if(path.includes('/context?'))return {summary:{content:'The current question asks for the meeting time.'}};
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
    assert.equal(await services.memory.settled(current.receipts),true);
    assert.equal((await services.memory.context(principal)).limited_memory,false);
    assert.ok(calls.some(path=>path.includes('/context?')),'background context retains the current source');
    // Older receipts without the evidence array retain the same source boundary.
    await stores.control.query("UPDATE memory_ingestion_receipts SET source_references='[]'::jsonb WHERE generation=$1",[current.workspace]);
    const ready=await services.memory.recall(principal,'What was the meeting time?');
    assert.equal(ready.limited_memory,true);assert.deepEqual(ready.sources,[]);
    assert.equal(calls.filter(path=>path.endsWith('/chat')).length,0,'a ready question-only workspace is still not historical memory');
    const older=(await services.memory.queueSource(earlier)).find(item=>item.audience===group)!;
    for(const receipt of older.receipts)assert.equal(await services.memory.syncReceipt(receipt,authority),true);
    await stores.control.query("UPDATE memory_ingestion_receipts SET source_references='[]'::jsonb WHERE id=ANY($1::text[])",[older.receipts]);
    assert.equal(await services.memory.settled(older.receipts),true);
    const recalled=await services.memory.recall(principal,'What was the meeting time?');
    assert.equal(recalled.limited_memory,false);assert.match(recalled.sources[0]!.text,/independently recorded meeting time is 18:00/);
    assert.equal(calls.filter(path=>path.endsWith('/chat')).length,1,'completed independent source evidence enables historical reasoning');
  } finally {await stores.control.query('UPDATE memory_engine_connection SET attached=false,verified=false WHERE singleton');await services.guards.setMode('off');await services.guards.setMode('on');await stores.close();await rm(root,{recursive:true,force:true});}
});

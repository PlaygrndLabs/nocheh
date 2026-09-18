import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {canonical,digest} from '../src/archive.js';
import {reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {drainSourceSpool} from '../src/stores/capture.js';
import {storageWorkflowOperations} from '../src/stores/workflow-operations.js';
import {safeMetadata} from '../src/workflows/boundary.js';
import {workflowDetail} from '../src/workflows/owner.js';
import {controlStorageWorkflow} from '../src/stores/workflow-owner.js';
import {advanceWorkflow} from '../src/workflows/engine.js';

test('browser execution separates originals, prepared inputs, receipts and same-identity recovery',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-browser-runs-')),base=Date.now(),token=digest('browser'+base),group='-'+base;
  const owner={admin:true,scope:null},policy={enabled:true,owner_id:'123',group_ids:[group]};let serial=0,mode='done',failCompletion=false,research='',planning='';
  const control=new Proxy(stores.control,{get(target,key){if(key==='connect')return async()=>{
    const db=await target.connect();return new Proxy(db,{get(client,name){if(name==='query')return (sql:any,...args:any[])=>{
      if(failCompletion&&String(sql).startsWith('UPDATE managed_runs SET state=$2,result_reference')){failCompletion=false;return Promise.reject(Error('lost control completion'));}
      return (client.query as any)(sql,...args);};const value=Reflect.get(client,name);return typeof value==='function'?value.bind(client):value;}});
  };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const native=new Map<string,any>(),calls:{op:string;body:any}[]=[],claims=new Map<string,any>(),contexts=new Map<string,any>();
  const runtime:Parameters<typeof storageServices>[1]['runtime']=async(op,body)=>{
    if(op==='guard.detect')return {literals:String(body.text).includes('fixture-secret')?['fixture-secret']:[]};
    calls.push({op,body});const id=String(body.event_id);
    if(op==='run.resume'){assert.equal(body.observe_only,true);return native.get(id)??{state:'not_found'};}
    if(op==='run.cancel'){native.set(id,{state:'cancelled'});return {state:'cancelled'};}
    assert.equal(op,'run.start');
    if(mode==='request_lost'){mode='done';throw Error('lost before native receipt');}
    if(mode==='queued'){native.set(id,{state:'queued'});return {state:'queued'};}
    const context=await s.browser.context(body);contexts.set(id,context);const claim=await s.browser.claim(context);assert.equal(claim.claimed,true);claims.set(id,claim);
    const principal=reader({headers:{authorization:'Bearer '+claim.archive_credential}} as any,token);assert.equal(principal.logical_profile,context.profile);
    await s.turns.binding(principal);const prepared=await s.browser.prepare(context);assert.ok(!JSON.stringify({claim,prepared}).includes('fixture-secret'));
    assert.equal((await s.browser.claim(context)).claimed,false,'duplicate claim cannot run');
    await s.browser.heartbeat(context);native.set(id,{state:'running'});
    if(mode==='running')return {state:'running'};
    const receipt={event_id:id,actor:context.actor,state:'done',text:'Generated answer',session:context.conversation,error_code:null};
    await s.browser.finish(receipt);native.set(id,{state:'done'});
    if(mode==='ack_lost'){mode='done';throw Error('lost reply after completion');}return {state:'done'};
  };
  const s=storageServices({...stores,control},{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>policy,runtime,
    transcription:{name:'fixture-asr',version:'2',outputKind:'transcript',async run(bytes){assert.deepEqual(bytes,Buffer.from([79,103,103,0,255]));return 'Prepared audio fixture-secret';}},
    honcho:async()=>{throw Error('no providers');}});
  const authority=async(family:string)=>({owner:'inngest' as const,epoch:Number((await stores.control.query('SELECT epoch FROM workflow_owners WHERE family=$1',[family])).rows[0].epoch)});
  const capture=async(options:Record<string,unknown>={})=>{const binding=await s.guards.state(),body={scope:'123',profile:options.scope&&options.scope!=='123'?'nocheh-'+digest(String(options.space??options.scope)).slice(0,24):research,conversation:'fixture-'+base+'-'+(++serial),
    id:'input',text:'Original fixture-secret',revision:binding.epoch,...options};const source=await s.browserCapture.capture(owner,body);await drainSourceSpool(s.capture,root,source.event_id);return {...body,...source};};
  const prepare=async(id:string)=>s.preparation.run(id,async()=>{throw Error('no download');},'fixture',s.detect,await authority('preparation'));
  const run=async(id:string)=>{const result=await storageWorkflowOperations(s,runtime).browser!(id,await authority('browser'));safeMetadata(result);return result;};
  const saved=async(id:string)=>(await stores.control.query('SELECT * FROM managed_runs WHERE event_id=$1',[id])).rows[0];
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    research=(await s.runtimeProfiles.save(owner,{name:'research-'+base,state:'active',expected_revision:0,operation_id:'browser-research-'+base})).id;
    planning=(await s.runtimeProfiles.save(owner,{name:'planning-'+base,state:'active',expected_revision:0,operation_id:'browser-planning-'+base})).id;
    const unknown=await capture({profile:'unregistered'});await assert.rejects(s.browser.admit(owner,unknown),{code:'profile_scope_denied'});
    const wrongAudience=await capture({scope:group,profile:research});await assert.rejects(s.browser.admit(owner,wrongAudience),{code:'profile_scope_denied'});
    const first=await capture();await assert.rejects(s.browser.admit({admin:false,scope:'123'},first),{status:403});
    await s.browser.admit(owner,first);assert.equal((await run(first.event_id)).state,'waiting');assert.equal(calls.length,0);
    const second=await capture({conversation:first.conversation,id:'second'});await assert.rejects(s.browser.admit(owner,second),{code:'session_busy'});
    const other=await capture({conversation:first.conversation,profile:planning});await s.browser.admit(owner,other);await s.browser.cancel(other);
    await prepare(first.event_id);mode='ack_lost';
    const firstWorkflow=(await stores.control.query("SELECT id FROM workflow_registry WHERE family='browser' AND job_id=$1",[first.event_id])).rows[0].id;
    await advanceWorkflow(stores.control,firstWorkflow,1,'browser','fixture-first',storageWorkflowOperations(s,runtime).browser!);
    assert.equal((await advanceWorkflow(stores.control,firstWorkflow,1,'browser','fixture-recovery',storageWorkflowOperations(s,runtime).browser!)).state,'completed');
    const delivered=await s.browser.observe(first);
    assert.equal(delivered.text,'Generated answer');assert.ok(delivered.delivery);assert.equal((await s.browser.active(first)).active,false);
    await assert.rejects(s.browser.undelivered({admin:false,scope:'123'},{profile:research}),{status:403});
    const missed=await s.browser.undelivered(owner,{profile:research});
    assert.equal(missed.items.length,1);assert.equal(missed.items[0]!.text,delivered.text);assert.deepEqual(missed.items[0]!.nocheh_delivery,delivered.delivery);
    assert.deepEqual(await s.browser.undelivered(owner,{profile:research}),missed,'recovery reads do not acknowledge delivery');
    assert.equal((await s.browser.undelivered(owner,{profile:planning})).items.length,0);
    await assert.rejects(s.browser.undelivered(owner,{profile:research,space:group}),{code:'profile_scope_denied'});
    await assert.rejects(s.browser.undelivered(owner,{profile:research,after:'../bad'}),{code:'invalid_run_identity'});
    assert.equal((await stores.archive.query("SELECT 1 FROM events WHERE channel='browser' AND source_id=$1",[(await saved(first.event_id)).result_reference.id])).rowCount,0,'offering generated text is not delivery');
    const receipt=await s.browserDelivery.acknowledge(owner,delivered.delivery);
    await drainSourceSpool(s.capture,root,receipt.event_id);
    assert.equal((await s.browser.undelivered(owner,{profile:research})).items.length,0,'captured delivery retires the recovery offer');
    const witnessed=(await s.archive.captured(receipt.event_id)).reference;
    assert.equal((await stores.archive.query('SELECT original_text,kind FROM events WHERE id=$1',[receipt.event_id])).rows[0].original_text.toString(),'Generated answer');
    assert.equal(await s.access.canLearn(witnessed,await s.guards.state()),true);
    assert.equal((await stores.archive.query("SELECT 1 FROM source_relations r JOIN source_revisions v ON v.object_id=r.target_id JOIN source_observations o ON o.revision_id=v.id WHERE r.event_id=$1 AND r.kind='reply_to' AND o.event_id=$2",[receipt.event_id,first.event_id])).rowCount,1,'delivered browser message resolves its original reply target');
    await s.browserDelivery.acknowledge(owner,delivered.delivery);await drainSourceSpool(s.capture,root,receipt.event_id);
    assert.equal((await stores.archive.query('SELECT count(*)::int AS count FROM events WHERE id=$1',[receipt.event_id])).rows[0].count,1);
    await assert.rejects(s.turns.binding(reader({headers:{authorization:'Bearer '+claims.get(first.event_id).archive_credential}} as any,token)),{code:'runtime_turn_changed'});
    assert.ok((await s.reviews.queue((await s.archive.captured(first.event_id)).reference)).length>0,'completed browser originals remain available to permitted background learning');
    const reviewBinding=await s.guards.state();
    const processing={admin:false,scope:null,space:'123',turnEvent:first.event_id,generation:reviewBinding.generation,guard_epoch:reviewBinding.epoch,revision:reviewBinding.epoch,purpose:'filter' as const};
    assert.equal((await s.turns.binding(processing)).owner,true);
    await assert.rejects(s.controlledActions.propose(processing,{kind:'shell',arguments:{command:'pwd'}}),{code:'external_effect_scope_denied'});
    const row=await saved(first.event_id);assert.equal(row.source_reference.store,'archive');assert.equal(row.input_reference.store,'derived');assert.equal(row.result_reference.store,'derived');
    assert.equal((await stores.archive.query('SELECT original_text FROM events WHERE id=$1',[first.event_id])).rows[0].original_text.toString(),first.text);
    const result={event_id:first.event_id,actor:contexts.get(first.event_id).actor,state:'done',text:'Generated answer',session:first.conversation,error_code:null};
    assert.equal((await s.browser.finish(result)).duplicate,true);await assert.rejects(s.browser.finish({...result,text:'Changed receipt'}),{code:'derivative_identity_conflict'});
    await assert.rejects(s.browser.observe({...first,profile:planning}),{code:'run_profile_mismatch'});
    const lost=await capture();await s.browser.admit(owner,lost);await prepare(lost.event_id);failCompletion=true;await run(lost.event_id);
    assert.equal((await saved(lost.event_id)).state,'running');const count=calls.length;assert.equal((await run(lost.event_id)).state,'completed');assert.equal(calls.length,count,'durable result repairs control without runtime');
    const absent=await capture();await s.browser.admit(owner,absent);await prepare(absent.event_id);mode='request_lost';await run(absent.event_id);await run(absent.event_id);
    assert.equal((await saved(absent.event_id)).state,'done');assert.equal(calls.filter(c=>c.body.event_id===absent.event_id&&c.op==='run.start').length,2);
    const running=await capture();await s.browser.admit(owner,running);await prepare(running.event_id);mode='running';assert.equal((await run(running.event_id)).state,'running');
    native.delete(running.event_id);assert.equal((await run(running.event_id)).state,'ambiguous');assert.equal(calls.filter(c=>c.body.event_id===running.event_id&&c.op==='run.start').length,1);
    const late={event_id:running.event_id,actor:contexts.get(running.event_id).actor,state:'done',text:'Late evidence',session:running.conversation};
    assert.equal((await s.browser.finish(late)).state,'interrupted');assert.equal((await s.browser.observe(running)).visible,false);
    const cancelled=await capture();await s.browser.admit(owner,cancelled);await prepare(cancelled.event_id);await run(cancelled.event_id);await s.browser.cancel(cancelled);
    await assert.rejects(s.browser.prepare(contexts.get(cancelled.event_id)),{code:'run_lease_lost'});
    await assert.rejects(s.turns.binding(reader({headers:{authorization:'Bearer '+claims.get(cancelled.event_id).archive_credential}} as any,token)),{code:'runtime_turn_changed'});
    assert.equal((await s.browser.heartbeat(contexts.get(cancelled.event_id))).cancel_requested,true);await run(cancelled.event_id);
    const scoped=await capture({scope:group,space:group+'/topic/12'});const reference=(await s.archive.captured(scoped.event_id)).reference,binding=await s.guards.state();
    const principal={admin:false,scope:group,space:group+'/topic/12',generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
    assert.equal(await s.access.canRead(principal,reference,binding),true);assert.equal(await s.access.canRead({...principal,space:group},reference,binding),false);
    assert.equal(await s.access.canRead({...principal,space:group+'/topic/13'},reference,binding),false);assert.equal(await s.access.canLearn(reference,binding),true);
    await s.browser.admit(owner,scoped);await prepare(scoped.event_id);mode='done';assert.equal((await run(scoped.event_id)).state,'completed');
    const media=await capture({text:'Read the attached audio',files:[{name:'original.ogg',kind:'audio',bytes_base64:Buffer.from([79,103,103,0,255]).toString('base64')}]});
    await s.browser.admit(owner,media);await prepare(media.event_id);assert.equal((await run(media.event_id)).state,'completed','initial transcript preparation must not cancel an unstarted browser submission');
    const queued=await capture();await s.browser.admit(owner,queued);await prepare(queued.event_id);mode='queued';await run(queued.event_id);
    await s.guards.setMode('off');assert.equal((await s.browser.observe(queued)).visible,false);assert.equal((await run(queued.event_id)).state,'cancelled');
    assert.equal((await s.browser.undelivered(owner,{profile:research})).items.length,0,'revoked output is not replayed');
    assert.equal(calls.filter(c=>c.body.event_id===queued.event_id&&c.op==='run.start').length,1);
    const stale=await capture({scope:group,revision:1});await assert.rejects(s.browser.admit(owner,stale),{code:'browser_audience_changed'});
    const off=await capture({text:'Plain off mode'});await s.browser.admit(owner,off);await prepare(off.event_id);mode='done';assert.equal((await run(off.event_id)).state,'completed');
    const recoveryIds=[off.event_id];
    for(let i=0;i<4;i++){const item=await capture({text:'Recovery page '+i});await s.browser.admit(owner,item);await prepare(item.event_id);await run(item.event_id);recoveryIds.push(item.event_id);}
    const pageOne=await s.browser.undelivered(owner,{profile:research});assert.equal(pageOne.items.length,4);assert.ok(pageOne.next);
    const pageTwo=await s.browser.undelivered(owner,{profile:research,after:pageOne.next});assert.equal(pageTwo.items.length,1);assert.equal(pageTwo.next,null);
    assert.deepEqual([...pageOne.items,...pageTwo.items].map(item=>item.event_id).sort(),recoveryIds.sort());
    const imported=await capture();await stores.control.query("UPDATE source_intakes SET transport='import' WHERE event_id=$1",[imported.event_id]);await assert.rejects(s.browser.admit(owner,imported),{code:'browser_original_required'});
    const queuedOwner=await capture();await s.browser.admit(owner,queuedOwner);
    const workflow=(await stores.control.query("SELECT id,revision FROM workflow_registry WHERE family='browser' AND job_id=$1",[queuedOwner.event_id])).rows[0];
    assert.equal((await workflowDetail(stores.control,workflow.id)).can_cancel,true);
    await controlStorageWorkflow(stores.control,owner,workflow.id,'cancel',{revision:workflow.revision});assert.equal((await saved(queuedOwner.event_id)).state,'cancelled');
    const cancelledBinding=await s.guards.state();
    await s.turns.binding({admin:false,scope:null,space:'123',turnEvent:queuedOwner.event_id,purpose:'memory-review',generation:cancelledBinding.generation,guard_epoch:cancelledBinding.epoch});
    const expired=await capture({text:'Lease expiration'});await s.browser.admit(owner,expired);await prepare(expired.event_id);mode='running';await run(expired.event_id);
    await stores.control.query("UPDATE managed_runs SET lease_until=now()-interval '1 second' WHERE event_id=$1",[expired.event_id]);
    await assert.rejects(s.turns.binding(reader({headers:{authorization:'Bearer '+claims.get(expired.event_id).archive_credential}} as any,token)),{code:'runtime_turn_changed'});
    assert.equal((await s.browser.observe(expired)).visible,false);assert.equal((await s.browser.observe(expired)).delivery,null);assert.equal((await run(expired.event_id)).state,'ambiguous');
    const historical=await capture({text:'Imported receipt is historical'});await s.browser.admit(owner,historical);await prepare(historical.event_id);await run(historical.event_id);
    const historyRun=await saved(historical.event_id),operation='browser-result:'+historical.event_id,artifactId=digest('derivative:'+operation),configuration={binding:historyRun.binding};
    const historyText=Buffer.from(canonical({state:'done',text:'Imported claim of completion',session:historical.conversation,error_code:null}));
    const value={id:artifactId,event_id:historical.event_id,artifact_id:null,kind:'browser_result',content:historyText.toString('base64'),content_hash:digest(historyText),
      provenance:{actor:historyRun.actor,input:historyRun.input_reference,source:historyRun.source_reference,parents:[historyRun.input_reference],configuration},
      source_revision:historyRun.source_reference.revision,input_hash:historyRun.input_reference.input_hash,producer:'hermes',producer_version:'managed-browser-v2',
      configuration_hash:digest(canonical(configuration)),operation_id:operation,created_at:new Date().toISOString(),operation_reference:null};
    const portable={format:'nocheh-derivative-record-v1',type:'derived_artifacts',key:artifactId,value,sha256:digest(canonical({type:'derived_artifacts',key:artifactId,value}))};
    await s.derivativePortability.restore(owner,[portable]);const beforeHistory=calls.length;
    await assert.rejects(run(historical.event_id),{code:'imported_result_not_execution_receipt'});assert.equal(calls.length,beforeHistory);
    assert.equal((await saved(historical.event_id)).result_reference,null);assert.equal((await s.browser.observe(historical)).text,'');
    const retiring=await capture({profile:planning});await s.browser.admit(owner,retiring);await prepare(retiring.event_id);
    const retirement=await s.runtimeProfiles.save(owner,{id:planning,name:'planning-'+base,state:'retired',expected_revision:1,operation_id:'browser-retire-'+base});
    assert.equal(retirement.state,'retired');const beforeRetirement=calls.length;
    assert.equal((await run(retiring.event_id)).state,'cancelled');assert.equal(calls.length,beforeRetirement,'retired queued profile never reaches native execution');
    await assert.rejects(s.browser.admit(owner,retiring),{code:'profile_scope_denied'});
    const columns=(await stores.control.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='managed_runs'")).rows.map(r=>r.column_name);
    assert.ok(!columns.some(c=>['payload','content','text','transcripts'].includes(c)));
    assert.equal((await stores.archive.query("SELECT count(*)::int AS n FROM events WHERE kind IN ('browser_result','runtime_context')")).rows[0].n,0);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

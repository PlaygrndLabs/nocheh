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
import {storageWorkflowOperations} from '../src/stores/workflow-operations.js';
import {workflowDetail} from '../src/workflows/owner.js';
import {controlStorageWorkflow} from '../src/stores/workflow-owner.js';
import {safeMetadata} from '../src/workflows/boundary.js';

test('scheduled execution uses guarded operation roots and stages exact delivery without reopening a closed turn',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-scheduled-runs-')),base=Date.now(),token=digest('scheduled-'+base);
  let failCompletion=false,mode='done',serial=0;const calls:any[]=[],native=new Map<string,any>(),contexts=new Map<string,any>(),claims=new Map<string,any>();
  const control=new Proxy(stores.control,{get(target,key){if(key==='connect')return async()=>{
    const db=await target.connect();return new Proxy(db,{get(client,name){if(name==='query')return (sql:any,...args:any[])=>{
      if(failCompletion&&String(sql).startsWith('UPDATE managed_runs SET state=$2,result_reference')){failCompletion=false;return Promise.reject(Error('lost control completion'));}
      return (client.query as any)(sql,...args);};const value=Reflect.get(client,name);return typeof value==='function'?value.bind(client):value;}});
  };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const runtime:Parameters<typeof storageServices>[1]['runtime']=async(op,body)=>{
    if(op==='guard.detect')return {literals:String(body.text).includes('fixture-secret')?['fixture-secret']:[]};
    calls.push({op,body});if(op==='schedule.advance')return {state:'waiting',next_attempt:Date.now()+60000};
    assert.ok(op.startsWith('run.'),'no external delivery while staging a proposal');const id=String(body.event_id);
    if(op==='run.resume'){assert.equal(body.observe_only,true);return native.get(id)??{state:'not_found'};}
    if(op==='run.cancel'){native.set(id,{state:'cancelled'});return {state:'cancelled'};}
    assert.equal(op,'run.start');assert.equal(body.channel,'scheduler');
    const context:any=await s.scheduled.context(body);contexts.set(id,context);assert.ok(!('prompt' in context.definition));
    const claim=await s.scheduled.claim(context);claims.set(id,claim);assert.equal(claim.claimed,true);assert.ok(!claim.text!.includes('fixture-secret'));
    const principal=reader({headers:{authorization:'Bearer '+claim.archive_credential}} as any,token);
    const binding=await s.turns.binding(principal);assert.equal(binding.reference!.store,'control');assert.equal(binding.job,context.job_id);
    assert.equal((await s.scheduled.claim(context)).claimed,false);assert.deepEqual(await s.scheduled.prepare(context),{transcripts:[],files:[]});
    native.set(id,{state:'running'});if(mode==='running')return {state:'running'};
    await s.scheduled.finish({event_id:id,actor:context.actor,state:'done',session:context.conversation,text:'Scheduled answer fixture-secret'});
    native.set(id,{state:'done'});if(mode==='ack_lost'){mode='done';throw Error('lost native acknowledgement');}return {state:'done'};
  };
  const s=storageServices({...stores,control},{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy:()=>({enabled:true,owner_id:'123',group_ids:['-123']}),runtime,
    honcho:async()=>{throw Error('no providers');}}),owner={admin:true,scope:null};
  const authority=async()=>({owner:'inngest' as const,epoch:(await s.schedules.ownership()).epoch});
  const capture=async(options:Record<string,unknown>={})=>{
    const scope=String(options.scope??'123'),profile='nocheh-'+digest(scope).slice(0,24),job='execution-'+base+'-'+(++serial);
    const definition={profile,name:'Fixture',prompt:'Prompt fixture-secret',schedule:{kind:'interval',minutes:60},deliver:'local',repeat:null,enabled:true,removed:false,
      preferences:{'nocheh_tools.shell':'off'},execution_version:'v1',...options};delete (definition as any).scope;
    const saved=await s.schedules.definition(owner,{scope,profile,job_id:job,definition,workflow_cursor:digest(job),workflow_sequence:1});
    const fire=await s.schedules.capture(owner,{scope,space:scope,profile,job_id:job,id:'first',text:definition.prompt,files:[],definition,
      job_revision:digest(canonical(definition)),scheduled_for:'2026-09-18T12:00:00Z',fire_reason:'manual',owner_epoch:(await authority()).epoch});
    return {...fire,scope,profile,job,definition,schedule:saved.id};
  };
  const run=async(id:string)=>{const result=await storageWorkflowOperations(s,runtime).schedules!('run:'+id,await authority());safeMetadata(result);return result;};
  const saved=async(id:string)=>(await stores.control.query('SELECT * FROM managed_runs WHERE event_id=$1',[id])).rows[0];
  try{
    await s.guards.reconcile();await s.guards.setMode('on');
    const local=await capture();mode='ack_lost';assert.equal((await run(local.event_id)).state,'waiting');assert.equal((await run(local.event_id)).state,'completed');
    assert.equal((await s.scheduled.delivery(local)).state,'local');
    assert.equal(calls.filter(call=>call.op==='run.start'&&call.body.event_id===local.event_id).length,1);
    await assert.rejects(s.turns.binding(reader({headers:{authorization:'Bearer '+claims.get(local.event_id).archive_credential}} as any,token)),{code:'runtime_turn_changed'});
    const delivered=await capture({scope:'-123',deliver:'telegram'});await run(delivered.event_id);
    const proposal=await s.scheduled.delivery(delivered);assert.equal(proposal.state,'proposed');assert.ok('id' in proposal);
    const inspected=await s.telegramActions.inspect(owner,proposal.id!);assert.ok(!JSON.stringify(inspected).includes('fixture-secret'));
    assert.equal((await s.scheduled.delivery(delivered)).state,'proposed');assert.equal((await saved(delivered.event_id)).state,'done');
    assert.equal((await stores.control.query('SELECT count(*)::int AS n FROM telegram_action_requests WHERE source_reference->>\'id\'=$1',[delivered.event_id])).rows[0].n,1);
    assert.equal((await s.scheduled.history({profile:delivered.profile,job_id:delivered.job})).runs[0]!.native_session,contexts.get(delivered.event_id).conversation);
    await assert.rejects(s.telegramActions.requestScheduled({admin:false,scope:'-123'},delivered.event_id),{status:403});
    const recovered=await capture();failCompletion=true;assert.equal((await run(recovered.event_id)).state,'waiting');
    const before=calls.length;assert.equal((await run(recovered.event_id)).state,'completed');assert.equal(calls.length,before,'durable derivative receipt repairs control without new native execution');
    const uncertain=await capture();mode='running';await run(uncertain.event_id);native.delete(uncertain.event_id);
    assert.equal((await run(uncertain.event_id)).state,'ambiguous');assert.equal((await s.scheduled.delivery(uncertain)).state,'withheld');
    const cancelled=await capture();await s.scheduled.cancel(cancelled);assert.equal((await run(cancelled.event_id)).state,'cancelled');
    const epoch=await capture();await s.guards.setMode('off');assert.equal((await run(epoch.event_id)).state,'cancelled');
    assert.equal((await s.scheduled.delivery(delivered)).state,'withheld');
    mode='done';const off=await capture({prompt:'Explicit guard off'});assert.equal((await run(off.event_id)).state,'completed');
    assert.equal((await storageWorkflowOperations(s,runtime).schedules!('schedule:'+off.schedule+':'+digest(off.job),await authority())).state,'waiting');
    assert.equal((await storageWorkflowOperations(s,runtime).schedules!('schedule:'+off.schedule+':'+digest('obsolete'),await authority())).state,'skipped');
    assert.equal((await stores.archive.query("SELECT count(*)::int AS n FROM events WHERE channel='scheduler'")).rows[0].n,0);
    const receipts=(await stores.control.query("SELECT state FROM workflow_receipts WHERE step='scheduler' AND workflow_id IN (SELECT id FROM workflow_registry WHERE family='schedules' AND job_id=$1)",['run:'+recovered.event_id])).rows;
    assert.deepEqual(receipts.map(r=>r.state),['done']);
    const queued=await capture({prompt:'Owner cancellation'}),workflow=(await stores.control.query("SELECT * FROM workflow_registry WHERE family='schedules' AND job_id=$1",['run:'+queued.event_id])).rows[0];
    const detail=await workflowDetail(stores.control,workflow.id);assert.equal(detail.can_cancel,true);assert.equal(detail.source_event_id,null);
    await controlStorageWorkflow(stores.control,owner,workflow.id,'cancel',{revision:workflow.revision});
    assert.equal((await run(queued.event_id)).state,'cancelled');

  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

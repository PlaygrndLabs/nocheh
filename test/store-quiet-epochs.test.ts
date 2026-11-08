import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {canonical,digest,type Envelope} from '../src/archive.js';
import type {Interpretation} from '../src/interpretations.js';
import {preferenceProfile} from '../src/stores/controlled-execution.js';
import {defaultLogicalProfile} from '../src/stores/runtime-profile.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {claimHostWorkflow} from '../src/workflows/host-coordinator.js';
import type {GuardBinding} from '../src/stores/guards.js';

test('waiting approvals carry across reaction epochs and stop after any other epoch',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-quiet-epochs-')),key='quiet-epochs:'+Date.now(),asking='-100555',other='-100777';
  const owner={admin:true,scope:null},s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[asking,other]}),
    runtime:async(operation)=>{assert.equal(operation,'guard.detect');return {literals:[]};},honcho:async()=>{throw Error('no provider');}});
  const a=s.controlledActions,x=s.controlledExecution;
  const capture=async(group:string,label:string,payload:any)=>{
    const value:Envelope={version:1,key:key+':'+label,origin:'live',kind:'telegram_update',bot_id:key,scope:group,
      source_id:String(payload.message?.message_id??payload.message_reaction?.message_id),revision:String(payload.update_id),occurred_at:null,text:payload.message?.text??null,payload};
    return (await s.capture.capture(value)).source.reference;
  };
  const message=(group:string,id:number,text:string)=>({message_id:id,date:1700000000+id,chat:{id:Number(group),type:'supergroup',is_forum:false},from:{id:7},text});
  let reactions=10;
  const react=async(emoji:string|null)=>{
    const previous=reactions===10?[]:[{type:'emoji',emoji:'👍'}];reactions++;
    await capture(other,'reaction-'+reactions,{update_id:reactions,message_reaction:{chat:{id:Number(other),type:'supergroup'},message_id:1,date:1700000100+reactions,
      user:{id:7},old_reaction:previous,new_reaction:emoji?[{type:'emoji',emoji}]:[]}});
  };
  const host=async(id:string)=>{
    const row=(await stores.control.query("SELECT * FROM workflow_registry WHERE family='tools' AND job_id=$1",[id])).rows[0];
    const lease=await claimHostWorkflow(stores.control,{workflow_id:row.id,dispatch:row.dispatch,family:'tools',run_id:'fixture-'+row.id});assert.equal(lease.claimed,true);
    return {id,actor:'wf-'+row.id,workflow_id:row.id,workflow_token:lease.token};
  };
  const run=async(id:string,stdout:string)=>{
    const b=await host(id),claim=await x.claim(b) as any;assert.equal(claim.claimed,true);assert.deepEqual(await x.start(b),{started:true});
    await x.finish({id,actor:b.actor,state:'done',result:{stdout,exit_code:0}});return claim;
  };
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    const source=await capture(asking,'request',{update_id:1,message:message(asking,1,'Please run the made-up checks')});await s.guards.prepare(source,'fixture',s.detect);
    const elsewhere=await capture(other,'note',{update_id:2,message:message(other,1,'A made-up note')});await s.guards.prepare(elsewhere,'fixture',s.detect);
    const reader=(b:GuardBinding,turnEvent=source.id,group=asking)=>({admin:false,scope:group,space:group,turnEvent,generation:b.generation,guard_epoch:b.epoch,revision:b.epoch});
    const proposed=await s.guards.state(),asker=reader(proposed),shell=(command:string)=>a.propose(asker,{kind:'shell',arguments:{command}});
    const waiting=await shell('printf waiting-card'),stopped=await shell('printf stopped-card'),early=await shell('printf approved-early'),late=await shell('printf approved-late');
    const permitted=await shell('printf bounded-permission'),grant=await a.grant(owner,{action_id:permitted.id,fingerprint:permitted.fingerprint,uses:2,minutes:5});
    await a.decide(owner,{id:early.id,fingerprint:early.fingerprint,decision:'approve'});
    // A job step proposes under the job's named profile.
    const step=async(label:string,profile='fixture-job')=>{
      const operation=await s.operations.record({key:key+':'+label,kind:'background_run',scope:asking,input_hash:digest(label)});
      const actor={...reader(await s.guards.state(),operation.id),logical_profile:profile};await s.turns.register(actor,{logical_profile:profile,job:'fixture-job'});return actor;
    };
    const job=await a.propose(await step('step-1'),{kind:'shell',arguments:{command:'printf job-step'}});
    const inbox=async(id:string)=>(await s.supervision.decision(owner,'controlled_action',id)).observation;
    const standing=async()=>(await s.supervision.context(owner,asking)).external_actions.permissions.find((row:any)=>row.id===grant.id)!.current;

    // A reaction in another group starts a quiet epoch.
    await react('👍');const quiet=await s.guards.state();assert.equal(quiet.epoch,proposed.epoch+1);
    assert.deepEqual((await stores.control.query('SELECT reason FROM guard_quiet_epochs WHERE generation=$1 AND epoch=$2',[quiet.generation,quiet.epoch])).rows,[{reason:'reaction'}]);
    assert.equal((await a.decide(owner,{id:waiting.id,fingerprint:waiting.fingerprint,decision:'approve'})).state,'approved');
    await a.decide(owner,{id:late.id,fingerprint:late.fingerprint,decision:'approve'});
    assert.equal((await a.preview(owner,{action_id:stopped.id})).decision.outcome,'ask');
    assert.equal(await inbox(stopped.id),'current','the Inbox keeps Approve open after a reaction');
    // The tools workflow claims a waiting action again; it keeps waiting.
    assert.deepEqual(await x.claim(await host(stopped.id)),{claimed:false});assert.equal((await a.row(stopped.id)).state,'proposed');
    const claim=await run(waiting.id,'made-up result');assert.equal(claim.arguments.command,'printf waiting-card');
    const next=await capture(asking,'follow-up',{update_id:3,message:message(asking,2,'A made-up follow-up')});await s.guards.prepare(next,'fixture',s.detect);
    assert.equal((await s.guards.state()).epoch,quiet.epoch);
    const later=reader(quiet,next.id),read=await a.inspect(later,waiting.id);
    assert.equal(read.state,'done');assert.equal(read.arguments.command,'printf waiting-card');assert.equal(read.result.result.stdout,'made-up result');
    assert.equal((await a.inspect(later,stopped.id)).arguments.command,'printf stopped-card','a waiting action is read whole by a later turn of its chat');
    assert.equal((await a.inspect(await step('step-2'),job.id)).arguments.command,'printf job-step','and by a later step of its job');
    await assert.rejects(a.inspect(await step('other-step','fixture-other'),job.id),{code:'action_not_found'});
    await assert.rejects(a.inspect(reader(quiet,elsewhere.id,other),waiting.id),{code:'action_not_found'});
    await assert.rejects(a.inspect({...later,purpose:'filter'},waiting.id),{code:'action_not_found'});
    await assert.rejects(a.inspect({...later,scope:null},waiting.id),{code:'action_not_found'});
    // Without IDs, a later turn or step lists its own operations by state only, for the same readers.
    const listed=await a.recent(later),ids=listed.map(row=>row.id);
    assert.ok([waiting.id,stopped.id,early.id,late.id,permitted.id].every(id=>ids.includes(id)));assert.ok(!ids.includes(job.id));
    assert.ok(listed.every(row=>Object.keys(row).sort().join()==='created_at,error_code,id,kind,state'),'no arguments or results');
    assert.equal(listed.find(row=>row.id===waiting.id)!.state,'done');
    assert.deepEqual((await a.recent(await step('step-3'))).map(row=>row.id),[job.id],'a job step lists its own job\'s operations');
    assert.deepEqual(await a.recent(reader(quiet,elsewhere.id,other)),[]);assert.deepEqual(await a.recent({...later,purpose:'filter'}),[]);
    assert.ok(!(await a.recent({...later,scope:null})).some(row=>row.id===waiting.id));

    // Bounded permissions match only the exact action and binding they were given for.
    assert.equal((await a.preview(owner,{action_id:permitted.id})).decision.outcome,'allow');
    await run(permitted.id,'made-up permitted result');
    assert.equal((await stores.control.query('SELECT remaining FROM action_permissions WHERE id=$1',[grant.id])).rows[0].remaining,1);
    assert.equal(await standing(),true,'the conversation still lists the permission as current');
    const again=await a.propose(later,{kind:'shell',arguments:{command:'printf bounded-permission'}});
    assert.notEqual(again.fingerprint,permitted.fingerprint);assert.equal(again.state,'proposed');
    assert.deepEqual(await a.grants(await a.row(again.id)),[]);assert.equal((await a.preview(owner,{action_id:again.id})).decision.outcome,'ask');

    // A pending publication makes the claim wait, not reject.
    await stores.control.query("INSERT INTO guard_publications(id,operation_kind,source_id,revision,expected_revision,epoch) VALUES($1,'memory',$2,1,NULL,$3)",[key+':pending',digest('made-up entry'),quiet.epoch]);
    const eb=await host(early.id);
    try{assert.deepEqual(await x.claim(eb),{claimed:false});}finally{await stores.control.query('DELETE FROM guard_publications WHERE id=$1',[key+':pending']);}
    assert.equal((await a.row(early.id)).state,'approved');
    assert.equal(((await x.claim(eb)) as any).arguments.command,'printf approved-early');assert.deepEqual(await x.start(eb),{started:true});
    await x.finish({id:early.id,actor:eb.actor,state:'done',result:{stdout:'made-up early result',exit_code:0}});

    // A guarded-copy edit is not quiet: waiting and approved actions stop, and only their state is shown.
    const plain=await s.guards.read('events:'+source.id,quiet);
    await s.guards.edit('events:'+source.id,plain.revision,{...plain.value as any,text:'Please run the edited checks'},key+':edit');
    const changed=await s.guards.state();assert.ok(changed.epoch>quiet.epoch);
    await assert.rejects(a.decide(owner,{id:stopped.id,fingerprint:stopped.fingerprint,decision:'approve'}),{code:'guard_context_changed'});
    assert.equal((await a.preview(owner,{action_id:stopped.id})).decision.outcome,'deny');
    assert.equal(await inbox(stopped.id),'stale');assert.equal(await standing(),false);
    assert.equal((await x.claim(await host(late.id))).claimed,false);
    const rejected=await a.row(late.id);assert.equal(rejected.state,'rejected');assert.equal(rejected.error_code,'guard_context_changed');
    const current=reader(changed),view=await a.inspect(current,stopped.id);
    assert.deepEqual(Object.keys(view).sort(),['created_at','error_code','id','kind','state']);
    assert.equal(view.state,'proposed');assert.equal(view.error_code,'guard_context_changed');
    assert.equal((await a.recent(current)).find(row=>row.id===stopped.id)?.state,'proposed','it is still listed, by its state');
    await s.prepared.allow(current,view);// What the read route does with the view.
    const shown=(await stores.derived.query('SELECT content FROM runtime_prepared_values WHERE generation=$1 AND epoch=$2',[changed.generation,changed.epoch])).rows;
    assert.ok(!shown.some(row=>row.content.toString().includes('stopped-card')),'withdrawn arguments are never shown in the new epoch');
    const finished=await a.inspect(current,early.id);
    assert.equal(finished.result,undefined,'a finished action is no longer read whole either');
    assert.equal(finished.state,'done');assert.equal(finished.error_code,null,'and it never reads as stopped');

    // A quiet epoch after a stopping one does not bring the action back.
    await react('❤️');const after=await s.guards.state();assert.equal(after.epoch,changed.epoch+1);
    await assert.rejects(a.decide(owner,{id:stopped.id,fingerprint:stopped.fingerprint,decision:'approve'}),{code:'guard_context_changed'});
    assert.equal((await a.inspect(reader(after),stopped.id)).arguments,undefined);
    assert.equal((await a.inspect(owner,stopped.id)).arguments.command,'printf stopped-card','the owner still reviews the exact operation');
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

test('the executor checks the tool settings of the chat, not of the epoch the action was proposed in',()=>{
  const custom='profile-'+'a'.repeat(48),topic='-100555/topic/7';
  assert.deepEqual(preferenceProfile({logical_profile:custom,space_id:'123'},'123'),{profile:custom,space:'123'},'an owner\'s own named profile keeps its settings');
  assert.deepEqual(preferenceProfile({logical_profile:defaultLogicalProfile({admin:false,scope:'-100555',space:topic}),space_id:topic},'123'),
    {profile:defaultLogicalProfile({admin:false,scope:'-100555',space:topic}),space:topic});
  assert.deepEqual(preferenceProfile({logical_profile:'job-'+'b'.repeat(24),space_id:'123'},'123'),{profile:defaultLogicalProfile({admin:false,scope:null,space:'123'}),space:'123'},
    'a job follows its chat\'s settings');
  assert.deepEqual(preferenceProfile({logical_profile:defaultLogicalProfile({admin:false,scope:null,space:'123/topic/4'}),space_id:'123/topic/4'},'123'),
    {profile:defaultLogicalProfile({admin:false,scope:null,space:'123'}),space:'123'},'the owner\'s private chat has no settings per topic');
});

test('automatic learning revisions are quiet; owner corrections are not; learning waits for a running action',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-learning-epochs-')),key='learning-epochs:'+Date.now(),asking='-100556';
  const owner={admin:true,scope:null},s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[asking]}),
    runtime:async(operation)=>{assert.equal(operation,'guard.detect');return {literals:[]};},honcho:async()=>{throw Error('no provider');}});
  const a=s.controlledActions,x=s.controlledExecution;
  const host=async(id:string)=>{
    const row=(await stores.control.query("SELECT * FROM workflow_registry WHERE family='tools' AND job_id=$1",[id])).rows[0];
    const lease=await claimHostWorkflow(stores.control,{workflow_id:row.id,dispatch:row.dispatch,family:'tools',run_id:'fixture-'+row.id});assert.equal(lease.claimed,true);
    return {id,actor:'wf-'+row.id,workflow_id:row.id,workflow_token:lease.token};
  };
  const quiet=async(b:GuardBinding)=>(await stores.control.query('SELECT reason FROM guard_quiet_epochs WHERE generation=$1 AND epoch=$2',[b.generation,b.epoch])).rows;
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    const payload={update_id:1,message:{message_id:1,date:1700000001,chat:{id:Number(asking),type:'supergroup',is_forum:false},from:{id:7},text:'A green mark means a made-up task is done'}};
    const value:Envelope={version:1,key:key+':request',origin:'live',kind:'telegram_update',bot_id:key,scope:asking,source_id:'1',revision:'1',occurred_at:null,text:payload.message.text,payload};
    const source=(await s.capture.capture(value)).source.reference;await s.guards.prepare(source,'fixture',s.detect);
    const reader=(b:GuardBinding)=>({admin:false,scope:asking,space:asking,turnEvent:source.id,generation:b.generation,guard_epoch:b.epoch,revision:b.epoch});
    const entry=digest(key+':entry'),meaning:Interpretation={kind:'meaning',subject:'green mark',text:'A green mark means done.',scope:{kind:'conversation',id:asking},
      uncertainty:'supported',evidence:[source],conflicts:[]};
    let jobs=0;
    // What the learning engine does: stage the versions under the job's binding, then activate them in one batch.
    const learn=async(text:string,expected:number|null,id=entry)=>{
      const binding=await s.guards.state(),prepared=await s.guards.read('events:'+source.id,binding),job=key+':job-'+(++jobs);
      const dependencies=[{source_id:'events:'+source.id,revision:prepared.revision,value_hash:digest(canonical(prepared.value))}];
      await stores.control.query(`INSERT INTO interpretation_jobs(id,source_reference,workspace,audience,input_reference,binding,context_hash,state)
        VALUES($1,$2,'fixture','fixture',$2,$3,$4,'running')`,[job,source,binding,digest(job)]);
      const version=await s.learned.stageAutomatic(id,{...meaning,text},expected,job+':0',dependencies,binding,'fixture',s.detect);
      return {activate:async()=>{await s.learned.activateBatch([version],binding,job,digest(job+':result'),[id]);await s.learned.finish(version.operation_id);},version};
    };
    const before=await s.guards.state();await (await learn(meaning.text,null)).activate();
    const proposed=await s.guards.state(),asker=reader(proposed),shell=(command:string)=>a.propose(asker,{kind:'shell',arguments:{command}});
    assert.equal(proposed.epoch,before.epoch,'a first version advances no epoch, so it records none');
    const waiting=await shell('printf learning-card'),running=await shell('printf running-action'),stopped=await shell('printf corrected-card');
    await a.decide(owner,{id:running.id,fingerprint:running.fingerprint,decision:'approve'});

    // An approved action that is running holds back a learning batch, which goes back to waiting.
    const held=await learn('A green mark means finished.',1),rb=await host(running.id),claim=await x.claim(rb) as any;
    assert.equal(claim.claimed,true);assert.deepEqual(claim.preference,{profile:defaultLogicalProfile(asker),space:asking});
    await assert.rejects(held.activate(),{code:'learning_publication_pending'});
    assert.equal((await s.guards.state()).epoch,proposed.epoch,'no epoch while it runs');
    assert.deepEqual(await x.start(rb),{started:true});
    await x.finish({id:running.id,actor:rb.actor,state:'done',result:{stdout:'made-up result',exit_code:0}});

    // Once it has run, the revision is published, and its epoch is quiet.
    await held.activate();const revised=await s.guards.state();assert.equal(revised.epoch,proposed.epoch+1);
    assert.deepEqual(await quiet(revised),[{reason:'learning'}]);
    assert.equal((await s.supervision.decision(owner,'controlled_action',waiting.id)).observation,'current','the Inbox keeps Approve open after a learning revision');
    assert.equal((await a.decide(owner,{id:waiting.id,fingerprint:waiting.fingerprint,decision:'approve'})).state,'approved');
    const wb=await host(waiting.id),carried=await x.claim(wb) as any;assert.equal(carried.claimed,true);assert.equal(carried.arguments.command,'printf learning-card');
    assert.deepEqual(carried.preference,claim.preference,'the executor checks the same chat settings in the later epoch');
    assert.notEqual(carried.profile,defaultLogicalProfile(asker));
    assert.deepEqual(await x.start(wb),{started:true});
    await x.finish({id:waiting.id,actor:wb.actor,state:'done',result:{stdout:'made-up later result',exit_code:0}});

    // An owner correction is not quiet: the waiting action stops.
    const corrected=await s.learned.correct(owner,entry,{expected_revision:held.version.revision,operation_id:key+':correct',text:'Here a green mark means reviewed.',retired:false},s.detect);
    const after=await s.guards.state();assert.ok(after.epoch>revised.epoch);assert.deepEqual(await quiet(after),[]);
    await assert.rejects(a.decide(owner,{id:stopped.id,fingerprint:stopped.fingerprint,decision:'approve'}),{code:'guard_context_changed'});
    assert.equal(corrected.revision,held.version.revision+1);
    // A first version of another entry advances no epoch, so the correction's epoch stays unrecorded.
    await (await learn('A red mark means blocked.',null,digest(key+':other-entry'))).activate();
    assert.equal((await s.guards.state()).epoch,after.epoch);assert.deepEqual(await quiet(after),[]);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});

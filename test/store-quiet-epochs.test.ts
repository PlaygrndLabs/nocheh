import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
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
      const operation=await s.operations.record({key:key+':'+label,kind:'background_step',scope:asking,input_hash:digest(label)});
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

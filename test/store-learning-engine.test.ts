import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {initializeStoreDatabases,connectStores} from '../src/stores/connections.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {DerivedRepository} from '../src/stores/derived.js';
import {GuardRepository} from '../src/stores/guards.js';
import {ProjectRepository} from '../src/stores/projects.js';
import {EntityRepository} from '../src/stores/entities.js';
import {SelectionRepository} from '../src/stores/selections.js';
import {LearnedMemoryRepository} from '../src/stores/learned.js';
import {SourceAccessRepository} from '../src/stores/access.js';
import {LearningContextRepository} from '../src/stores/learning-context.js';
import {ContextualLearningRepository} from '../src/stores/learning-engine.js';
import {HonchoProvenanceRepository} from '../src/stores/honcho-provenance.js';

test('silent Honcho learning uses authorized relationship evidence and recovers output/activation without duplicate reasoning',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!},admin=new pg.Pool(config);
  try {assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),derived=new DerivedRepository(stores.derived,archive),guards=new GuardRepository(stores,archive);
  const key='learning:'+Date.now(),group=String(-Date.now()),space=group+'/topic/17';
  const policy={enabled:true,owner_id:'42',group_ids:[group]},access=new SourceAccessRepository(stores,archive,guards,()=>policy);
  const learned=new LearnedMemoryRepository(stores,archive,derived,guards),projects=new ProjectRepository(stores.control),selections=new SelectionRepository(stores,guards);
  const contexts=new LearningContextRepository(access,guards,learned,selections,projects,new EntityRepository(stores,access,projects));
  const event=(label:string,payload:any):Envelope=>({version:1,key:key+':'+label,origin:'live',bot_id:key,kind:'telegram_update',scope:group,
    source_id:String(payload.message?.message_id??payload.message_reaction?.message_id),revision:String(payload.update_id),occurred_at:null,text:payload.message?.text??null,payload});
  const detect=async(text:string)=>text.includes('fixture-secret')?['fixture-secret']:[];
  const authority={owner:'inngest' as const,epoch:1};let calls=0,response:unknown;
  const call=async(path:string,body:any)=>{
    calls++;assert.match(path,/\/peers\/person_[a-f0-9]{64}\/chat$/,'the only effect is bounded Honcho reasoning for the actual speaker');
    assert.ok(body.query.includes('message_reaction'));assert.ok(!body.query.includes('fixture-secret'));
    assert.ok(!body.query.includes('nested-unverified-target'));
    assert.ok(Array.isArray(body.filters?.session_id)&&body.filters.session_id.length>0,'topic learning reasons only over that topic\'s own sessions');
    return {content:JSON.stringify(response)};
  };
  const readable=async(workspace:string,label:string)=>{
    const session=digest(key+':session:'+label);
    await stores.control.query(`INSERT INTO memory_sessions(workspace,key,audience,kind,session_id) VALUES($1,$2,$3,'conversation',$4)`,[workspace,session,space,session]);
    await stores.control.query(`INSERT INTO memory_ingestion_receipts(id,generation,audience,source_reference,guard_source_id,prepared_id,content_hash,state,session_id)
      VALUES($1,$2,$3,'{}','fixture','fixture',$4,'done',$5)`,[digest(key+':receipt:'+label),workspace,space,digest('fixture'),session]);
  };
  const provenance=new HonchoProvenanceRepository(stores,archive,guards,call),learning=new ContextualLearningRepository(contexts,derived,guards,learned,provenance,call);
  try {
    await guards.setMode('on');
    const reaction=(await archive.capture(event('reaction',{update_id:30,message_reaction:{chat:{id:group},message_id:1,date:1700000010,user:{id:7},old_reaction:[],new_reaction:[{type:'emoji',emoji:'✅'}]}}))).source.reference;
    await guards.prepare(reaction,'fixture',detect);
    await assert.rejects(contexts.prepare(reaction,await guards.state()),{code:'learning_context_pending'});
    const parent=(await archive.capture(event('parent',{update_id:10,message:{message_id:1,chat:{id:group,type:'supergroup'},message_thread_id:17,
      from:{id:7},text:'Review this packet. fixture-secret',reply_to_message:{message_id:999,text:'nested-unverified-target'}}}))).source.reference;
    await guards.prepare(parent,'fixture',detect);
    const prepared=await contexts.prepare(reaction,await guards.state());
    assert.equal(prepared.evidence.length,2);assert.ok(prepared.evidence.some(e=>e.reference.id===parent.id));
    assert.ok(!JSON.stringify(prepared.observations).includes('nested-unverified-target'));
    const binding=await guards.state(),workspace=digest(key+':workspace');
    await stores.control.query('UPDATE memory_engine_connection SET attached=true,verified=true');
    await stores.control.query('INSERT INTO memory_generations(id,installation_generation,guard_epoch,audience) VALUES($1,$2,$3,$4)',[workspace,binding.generation,binding.epoch,space]);
    await readable(workspace,'first');
    response={organization:'malformed optional output must not prevent learning',interpretations:[
      {kind:'meaning',subject:'check',text:'A check means reviewed in this conversation.',scope:{kind:'conversation',id:space},uncertainty:'uncertain',evidence_ids:[reaction.id,parent.id],conflicts:[]},
      {kind:'state',subject:'packet',text:'The packet may have been reviewed.',scope:{kind:'conversation',id:space},uncertainty:'uncertain',evidence_ids:[reaction.id,parent.id],conflicts:[]},
    ]};
    const job=await learning.request(reaction,workspace,space);
    await assert.rejects(learning.run(job,async()=>{throw Error('injected-detector-outage');},authority),/injected-detector-outage/);
    assert.equal(calls,1);
    await stores.control.query("INSERT INTO dispatches(event_id,source_reference,binding,state) VALUES($1,$2,$3,'running')",[parent.id,parent,binding]);
    await assert.rejects(learning.run(job,detect,authority),{code:'learning_publication_pending'},'a first learned publication also waits before taking the guard barrier');
    assert.equal(calls,1);assert.deepEqual(await guards.state(),binding);
    assert.equal((await stores.control.query('SELECT state,jsonb_array_length(publication_ids) AS publications FROM interpretation_jobs WHERE id=$1',[job])).rows[0].publications,0);
    await stores.control.query("UPDATE dispatches SET state='done' WHERE event_id=$1",[parent.id]);
    const realFinish=learned.finish.bind(learned);learned.finish=async()=>{throw Error('injected-batch-interruption');};
    await assert.rejects(learning.run(job,detect,authority),/injected-batch-interruption/);
    assert.equal((await stores.control.query('SELECT state FROM interpretation_jobs WHERE id=$1',[job])).rows[0].state,'publishing');
    await assert.rejects(guards.state(),{code:'guard_transition_pending'});
    learned.finish=realFinish;
    const ids=await learning.run(job,detect,authority);assert.equal(ids.length,2);assert.equal(calls,1,'a saved reasoning result is never rerun after preparation or publication failure');
    assert.deepEqual(await learning.run(job,detect,authority),ids);
    assert.equal((await stores.control.query("SELECT count(*) FROM workflow_registry WHERE family='organization' AND job_id=$1",['learning:'+job])).rows[0].count,'1',
      'publishing recovery commits completion and one deterministic organization follow-up');
    assert.equal(await learning.request(reaction,workspace,space),job,'learned output does not recursively create another learning request');
    for(const id of ids)assert.equal((await learned.read(access.principal(space),id,await guards.state(),r=>access.canRead(access.principal(space),r,binding))).revision,1);
    // Learning never schedules a dispatch, outbound action, or approval; the row above only simulates an active reply.
    assert.equal((await stores.control.query("SELECT count(*) FROM workflow_registry WHERE job_id=$1 AND family='memory_review'",['interpret:'+job])).rows[0].count,'1');
    const wrong={...access.principal(space),space:group+'/topic/18'};
    assert.equal(await access.canRead(wrong,parent,binding),false);
    const removed=(await archive.capture(event('removed',{update_id:31,message_reaction:{chat:{id:group},message_id:1,date:1700000011,user:{id:7},
      old_reaction:[{type:'emoji',emoji:'✅'}],new_reaction:[]}}))).source.reference;
    await guards.prepare(removed,'fixture',detect);
    response={interpretations:[
      {kind:'meaning',subject:'check',text:'A check indicates review, and removal withdraws that signal.',scope:{kind:'conversation',id:space},uncertainty:'uncertain',evidence_ids:[removed.id,parent.id],conflicts:[]},
      {kind:'state',subject:'packet',text:'The review signal was withdrawn; actual completion is unknown.',scope:{kind:'conversation',id:space},uncertainty:'uncertain',evidence_ids:[removed.id,parent.id],conflicts:[]},
    ]};
    const updateJob=await learning.request(removed,workspace,space);let finished=0;
    await stores.control.query("UPDATE dispatches SET state='running',binding=$2 WHERE event_id=$1",[parent.id,binding]);
    await assert.rejects(learning.run(updateJob,detect,authority),{code:'learning_publication_pending'});
    assert.equal(calls,2,'the pending publication retains its completed reasoning result');
    assert.equal((await stores.control.query('SELECT state FROM interpretation_jobs WHERE id=$1',[updateJob])).rows[0].state,'pending');
    assert.deepEqual(await guards.state(),binding,'automatic replacement cannot revoke an admitted reply');
    for(const id of ids)assert.equal((await learned.read(access.principal(space),id,binding,r=>access.canRead(access.principal(space),r,binding))).revision,1);
    await stores.control.query("UPDATE dispatches SET state='done' WHERE event_id=$1",[parent.id]);
    const browserRun=digest(key+':active-browser');
    await stores.control.query(`INSERT INTO managed_runs(event_id,channel,source_reference,scope,space_id,logical_profile,conversation_id,binding,state,lease_until)
      VALUES($1,'browser',$2,$3,$4,'default','publication-fixture',$5,'running',now()+interval '1 minute')`,[browserRun,parent,group,space,binding]);
    await assert.rejects(learning.run(updateJob,detect,authority),{code:'learning_publication_pending'});
    assert.equal(calls,2,'managed reply deferral reuses the same saved reasoning result');
    await stores.control.query("UPDATE managed_runs SET lease_until=now()-interval '1 second' WHERE event_id=$1",[browserRun]);
    await stores.control.query("UPDATE dispatches SET state='running',binding=$2 WHERE event_id=$1",[parent.id,{...binding,epoch:binding.epoch-1}]);
    learned.finish=async operation=>{if(++finished===2)throw Error('injected-partial-batch');await realFinish(operation);};
    await assert.rejects(learning.run(updateJob,detect,authority),/injected-partial-batch/);
    assert.equal(calls,2);await assert.rejects(guards.state(),{code:'guard_transition_pending'});
    learned.finish=realFinish;
    const updated=await learning.run(updateJob,detect,authority);assert.deepEqual(updated,ids);
    await assert.rejects(guards.assertCurrent(binding),{code:'guard_context_changed'});
    const currentBinding=await guards.state();
    for(const id of updated)assert.equal((await learned.read(access.principal(space),id,currentBinding,r=>access.canRead(access.principal(space),r,currentBinding))).revision,2);
    const nextWorkspace=digest(key+':next-workspace');
    await stores.control.query('INSERT INTO memory_generations(id,installation_generation,guard_epoch,audience) VALUES($1,$2,$3,$4)',[nextWorkspace,currentBinding.generation,currentBinding.epoch,space]);
    await readable(nextWorkspace,'next');
    assert.equal(await learning.request(removed,nextWorkspace,space),updateJob,'an unrelated generation refresh reuses identical authorized inputs');
    assert.equal(calls,2);
    // A convention's generated wording is guidance, not independent new evidence.
    const conventionText='In this conversation a green mark means ready for review.';
    const convention=(await archive.capture(event('convention',{update_id:40,message:{message_id:4,chat:{id:group,type:'supergroup'},message_thread_id:17,
      from:{id:7},text:conventionText}}))).source.reference;
    await guards.prepare(convention,'fixture',detect);
    const ruleDependencies=(await contexts.prepare(convention,await guards.state())).dependencies;
    const rule={kind:'convention' as const,subject:'green mark',text:conventionText,scope:{kind:'conversation' as const,id:space},
      uncertainty:'explicit' as const,evidence:[convention],quote:{source_id:convention.id,text:conventionText},conflicts:[]};
    const ruleId=digest(key+':rule');
    await learned.publishAutomatic(ruleId,rule,null,key+':rule-first',ruleDependencies,await guards.state(),'fixture',detect);
    const withConvention=await learning.request(removed,nextWorkspace,space);
    assert.notEqual(withConvention,updateJob,'new original convention evidence must trigger fresh learning');
    response={interpretations:[]};await learning.run(withConvention,detect,authority);assert.equal(calls,3);
    assert.equal((await stores.control.query("SELECT count(*) FROM workflow_registry WHERE family='organization' AND job_id=$1",['learning:'+withConvention])).rows[0].count,'1',
      'normal completion also commits exactly one organization follow-up without another model request');
    const beforeRewrite=await contexts.prepare(removed,await guards.state());
    await learned.publishAutomatic(ruleId,{...rule,text:'A green mark signals readiness for review here.'},1,key+':rule-rephrased',
      ruleDependencies,await guards.state(),'fixture',detect);
    const workspaceNow=async(label:string)=>{
      const state=await guards.state(),id=digest(key+':'+label);
      await stores.control.query('INSERT INTO memory_generations(id,installation_generation,guard_epoch,audience) VALUES($1,$2,$3,$4)',[id,state.generation,state.epoch,space]);
      await readable(id,label);return id;
    };
    const rephrasedWorkspace=await workspaceNow('rephrased');
    const afterRewrite=await contexts.prepare(removed,await guards.state());
    assert.notDeepEqual(beforeRewrite.rules,afterRewrite.rules,'the model still receives the complete current rule wording');
    assert.deepEqual(beforeRewrite.rule_inputs,afterRewrite.rule_inputs);
    assert.equal(await learning.request(removed,rephrasedWorkspace,space),withConvention,'generated paraphrasing cannot restart learning');
    await learned.publishAutomatic(digest(key+':second-rule'),{...rule,subject:'readiness'},null,key+':rule-renamed',ruleDependencies,
      await guards.state(),'fixture',detect);
    assert.equal(await learning.request(removed,rephrasedWorkspace,space),withConvention,'model-chosen rule identities cannot multiply the same evidence');
    const ruleArtifact=(await stores.derived.query('SELECT derived_id FROM learned_versions WHERE entry_id=$1 AND revision=2',[ruleId])).rows[0].derived_id;
    const guardedRule=await guards.read('derived_artifacts:'+ruleArtifact,await guards.state());
    await guards.edit('derived_artifacts:'+ruleArtifact,guardedRule.revision,
      {...guardedRule.value as object,text:'The owner-edited guarded convention requires review only.'},key+':rule-guard-edit');
    const guardedWorkspace=await workspaceNow('guarded-rule');
    const guardedJob=await learning.request(removed,guardedWorkspace,space);
    assert.notEqual(guardedJob,withConvention,'an owner edit to a guarded automatic convention must trigger fresh learning');
    await learning.run(guardedJob,detect,authority);assert.equal(calls,4);
    const beforeOwnerCorrection=await guards.state();
    await stores.control.query("UPDATE dispatches SET state='running',binding=$2 WHERE event_id=$1",[parent.id,beforeOwnerCorrection]);
    await learned.correct({admin:true,scope:null},ruleId,{expected_revision:2,operation_id:key+':owner-rule',
      text:'A green mark only requests review; it never confirms completion.',retired:false},detect);
    await assert.rejects(guards.assertCurrent(beforeOwnerCorrection),{code:'guard_context_changed'},'owner correction remains immediate during an admitted reply');
    await stores.control.query("UPDATE dispatches SET state='done' WHERE event_id=$1",[parent.id]);
    const ownerWorkspace=await workspaceNow('owner-rule');
    const ownerJob=await learning.request(removed,ownerWorkspace,space);
    assert.notEqual(ownerJob,withConvention,'an owner correction must invalidate the prior interpretation input');
    await learning.run(ownerJob,detect,authority);assert.equal(calls,5);
    await learned.correct({admin:true,scope:null},ruleId,{expected_revision:3,operation_id:key+':retire-owner-rule',text:'',retired:true},detect);
    const retiredWorkspace=await workspaceNow('retired-rule');
    assert.notEqual(await learning.request(removed,retiredWorkspace,space),ownerJob,'retiring owner guidance must not reuse that guidance');
    const stale=await guards.state();
    await access.setConsent({admin:true,scope:null},parent,{enabled:false,expected_revision:0,operation_id:key+':revoke'});
    await assert.rejects(guards.assertCurrent(stale),{code:'guard_context_changed'});
    assert.equal(await access.canLearn(parent,await guards.state()),false);
    assert.ok(!(await contexts.prepare(reaction,await guards.state())).evidence.some(item=>item.reference.id===parent.id),'withdrawn evidence never reaches reasoning');
    await stores.control.query("UPDATE memory_generations SET state='retired' WHERE id=$1",[workspace]);
    await assert.rejects(learning.request(reaction,workspace,space),{code:'memory_context_retired'});
    assert.equal(calls,5);
  } finally {
    await stores.control.query('UPDATE memory_engine_connection SET attached=false,verified=false');await stores.close();
  }
});

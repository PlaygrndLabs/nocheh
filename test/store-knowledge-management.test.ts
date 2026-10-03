import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {canonical,digest,type Envelope} from '../src/archive.js';
import {initializeStoreDatabases,connectStores} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import type {OrganizationProposal} from '../src/stores/knowledge-contract.js';
import type {SourceReference} from '../src/stores/archive.js';
import type {Interpretation} from '../src/interpretations.js';

test('delegated organization is exact, atomic, reversible, and independent from every access authority',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config={host:process.env.PGHOST!,port:Number(process.env.PGPORT??5432),user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const admin=new pg.Pool(config);try{assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  await initializeStoreDatabases(config,{archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')});
  const stores=connectStores(config,{archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')});
  const owner={admin:true,scope:null},key='organization:'+Date.now(),group='-'+Date.now(),other=String(Number(group)-1),topic=group+'/topic/99';let sequence=0;
  const s=storageServices(stores,{dataDir:'/tmp',detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[group,other]}),
   runtime:async operation=>{assert.equal(operation,'guard.detect');return {literals:[]};},honcho:async()=>{throw Error('no provider calls');}});
  const knowledge=s.knowledge as any;
  // Model-provider and reply-delivery setup are outside this storage fixture. Keep all proposal,
  // authority, guarded-evidence, transaction, receipt and replay behavior real.
  const completed=knowledge.completed.bind(knowledge);knowledge.completed=async()=> 'ready';
  const capture=async(scope=group,origin:'live'|'import'='live',extra:Record<string,unknown>={})=>{
   const index=++sequence,text='Synthetic evidence: this conversation serves the Aurora project';
   const event:Envelope={version:1,key:key+':capture:'+index,origin,kind:'telegram_update',bot_id:key,scope,source_id:String(index),revision:'1',occurred_at:null,text,
    payload:{message:{message_id:index,date:1,chat:{id:Number(scope),type:'supergroup'},from:{id:123,first_name:'Synthetic owner'},text,...extra}}};
   const reference=(await s.capture.capture(event)).source.reference;await s.guards.prepare(reference,'fixture',s.detect);return reference;
  };
  const proposal=(source:SourceReference,name:string,scope=group,expected=0):OrganizationProposal=>({kind:'organization',reason:'Organize the explicit project evidence',
   creates:[{key:'project',name:key+':'+name,description:'Synthetic project',evidence_ids:[source.id]}],
   assignments:[{space_id:scope,project_key:'project',expected_revision:expected,evidence_ids:[source.id],reason:'Explicit purpose evidence',purpose_evidence:true}]});
  const match=async(value:OrganizationProposal,source:SourceReference,space=group,origin='learning',required?:{id:string;revision:number})=>
   knowledge.matchDelegation(value,{source,space,origin,binding:await s.guards.state()},undefined,required);
  const persist=async(label:string,value:OrganizationProposal,source:SourceReference,space=group)=>{
   const binding=await s.guards.state(),dependencies=await knowledge.snapshot(owner,[source.id],binding),id=digest(key+':proposal:'+label);
   return knowledge.persist(id,value,{origin:'learning',source,space,profile:null,job:digest(key+':job:'+label),binding,dependencies});
  };
  const savedLearning=async(label:string,source:SourceReference,organization:OrganizationProposal,space=other)=>{
   const binding=await s.guards.state(),dependencies=await knowledge.snapshot(owner,[source.id],binding),id=digest(key+':saved-learning:'+label);
   const context={source,space,binding,evidence:[{reference:source,text:'Synthetic original project evidence',space}],dependencies:dependencies.values,
    rule_inputs:[],organization_context:{projects:[]}};
   const input=await s.derived.record({operation_id:'learning-input:'+id,source,kind:'runtime_context',content:Buffer.from(canonical(context)),
    producer:'nocheh',producer_version:'fixture',configuration:{},provenance:{purpose:'contextual_learning',binding}});
   const result=await s.derived.record({operation_id:'learning-result:'+id,source,kind:'learning_result',content:Buffer.from(canonical({interpretations:[],entity_suggestions:[],entity_claims:[],organization})),
    producer:'honcho',producer_version:'fixture',configuration:{},provenance:{input}});
   await stores.control.query(`INSERT INTO interpretation_jobs(id,source_reference,workspace,audience,input_reference,binding,context_hash,output_id,state)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'done')`,[id,source,'fixture:'+id,space,input,binding,digest(canonical(context)),result.id]);
   return id;
  };
  const permissions=async()=>{
   const result:Record<string,number>={};for(const table of ['sharing_rules','memory_fact_grants','action_permissions','security_policy_versions'])result[table]=Number((await stores.control.query('SELECT count(*)::int AS count FROM '+table)).rows[0].count);return result;
  };
  let delegation:any;
  const save=async(changes:Record<string,unknown>={},label='save')=>{
   const previous=delegation;
   delegation=await s.knowledge.saveDelegation(owner,{...(previous?{id:previous.id}:{}),name:'Synthetic organization',enabled:true,scopes:[group],project_ids:[],allow_create:true,
    expires_at:null,expected_revision:previous?.revision??0,operation_id:key+':delegation:'+label,...changes});return delegation;
  };
  try {
   await s.guards.reconcile();await s.guards.setMode('on');
   const historical=await capture(),initial=proposal(historical,'historical');
   assert.equal(await match(initial,historical),null,'existing installations have no inferred organization authority');
   await save({enabled:false},'disabled');assert.equal(await match(initial,historical),null);
   await save({},'enable');assert.equal(await match(initial,historical),null,'old capture sequences cannot acquire automatic authority');
   const imported=await capture(group,'import');assert.equal(await match(proposal(imported,'import'),imported),null);
   const source=await capture(),automatic=proposal(source,'automatic');assert.equal((await match(automatic,source)).id,delegation.id);
   const noPurpose={...automatic,assignments:automatic.assignments.map(change=>({...change,purpose_evidence:false}))};assert.equal(await match(noPurpose,source),null,'mention evidence is not assignment evidence');
   const outside={...automatic,assignments:automatic.assignments.map(change=>({...change,space_id:other}))};assert.equal(await match(outside,source),null);
   assert.equal(await match(automatic,source,group,'learning',{id:delegation.id,revision:delegation.revision+1}),null);
   const beforeAuthority=await permissions(),pending=await persist('automatic',automatic,source);assert.equal(pending.state,'queued');
   const before=await s.guards.state();
   await stores.control.query("INSERT INTO dispatches(event_id,source_reference,binding,state) VALUES($1,$2,$3,'running')",[historical.id,historical,before]);
   const waiting=await s.knowledge.process('proposal:'+pending.id);assert.equal(waiting.state,'waiting');assert.equal(waiting.reason,'foreground_reply_active');
   assert.deepEqual(await s.guards.state(),before,'waiting for a foreground reply does not invalidate it');
   await stores.control.query("UPDATE dispatches SET state='done' WHERE event_id=$1",[historical.id]);
   const applied=await s.knowledge.process('proposal:'+pending.id);assert.equal(applied.state,'applied');
   const after=await s.guards.state();assert.equal(after.epoch,before.epoch+1,'create and assignment produce one invalidation');
   const receipt=await s.knowledge.proposal(owner,pending.id),created=receipt.result.created[0];
   assert.equal(receipt.result.assignments.length,1);assert.equal(receipt.result.authorization.delegation_id,delegation.id);
   assert.deepEqual(receipt.result.evidence,[source]);assert.deepEqual(await permissions(),beforeAuthority);
   assert.equal((await s.projects.effective(group)).project?.id,created.id);
   const replay=await s.knowledge.process('proposal:'+pending.id);assert.equal(replay.state,'applied');assert.deepEqual(await s.guards.state(),after);
   const unchanged:OrganizationProposal={kind:'organization',reason:'Same assignment observed again',creates:[],assignments:[{space_id:group,project_id:created.id,expected_revision:1,evidence_ids:[source.id],reason:'Still the same project',purpose_evidence:true}]};
   const noOp=await persist('noop',unchanged,source);
   await stores.control.query("UPDATE knowledge_proposals SET origin='turn',source_job_id=NULL WHERE id=$1",[noOp.id]);
   await stores.control.query("INSERT INTO dispatches(event_id,source_reference,binding,state) VALUES($1,$2,$3,'running')",[source.id,source,await s.guards.state()]);
   knowledge.completed=completed;
   assert.equal((await s.knowledge.process('proposal:'+noOp.id)).state,'waiting','owner-turn proposals wait for confirmed reply completion');
   await stores.control.query("UPDATE dispatches SET state='suppressed',error_code='unsupported_message' WHERE event_id=$1",[source.id]);
   assert.equal(await completed({origin:'turn',source_reference:source}),'cancelled','ordinary suppression is not a successful turn');
   await stores.control.query("UPDATE dispatches SET error_code='intentional_silence' WHERE event_id=$1",[source.id]);
   assert.equal(await completed({origin:'turn',source_reference:source}),'ready','intentional conversational silence is a confirmed completed turn');
   await stores.control.query("UPDATE dispatches SET state='done',error_code=NULL WHERE event_id=$1",[source.id]);
   assert.equal((await s.knowledge.process('proposal:'+noOp.id)).state,'applied');
   knowledge.completed=async()=> 'ready';
   assert.equal((await s.knowledge.proposal(owner,noOp.id)).result.changed,false);assert.deepEqual(await s.guards.state(),after);
   await s.projects.assign(owner,{space_id:group,project_id:null,mode:'none',expected_revision:1,operation_id:key+':owner-correction'});
   unchanged.assignments[0]!.expected_revision=2;assert.equal(await match(unchanged,source),null,'owner correction suspends automatic reassignment');
   assert.equal(await match({...proposal(source,'suspended-discovery'),assignments:[]},source),null,'suspension also prevents automatic create-only organization');
   assert.ok((await s.knowledge.delegations(owner)).delegations.find(d=>d.id===delegation.id)!.suspended_scopes.includes(group));
   await save({name:'Renamed permission'},'rename');assert.equal(delegation.baselines[group],1,'ordinary permission edits do not resume a suspended scope');
   await save({resume_scopes:[group]},'resume');assert.equal(delegation.baselines[group],2);
   const recent=await capture();unchanged.assignments[0]!.evidence_ids=[recent.id];assert.equal((await match(unchanged,recent)).id,delegation.id);
   await assert.rejects(s.knowledge.undo(owner,pending.id,{expected_revision:receipt.revision,operation_id:key+':undo-conflict'}),{code:'knowledge_undo_conflict'});
   assert.equal((await s.knowledge.proposal(owner,pending.id)).state,'applied','conflicting undo preserves original receipt');
   await capture(group,'live',{message_thread_id:99});assert.equal(await match(unchanged,recent),null,'newly discovered inheriting topics do not silently gain scope');
   await s.projects.assign(owner,{space_id:topic,project_id:null,mode:'none',expected_revision:0,operation_id:key+':topic-exclusion'});
   assert.equal((await match(unchanged,recent)).id,delegation.id,'an explicitly excluded topic is not affected by a parent assignment');
   await stores.control.query("UPDATE organization_delegations SET expires_at=now()-interval '1 second' WHERE id=$1",[delegation.id]);assert.equal(await match(unchanged,recent),null,'expired authority is not used');
   await save({enabled:false},'revoke');assert.equal(await match(unchanged,recent),null);

   // A reviewed inconsistent batch rolls back its project creation when an assignment conflicts.
   const broken=proposal(recent,'must-rollback',group,999),draft=await persist('broken',broken,recent);assert.equal(draft.state,'review');
   await s.knowledge.decide(owner,draft.id,{decision:'approve',expected_revision:draft.revision,operation_id:key+':approve-broken'});
   const failed=await s.knowledge.process('proposal:'+draft.id);assert.equal(failed.state,'stale');
   assert.equal((await stores.control.query('SELECT 1 FROM projects WHERE name=$1',[broken.creates[0]!.name])).rowCount,0);
   assert.equal((await s.projects.effective(group)).own_assignment?.revision,2);

   // An owner change to a parent also suspends a delegated topic that inherits it.
   const inheritedTopic=group+'/topic/100';delegation=null;
   await save({scopes:[inheritedTopic],project_ids:[created.id]},'inherited-topic');
   const topicSource=await capture(group,'live',{message_thread_id:100});
   const inheritedAssignment:OrganizationProposal={kind:'organization',reason:'Explicit topic purpose',creates:[],assignments:[{space_id:inheritedTopic,project_id:created.id,expected_revision:0,
    evidence_ids:[topicSource.id],reason:'This topic serves the project',purpose_evidence:true}]};
   assert.equal((await match(inheritedAssignment,topicSource,inheritedTopic)).id,delegation.id);
   await s.projects.assign(owner,{space_id:group,project_id:created.id,mode:'assigned',expected_revision:2,operation_id:key+':parent-owner-edit'});
   assert.equal((await s.projects.effective(inheritedTopic)).own_assignment,null);
   assert.equal(await match(inheritedAssignment,topicSource,inheritedTopic),null,'an unchanged own revision does not hide an owner edit to inherited organization');
   assert.ok((await s.knowledge.delegations(owner)).delegations.find(d=>d.id===delegation.id)!.suspended_scopes.includes(inheritedTopic));
   await save({scopes:[inheritedTopic],project_ids:[created.id],resume_scopes:[inheritedTopic]},'resume-inherited');
   const resumedTopicSource=await capture(group,'live',{message_thread_id:100});inheritedAssignment.assignments[0]!.evidence_ids=[resumedTopicSource.id];
   assert.equal((await match(inheritedAssignment,resumedTopicSource,inheritedTopic)).id,delegation.id);

   // Clean undo restores the prior assignment and archives, rather than erases, the created project.
   delegation=null;await save({scopes:[other]},'other');const otherSource=await capture(other),otherDraft=await persist('other',proposal(otherSource,'other',other),otherSource,other);
   assert.equal((await s.knowledge.process('proposal:'+otherDraft.id)).state,'applied');
   const otherReceipt=await s.knowledge.proposal(owner,otherDraft.id);
   assert.equal((await s.knowledge.undo(owner,otherDraft.id,{expected_revision:otherReceipt.revision,operation_id:key+':undo'})).state,'undone');
   assert.equal((await s.projects.effective(other)).project,null);
   assert.equal((await stores.control.query('SELECT state FROM projects WHERE id=$1',[otherReceipt.result.created[0].id])).rows[0].state,'archived');
   assert.deepEqual((await s.knowledge.proposal(owner,otherDraft.id)).result.evidence,[otherSource]);
   await save({enabled:false,scopes:[other],project_ids:[otherReceipt.result.created[0].id],expires_at:'2000-01-01T00:00:00Z'},'disable-archived-expired');
   assert.equal(delegation.enabled,false,'revocation remains available even when a target was archived or the permission expired');
   assert.deepEqual(await permissions(),beforeAuthority);

   // Use the real saved-learning handoff, with both the input context and model result checkpoint.
   // A discovery is useful independently from the conversation's existing project assignment.
   knowledge.completed=completed;await save({scopes:[other],resume_scopes:[other]},'live-learning');
   const discoverySource=await capture(other),discovery={...proposal(discoverySource,'live-discovery',other),assignments:[]};
   const learnedId=digest(key+':discovery-meaning'),learningBinding=await s.guards.state(),learningDependencies=await knowledge.snapshot(owner,[discoverySource.id],learningBinding);
   const learnedValue:Interpretation={kind:'meaning',subject:'Synthetic project discovery',text:'The project was mentioned',scope:{kind:'conversation',id:other},uncertainty:'supported',evidence:[discoverySource],conflicts:[]};
   await s.learned.publishAutomatic(learnedId,learnedValue,null,key+':initial-discovery-meaning',learningDependencies.values,learningBinding,'fixture',s.detect);
   const discoveryJob=await savedLearning('discovery',discoverySource,discovery),savedLearningBinding=await s.guards.state();
   await s.learned.publishAutomatic(learnedId,{...learnedValue,text:'The project exists independently of this conversation'},1,key+':updated-discovery-meaning',learningDependencies.values,savedLearningBinding,'fixture',s.detect);
   const beforeDiscovery=await s.guards.state();assert.equal(beforeDiscovery.epoch,savedLearningBinding.epoch+1,'completed learning can advance the epoch without changing proposal evidence');
   assert.equal((await s.knowledge.process('learning:'+discoveryJob)).state,'applied');
   const afterDiscovery=await s.guards.state();assert.equal(afterDiscovery.epoch,beforeDiscovery.epoch+1);
   assert.equal((await s.projects.effective(other)).project,null,'discovery never assigns the source conversation just because it mentions a project');
   const discoveryRows=(await stores.control.query('SELECT id FROM projects WHERE name=$1',[discovery.creates[0]!.name])).rows;assert.equal(discoveryRows.length,1);
   assert.equal((await s.knowledge.process('learning:'+discoveryJob)).state,'applied');assert.deepEqual(await s.guards.state(),afterDiscovery);
   const later={...discovery,reason:'Later reprocessing',creates:discovery.creates.map(create=>({...create,name:key+':later-must-not-create'}))};
   const repeatedJob=await savedLearning('repeated',discoverySource,later);
   assert.equal((await s.knowledge.process('learning:'+repeatedJob)).state,'noop','later learning of an original cannot silently create fresh authority');
   assert.deepEqual(await s.guards.state(),afterDiscovery);
   assert.equal((await stores.control.query('SELECT 1 FROM projects WHERE name=$1',[later.creates[0]!.name])).rowCount,0);
   for(const [label,reference,space] of [['historical',otherSource,other],['imported',await capture(other,'import'),other],['undelegated',await capture(group),group]] as const){
    const disallowed={...proposal(reference,label+'-learning',space),assignments:[]},job=await savedLearning(label,reference,disallowed,space),beforeNoop=await s.guards.state();
    assert.equal((await s.knowledge.process('learning:'+job)).state,'noop');assert.deepEqual(await s.guards.state(),beforeNoop);
    assert.equal((await stores.control.query('SELECT 1 FROM projects WHERE name=$1',[disallowed.creates[0]!.name])).rowCount,0);
   }

   const staleSource=await capture(other),staleDiscovery={...proposal(staleSource,'guarded-stale',other),assignments:[]};
   const staleJob=await savedLearning('guarded-stale',staleSource,staleDiscovery),staleProposal=await knowledge.learning(staleJob);assert.ok(staleProposal);
   const prepared=await s.guards.read('events:'+staleSource.id,await s.guards.state()),edited=structuredClone(prepared.value) as any;
   edited.text='Owner corrected this evidence';
   await s.guards.edit('events:'+staleSource.id,prepared.revision,edited,key+':guard-correction');
   const staleOutcome=await s.knowledge.process('learning:'+staleJob);assert.equal(staleOutcome.state,'stale');assert.equal(staleOutcome.reason,'knowledge_dependencies_changed');
   assert.equal((await stores.control.query('SELECT 1 FROM projects WHERE name=$1',[staleDiscovery.creates[0]!.name])).rowCount,0);
   const staleSaved=await s.knowledge.proposal(owner,staleProposal),cancelStale={decision:'cancel',expected_revision:staleSaved.revision,operation_id:key+':cancel-stale'};
   const cancelledStale=await s.knowledge.decide(owner,staleProposal,cancelStale);assert.equal(cancelledStale.state,'cancelled');
   assert.deepEqual(await s.knowledge.decide(owner,staleProposal,cancelStale),cancelledStale,'decision replay retains the same prior outcome receipt');
   const staleHistory=await s.knowledge.proposal(owner,staleProposal),previous=staleHistory.decision_history.at(-1).result.previous;
   assert.equal(previous.state,'stale');assert.equal(previous.error_code,'knowledge_dependencies_changed');assert.equal(previous.revision,staleSaved.revision);
   assert.deepEqual(previous.result,staleSaved.result);assert.deepEqual(staleHistory.evidence,[staleSource]);assert.equal(staleHistory.error_code,'owner_cancel');
   for(const decision of ['reject','cancel'] as const){
    const rejectedSource=await capture(other),rejectedDiscovery={...proposal(rejectedSource,decision+'-learning',other),assignments:[]},job=await savedLearning(decision,rejectedSource,rejectedDiscovery);
    const proposalId=await knowledge.learning(job),saved=await s.knowledge.proposal(owner,proposalId);
    assert.equal((await s.knowledge.decide(owner,proposalId,{decision,expected_revision:saved.revision,operation_id:key+':'+decision+'-learning'})).state,'cancelled');
    assert.equal((await s.knowledge.process('learning:'+job)).state,'cancelled');
    const cancelled=await s.knowledge.proposal(owner,proposalId);assert.equal(cancelled.error_code,'owner_'+decision);assert.deepEqual(cancelled.evidence,[rejectedSource]);
    assert.equal((await stores.control.query('SELECT 1 FROM projects WHERE name=$1',[rejectedDiscovery.creates[0]!.name])).rowCount,0);
   }

   // Recover a reviewed owner command that committed before the worker could save its proposal receipt.
   const recoverySource=await capture(other),recoveryBinding=await s.guards.state(),recoveryId=digest(key+':review-recovery');
   const reviewed={kind:'project_save',reason:'Owner-reviewed project creation',payload:{name:key+':review-recovery',description:'Synthetic reviewed project',state:'active',expected_revision:0}};
   const recoverable=await knowledge.persist(recoveryId,reviewed,{origin:'turn',source:recoverySource,space:other,profile:'hermes',job:null,binding:recoveryBinding,
    dependencies:await knowledge.snapshot(owner,[recoverySource.id],recoveryBinding)});
   await s.knowledge.decide(owner,recoveryId,{decision:'approve',expected_revision:recoverable.revision,operation_id:key+':approve-recovery'});
   const commandReceipt=await s.projects.save(owner,{...reviewed.payload,operation_id:'knowledge-apply:'+recoveryId}),afterCommand=await s.guards.state();
   assert.equal((await s.knowledge.process('proposal:'+recoveryId)).state,'applied');assert.deepEqual(await s.guards.state(),afterCommand);
   const recovered=await s.knowledge.proposal(owner,recoveryId);assert.equal(recovered.result.receipt.id,commandReceipt.id);assert.equal(recovered.result.receipt.revision,1);
   assert.equal((await stores.control.query('SELECT revision FROM projects WHERE id=$1',[commandReceipt.id])).rows[0].revision,1,'recovery never repeats an already committed owner command');
   assert.deepEqual(await permissions(),beforeAuthority);
  } finally {knowledge.completed=completed;await stores.close();}
 });

import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {canonical,digest,type Envelope} from '../src/archive.js';
import {initializeStoreDatabases,connectStores} from '../src/stores/connections.js';
import {fixtureServices} from './fixture-brain.js';
import type {OrganizationProposal} from '../src/stores/knowledge-contract.js';
import type {SourceReference} from '../src/stores/archive.js';
import type {Interpretation} from '../src/interpretations.js';
import {honchoEngine} from '../src/memory/honcho.js';
import {KnowledgeManagementRepository,type KnowledgeManagementServices} from '../src/stores/knowledge-management.js';

test('delegated organization only creates projects; every move asks the owner, names the project\'s groups, and stays reversible',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config={host:process.env.PGHOST!,port:Number(process.env.PGPORT??5432),user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const admin=new pg.Pool(config);try{assert.equal((await admin.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await admin.end();}
  await initializeStoreDatabases(config,{archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')});
  const stores=connectStores(config,{archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')});
  const owner={admin:true,scope:null},key='organization:'+Date.now(),group='-'+Date.now(),other=String(Number(group)-1),topic=group+'/topic/99';let sequence=0;
  const s=fixtureServices(stores,{dataDir:'/tmp',detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[group,other]}),
   runtime:async operation=>{assert.equal(operation,'guard.detect');return {literals:[]};},memoryEngine:honchoEngine(async()=>{throw Error('no provider calls');})});
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
   delegation=await s.knowledge.saveDelegation(owner,{...(previous?{id:previous.id}:{}),name:'Synthetic organization',enabled:true,scopes:[group],project_ids:[],
    expires_at:null,expected_revision:previous?.revision??0,operation_id:key+':delegation:'+label,...changes});return delegation;
  };
  try {
   await s.guards.reconcile();await s.guards.setMode('on');
   // Organizing by itself only ever creates projects: every move of a group or topic into or out of a project waits for
   // the owner's review (ADR-0246). A delegation's create-only authority keeps its exact checks.
   const createOnly=(source:SourceReference,name:string):OrganizationProposal=>({...proposal(source,name),assignments:[]});
   const historical=await capture(),initial=createOnly(historical,'historical');
   assert.equal(await match(initial,historical),null,'existing installations have no inferred organization authority');
   await save({enabled:false},'disabled');assert.equal(await match(initial,historical),null);
   await save({},'enable');assert.equal(await match(initial,historical),null,'old capture sequences cannot acquire automatic authority');
   // Turning it on is what lets it create projects: the old separate switch is no longer a field (ADR-0246).
   assert.equal('allow_create' in delegation,false);
   await assert.rejects(save({allow_create:false},'old-switch'),{code:'unknown_knowledge_field'});
   const imported=await capture(group,'import');assert.equal(await match(createOnly(imported,'import'),imported),null);
   const source=await capture(),discovered=createOnly(source,'automatic');assert.equal((await match(discovered,source)).id,delegation.id);
   const outside=await capture(other);assert.equal(await match(createOnly(outside,'outside'),outside,other),null,'only in the chats it may organize');
   assert.equal(await match(discovered,source,group,'learning',{id:delegation.id,revision:delegation.revision+1}),null);
   const automatic=proposal(source,'moving');
   assert.equal(await match(automatic,source),null,'organizing never puts a group in a project by itself, even one it creates');
   const beforeAuthority=await permissions(),moving=await persist('moving',automatic,source);assert.equal(moving.state,'review');
   const pending=await persist('automatic',discovered,source);assert.equal(pending.state,'queued');
   const before=await s.guards.state();
   await stores.control.query("INSERT INTO dispatches(event_id,source_reference,binding,state) VALUES($1,$2,$3,'running')",[historical.id,historical,before]);
   const waiting=await s.knowledge.process('proposal:'+pending.id);assert.equal(waiting.state,'waiting');assert.equal(waiting.reason,'foreground_reply_active');
   assert.deepEqual(await s.guards.state(),before,'waiting for a foreground reply does not invalidate it');
   await stores.control.query("UPDATE dispatches SET state='done' WHERE event_id=$1",[historical.id]);
   assert.equal((await s.knowledge.process('proposal:'+moving.id)).state,'review','a move stays with the owner');
   assert.deepEqual(await s.guards.state(),before,'a move waiting for review changes nothing');
   const applied=await s.knowledge.process('proposal:'+pending.id);assert.equal(applied.state,'applied');
   const after=await s.guards.state();assert.equal(after.epoch,before.epoch+1,'a create produces one invalidation');
   const receipt=await s.knowledge.proposal(owner,pending.id),created=receipt.result.created[0];
   assert.deepEqual(receipt.result.assignments,[]);assert.equal(receipt.result.authorization.delegation_id,delegation.id);
   assert.deepEqual(receipt.result.evidence,[source]);assert.deepEqual(await permissions(),beforeAuthority);
   assert.equal((await s.projects.effective(group)).project,null,'a delegated create puts no chat in the project');
   const replay=await s.knowledge.process('proposal:'+pending.id);assert.equal(replay.state,'applied');assert.deepEqual(await s.guards.state(),after);
   // An owner-turn proposal waits for its reply to be confirmed before it applies.
   const turnCreate=await persist('turn-create',createOnly(source,'turn-create'),source);assert.equal(turnCreate.state,'queued');
   await stores.control.query("UPDATE knowledge_proposals SET origin='turn',source_job_id=NULL WHERE id=$1",[turnCreate.id]);
   await stores.control.query("INSERT INTO dispatches(event_id,source_reference,binding,state) VALUES($1,$2,$3,'running')",[source.id,source,await s.guards.state()]);
   knowledge.completed=completed;
   assert.equal((await s.knowledge.process('proposal:'+turnCreate.id)).state,'waiting','owner-turn proposals wait for confirmed reply completion');
   await stores.control.query("UPDATE dispatches SET state='suppressed',error_code='unsupported_message' WHERE event_id=$1",[source.id]);
   assert.equal(await completed({origin:'turn',source_reference:source}),'cancelled','ordinary suppression is not a successful turn');
   await stores.control.query("UPDATE dispatches SET error_code='intentional_silence' WHERE event_id=$1",[source.id]);
   assert.equal(await completed({origin:'turn',source_reference:source}),'ready','intentional conversational silence is a confirmed completed turn');
   await stores.control.query("UPDATE dispatches SET state='done',error_code=NULL WHERE event_id=$1",[source.id]);
   assert.equal((await s.knowledge.process('proposal:'+turnCreate.id)).state,'applied');
   knowledge.completed=async()=> 'ready';
   // An owner change to a chat suspends automatic organizing there until the owner resumes it.
   await s.projects.assign(owner,{space_id:group,project_id:null,mode:'none',expected_revision:0,operation_id:key+':owner-correction'});
   const corrected=await capture();assert.equal(await match(createOnly(corrected,'suspended-discovery'),corrected),null,'suspension prevents automatic create-only organization');
   assert.ok((await s.knowledge.delegations(owner)).delegations.find(d=>d.id===delegation.id)!.suspended_scopes.includes(group));
   await save({name:'Renamed permission'},'rename');assert.equal(delegation.baselines[group],0,'ordinary permission edits do not resume a suspended scope');
   await save({resume_scopes:[group]},'resume');assert.equal(delegation.baselines[group],1);
   const recent=await capture(),resumed=createOnly(recent,'resumed');assert.equal((await match(resumed,recent)).id,delegation.id);
   // A topic always follows its group's project, so not even the owner gives it one of its own.
   await assert.rejects(s.projects.assign(owner,{space_id:topic,project_id:null,mode:'none',expected_revision:0,operation_id:key+':topic-exclusion'}),{code:'project_topic_follows_group'});
   await stores.control.query("UPDATE organization_delegations SET expires_at=now()-interval '1 second' WHERE id=$1",[delegation.id]);assert.equal(await match(resumed,recent),null,'expired authority is not used');
   await save({enabled:false},'revoke');assert.equal(await match(resumed,recent),null);

   // A reviewed inconsistent batch rolls back its project creation when an assignment conflicts.
   const broken=proposal(recent,'must-rollback',group,999),draft=await persist('broken',broken,recent);assert.equal(draft.state,'review');
   await s.knowledge.decide(owner,draft.id,{decision:'approve',expected_revision:draft.revision,operation_id:key+':approve-broken'});
   const failed=await s.knowledge.process('proposal:'+draft.id);assert.equal(failed.state,'stale');
   assert.equal((await stores.control.query('SELECT 1 FROM projects WHERE name=$1',[broken.creates[0]!.name])).rowCount,0);
   assert.equal((await s.projects.effective(group)).own_assignment?.revision,1);

   // An owner change to a group also suspends a delegated topic that follows it.
   const inheritedTopic=group+'/topic/100';delegation=null;
   await save({scopes:[inheritedTopic],project_ids:[created.id]},'inherited-topic');
   const topicSource=await capture(group,'live',{message_thread_id:100,is_topic_message:true});
   assert.equal((await match(createOnly(topicSource,'topic-discovery'),topicSource,inheritedTopic)).id,delegation.id);
   await s.projects.assign(owner,{space_id:group,project_id:created.id,mode:'assigned',expected_revision:1,operation_id:key+':parent-owner-edit'});
   assert.equal((await s.projects.effective(inheritedTopic)).project?.id,created.id,'the topic follows its group into the project');
   assert.equal(await match(createOnly(topicSource,'topic-discovery'),topicSource,inheritedTopic),null,'an owner edit to the group suspends a topic that follows it');
   assert.ok((await s.knowledge.delegations(owner)).delegations.find(d=>d.id===delegation.id)!.suspended_scopes.includes(inheritedTopic));
   await save({scopes:[inheritedTopic],project_ids:[created.id],resume_scopes:[inheritedTopic]},'resume-inherited');
   const resumedTopicSource=await capture(group,'live',{message_thread_id:100,is_topic_message:true});
   assert.equal((await match(createOnly(resumedTopicSource,'topic-resumed'),resumedTopicSource,inheritedTopic)).id,delegation.id);

   // Every move asks the owner, whatever the project: one without tasks or groups, or one with groups in it. The review
   // names the groups already in the project, for a move in and a move out (ADR-0246).
   const plain=await s.projects.save(owner,{name:key+':plain',description:'',state:'active',expected_revision:0,operation_id:key+':plain-project'});
   await save({scopes:[inheritedTopic,other],project_ids:[created.id,plain.id]},'moves');
   const moveSource=await capture(other);
   const moveTo=(project:string):OrganizationProposal=>({kind:'organization',reason:'Synthetic move',creates:[],
    assignments:[{space_id:other,project_id:project,expected_revision:0,evidence_ids:[moveSource.id],reason:'Explicit purpose evidence',purpose_evidence:true}]});
   assert.equal(await match(moveTo(plain.id),moveSource,other),null,'not into a project without tasks or groups');
   assert.equal(await match(moveTo(created.id),moveSource,other),null,'nor into one with groups');
   const join=await persist('join',moveTo(created.id),moveSource,other);assert.equal(join.state,'review');
   const joinView=await s.knowledge.proposal(owner,join.id);
   assert.deepEqual(joinView.project_groups,[{id:created.id,name:created.name,groups:[group]}],'the review names the groups already in the project');
   assert.deepEqual(joinView.task_projects,[]);assert.equal(joinView.sharing_projects,undefined);
   // A project the proposal creates and puts a group in is named too, with no group in it yet.
   const together=await persist('create-together',proposal(moveSource,'together',other),moveSource,other);assert.equal(together.state,'review');
   assert.deepEqual((await s.knowledge.proposal(owner,together.id)).project_groups,[{id:'new:project',name:key+':together',groups:[]}],'a project the proposal creates is named');
   assert.deepEqual((await s.knowledge.proposal(owner,(await persist('create-only',createOnly(moveSource,'alone'),moveSource,other)).id)).project_groups,[],
    'one it only creates moves no group');
   const leave=await persist('leave',{kind:'project_assignment',reason:'Synthetic: the group left the project',payload:{space_id:group,mode:'none',expected_revision:2}} as any,moveSource,other);
   assert.equal(leave.state,'review');
   assert.deepEqual((await s.knowledge.proposal(owner,leave.id)).project_groups,[{id:created.id,name:created.name,groups:[]}],'leaving names the project too');
   assert.deepEqual((await s.knowledge.proposal(owner,leave.id)).task_projects,[]);
   // A group joining a project sees the tasks set on the whole project, never another group's own (ADR-0247).
   const groupTask=await s.tasks.create(owner,{operation_id:key+':group-task',title:'Synthetic group task',scope:created.id});
   await stores.control.query('UPDATE owner_tasks SET group_id=$2 WHERE id=$1',[groupTask.id,group]);
   assert.deepEqual((await s.knowledge.proposal(owner,join.id)).task_projects,[],'another group\'s own task is not on the joining group\'s board');
   const projectTask=await s.tasks.create(owner,{operation_id:key+':project-task',title:'Synthetic project task',scope:created.id});
   assert.deepEqual((await s.knowledge.proposal(owner,join.id)).task_projects,[{id:created.id,name:created.name}]);
   for(const task of [groupTask,projectTask]){const gone=await s.tasks.update(owner,task.id,{operation_id:key+':trash:'+task.id,expected_revision:task.revision,trashed:true});await s.tasks.remove(owner,gone.id);}
   // The moving group's own tasks on the project it is about to join: a task with a comment, one under it, and its topic's.
   const top=await s.tasks.create(owner,{operation_id:key+':moving-top',title:'Synthetic moving task',scope:created.id,group:other});
   const under=await s.tasks.create(owner,{operation_id:key+':moving-under',title:'Synthetic task under it',parent:top.id});
   const topical=await s.tasks.create(owner,{operation_id:key+':moving-topic',title:'Synthetic topic task',scope:created.id,group:other+'/topic/5'});
   await s.tasks.comment(owner,top.id,{operation_id:key+':moving-comment',text:'Synthetic comment'});
   const family=[top.id,under.id,topical.id];
   const board=async()=>(await stores.control.query('SELECT id,project_id,group_id,project_since::text FROM owner_tasks WHERE id=ANY($1::text[]) ORDER BY id',[family])).rows;
   const placed=await board();
   assert.deepEqual(placed.map(row=>[row.project_id,row.group_id]),placed.map(row=>[created.id,row.id===topical.id?other+'/topic/5':other]),'a subtask has its parent\'s group');
   const movedTo=async(project:string,why:string)=>{
    const rows=await board();
    assert.deepEqual(rows.map(row=>row.project_id),rows.map(()=>project),why);
    assert.deepEqual(rows.map(row=>[row.id,row.group_id,row.project_since]),placed.map(row=>[row.id,row.group_id,row.project_since]),'each keeps its group and project_since');
    assert.deepEqual((await s.tasks.get(owner,top.id)).comments.map((item:any)=>item.body),['Synthetic comment'],'and its comments');
   };
   // The owner approves the move: it applies under the owner's review, and undoing it names the project's groups too.
   await s.knowledge.decide(owner,join.id,{decision:'approve',expected_revision:joinView.revision,operation_id:key+':approve-join'});
   assert.equal((await s.knowledge.process('proposal:'+join.id)).state,'applied');
   const joinReceipt=await s.knowledge.proposal(owner,join.id);assert.deepEqual(joinReceipt.result.authorization,{owner_review:true});
   assert.equal((await s.projects.effective(other)).project?.id,created.id);
   assert.deepEqual(joinReceipt.undo_project_groups,[{id:created.id,name:created.name,groups:[group]}]);
   const moved=(await s.projects.effective(other)).own_assignment!;
   await s.projects.assign(owner,{space_id:other,mode:'assigned',project_id:plain.id,expected_revision:moved.revision,operation_id:key+':owner-moves-on'});
   await movedTo(plain.id,'a group moving from one project to another takes its tasks, its topics\' and the ones under them (ADR-0247)');
   await assert.rejects(s.knowledge.undo(owner,join.id,{expected_revision:joinReceipt.revision,operation_id:key+':undo-conflict'}),{code:'knowledge_undo_conflict'});
   assert.equal((await s.knowledge.proposal(owner,join.id)).state,'applied','conflicting undo preserves original receipt');
   await s.projects.assign(owner,{space_id:other,mode:'inherit',expected_revision:moved.revision+1,operation_id:key+':owner-moves-back'});
   await movedTo(plain.id,'leaving every project leaves its tasks on the old board');
   // Joining another project from none takes nothing off the old board: the tasks stay where only the owner sees them.
   await s.projects.assign(owner,{space_id:other,mode:'assigned',project_id:created.id,expected_revision:moved.revision+2,operation_id:key+':owner-joins-other'});
   await movedTo(plain.id,'joining from no project moves nothing');
   // Undoing an organization that moved the group between two projects moves its tasks back.
   await s.projects.assign(owner,{space_id:other,mode:'assigned',project_id:plain.id,expected_revision:moved.revision+3,operation_id:key+':owner-moves-again'});
   await movedTo(plain.id,'its tasks on the project it leaves, none here, are all that move');
   const across=await persist('across',{kind:'organization',reason:'Synthetic move across projects',creates:[],
    assignments:[{space_id:other,project_id:created.id,expected_revision:moved.revision+4,evidence_ids:[moveSource.id],reason:'Explicit purpose evidence',purpose_evidence:true}]},moveSource,other);
   assert.equal(across.state,'review');
   await s.knowledge.decide(owner,across.id,{decision:'approve',expected_revision:(await s.knowledge.proposal(owner,across.id)).revision,operation_id:key+':approve-across'});
   assert.equal((await s.knowledge.process('proposal:'+across.id)).state,'applied');
   await movedTo(created.id,'an applied organization moves the group\'s tasks with it');
   const acrossReceipt=await s.knowledge.proposal(owner,across.id);
   assert.equal((await s.knowledge.undo(owner,across.id,{expected_revision:acrossReceipt.revision,operation_id:key+':undo-across'})).state,'undone');
   assert.equal((await s.projects.effective(other)).project?.id,plain.id);
   await movedTo(plain.id,'undoing it moves them back');
   const back=(await s.projects.effective(other)).own_assignment!;
   await s.projects.assign(owner,{space_id:other,mode:'inherit',expected_revision:back.revision,operation_id:key+':owner-leaves-again'});
   for(const id of [topical.id,under.id,top.id]){const task=await s.tasks.get(owner,id);const gone=await s.tasks.update(owner,id,{operation_id:key+':trash:'+id,expected_revision:task.revision,trashed:true});await s.tasks.remove(owner,gone.id);}

   // An owner-approved organization applies, and a clean undo restores the prior assignment and archives, rather than
   // erases, the created project.
   await save({enabled:false},'moves-revoked');delegation=null;await save({scopes:[other]},'other');
   const otherSource=await capture(other),otherExpected=(await s.projects.effective(other)).own_assignment?.revision??0;
   const otherDraft=await persist('other',proposal(otherSource,'other',other,otherExpected),otherSource,other);
   assert.equal(otherDraft.state,'review','a delegation never moves a group, even into a project it would create');
   assert.equal((await s.knowledge.process('proposal:'+otherDraft.id)).state,'review');
   const otherReview=await s.knowledge.proposal(owner,otherDraft.id);
   await s.knowledge.decide(owner,otherDraft.id,{decision:'approve',expected_revision:otherReview.revision,operation_id:key+':approve-other'});
   assert.equal((await s.knowledge.process('proposal:'+otherDraft.id)).state,'applied');
   const otherReceipt=await s.knowledge.proposal(owner,otherDraft.id);
   assert.equal((await s.projects.effective(other)).project?.id,otherReceipt.result.created[0].id);
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

   // Organizing puts chats in projects, so a private chat, the owner's included, is never one it may organize.
   for(const scope of ['123','123/topic/5','desktop:personal_chat:9'])
    await assert.rejects(s.knowledge.saveDelegation(owner,{name:'Private organization',enabled:true,scopes:[group,scope],project_ids:[],
     expires_at:null,expected_revision:0,operation_id:key+':private-delegation:'+scope}),{code:'organization_private_chat'},scope);
   // One saved earlier over a private chat never acts on it, and can be turned off as it is, but not turned on again.
   const olderDelegation=await s.knowledge.saveDelegation(owner,{name:'Older organization',enabled:true,scopes:[other],project_ids:[],
    expires_at:null,expected_revision:0,operation_id:key+':older-delegation'});
   await stores.control.query(`UPDATE organization_delegations SET scopes=jsonb_build_array('123',$2::text),baselines=baselines||'{"123":0}'::jsonb WHERE id=$1`,[olderDelegation.id,other]);
   const privateOrganization=await capture('123');
   assert.equal(await match({kind:'organization',reason:'Synthetic',creates:[{key:'p',name:key+':private-project',description:'',evidence_ids:[privateOrganization.id]}],assignments:[]},
    privateOrganization,'123'),null,'an older delegation never organizes from a private chat');
   const olderBody={id:olderDelegation.id,name:'Older organization',scopes:['123',other],project_ids:[],expires_at:null,expected_revision:olderDelegation.revision};
   assert.equal((await s.knowledge.saveDelegation(owner,{...olderBody,enabled:false,operation_id:key+':older-delegation-off'})).enabled,false);
   await assert.rejects(s.knowledge.saveDelegation(owner,{...olderBody,enabled:true,expected_revision:olderDelegation.revision+1,operation_id:key+':older-delegation-on'}),{code:'organization_private_chat'});
   await assert.rejects(s.knowledge.saveDelegation(owner,{...olderBody,enabled:false,scopes:['123','124',other],expected_revision:olderDelegation.revision+1,operation_id:key+':older-delegation-more'}),{code:'organization_private_chat'});
   await s.knowledge.saveDelegation(owner,{...olderBody,enabled:false,scopes:[other],expected_revision:olderDelegation.revision+1,operation_id:key+':older-delegation-fixed'});

   // A card that shares a fact from the owner's private chat names that chat, and applies once the owner approves it.
   knowledge.completed=async()=> 'ready';
   const privateSource=await capture('123'),factProject=await s.projects.save(owner,{name:key+':fact-project',description:'',state:'active',expected_revision:0,operation_id:key+':fact-project'});
   const entity=await s.entities.ensureProject(factProject),factBinding=await s.guards.state();
   const fact=await s.entities.publishClaim({subject_id:entity.id,predicate:'checkpoint',content:'Synthetic checkpoint is complete.',attribution:'reported',uncertainty:'supported',evidence:[privateSource]},factBinding,key+':private-fact');
   const grantBinding=await s.guards.state(),grantId=digest(key+':private-grant');
   const grantCard=await knowledge.persist(grantId,{kind:'fact_grant',reason:'Synthetic: the group asked about the checkpoint',
    payload:{fact_id:fact.id,fact_revision:fact.revision,destination:group,wording:'The checkpoint is complete.'}},
    {origin:'turn',source:privateSource,space:'123',profile:'hermes',job:null,binding:grantBinding,dependencies:await knowledge.snapshot(owner,[privateSource.id],grantBinding)});
   // When where it came from cannot be worked out, as in a passing outage, the card says so instead of showing no source.
   (s.entities as any).audience=async()=>{throw new Error('synthetic outage');};
   try{const blind=await s.knowledge.proposal(owner,grantId);assert.deepEqual([blind.fact_audience,blind.fact_audience_error],[null,'audience_unavailable']);}
   finally{delete (s.entities as any).audience;}
   const card=await s.knowledge.proposal(owner,grantId);assert.equal(card.fact_audience_error,undefined);
   assert.deepEqual([card.fact_audience.private_sources,card.fact_audience.owner_private,card.fact_audience.readers],[['123'],true,null],'the card says it came from your private chat');
   await assert.rejects(s.memoryAccess.grant(owner,{fact_id:fact.id,fact_revision:fact.revision,destination:group,operation_id:key+':unconfirmed'}),{code:'memory_grant_private_sources'});
   await s.knowledge.decide(owner,grantId,{decision:'approve',expected_revision:grantCard.revision,operation_id:key+':approve-private-grant'});
   assert.equal((await s.knowledge.process('proposal:'+grantId)).state,'applied');
   assert.equal((await stores.control.query("SELECT count(*)::int AS n FROM memory_fact_grants WHERE fact_id=$1 AND destination=$2 AND state='active'",[fact.id,group])).rows[0].n,1);

   // A proposal saved before private chats were refused still lists and opens, marked, and the owner can cancel it; it never applies.
   const older=async(label:string,value:any)=>{const binding=await s.guards.state(),id=digest(key+':older:'+label);
    await knowledge.persist(id,value,{origin:'turn',source:privateSource,space:'123',profile:'hermes',job:null,binding,dependencies:await knowledge.snapshot(owner,[privateSource.id],binding)});return id;};
   const assignOwner=await older('assign',{kind:'project_assignment',reason:'Synthetic: put my chat in the project',payload:{space_id:'123',project_id:factProject.id,mode:'assigned',expected_revision:0}});
   const shareOwner=await older('rule',{kind:'sharing_rule',reason:'Synthetic: share my chat',payload:{name:'Synthetic older rule',sources:['123',other],destination:group,enabled:true,mode:'approved',instructions:'',expected_revision:0}});
   const listed=(await s.knowledge.proposals(owner)).proposals.filter((row:any)=>[assignOwner,shareOwner].includes(row.id));
   assert.deepEqual(listed.map((row:any)=>row.private_chats).sort(),[['123'],['123']],'one older proposal never breaks the whole list');
   assert.deepEqual((await s.knowledge.proposal(owner,assignOwner)).private_chats,['123']);
   assert.deepEqual(((await s.supervision.decision(owner,'knowledge',assignOwner)).detail as any).private_chats,['123'],'its card still opens');
   const assignCard=await s.knowledge.proposal(owner,assignOwner);
   await assert.rejects(s.knowledge.decide(owner,assignOwner,{decision:'approve',expected_revision:assignCard.revision,operation_id:key+':approve-older'}),{code:'project_private_chat'});
   assert.equal((await s.knowledge.decide(owner,assignOwner,{decision:'reject',expected_revision:assignCard.revision,operation_id:key+':reject-older'})).state,'cancelled');
   await stores.control.query('UPDATE knowledge_proposals SET approved=true,state=$2 WHERE id=$1',[shareOwner,'queued']);
   assert.deepEqual(await s.knowledge.process('proposal:'+shareOwner),{state:'failed',revision:2,reason:'sharing_private_chat'},'applying re-checks it as new');
   assert.equal((await stores.control.query('SELECT count(*)::int AS n FROM sharing_rules WHERE name=$1',['Synthetic older rule'])).rows[0].n,0);
   knowledge.completed=completed;
  } finally {knowledge.completed=completed;await stores.close();}
 });

test('starting up drops a delegation\'s old project-creation switch and keeps the delegation itself',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config={host:process.env.PGHOST!,port:Number(process.env.PGPORT??5432),user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),owner={admin:true,scope:null},key='old-create-switch:'+Date.now(),id=digest(key),group='-'+Date.now()+'7';
  const knowledge=new KnowledgeManagementRepository({stores} as unknown as KnowledgeManagementServices);
  const column=async()=>Number((await stores.control.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=current_schema()
    AND table_name='organization_delegations' AND column_name='allow_create'`)).rows[0].n);
  try {
    // A delegation saved while the switch existed, with it off.
    const schemaOwner=new pg.Client({...config,database:'nocheh_control'});await schemaOwner.connect();
    try{await schemaOwner.query('SET ROLE nocheh_control_owner;ALTER TABLE organization_delegations ADD COLUMN IF NOT EXISTS allow_create boolean NOT NULL DEFAULT false');}
    finally{await schemaOwner.end();}
    await stores.control.query(`INSERT INTO organization_delegations(id,name,enabled,scopes,project_ids,allow_create,expires_at,capture_watermark,baselines,revision)
      VALUES($1,'Older organization',true,$2,'[]',false,NULL,0,$3,1)`,[id,JSON.stringify([group]),JSON.stringify({[group]:0})]);
    await initializeStoreDatabases(config,passwords);
    assert.equal(await column(),0,'the switch\'s column is gone');
    const listed=(await knowledge.delegations(owner)).delegations.find(row=>row.id===id)!;
    assert.deepEqual([listed.name,listed.enabled,listed.scopes,'allow_create' in listed],['Older organization',true,[group],false],'the delegation keeps everything else');
    const saved=await knowledge.saveDelegation(owner,{id,name:'Older organization',enabled:false,scopes:[group],project_ids:[],expires_at:null,expected_revision:1,operation_id:key+':off'});
    assert.deepEqual([saved.enabled,saved.revision],[false,2],'and can still be turned off');
  } finally {await stores.close();}
});

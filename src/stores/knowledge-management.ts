import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {parentSpace,validateSpace} from '../spaces.js';
import {requestWorkflow} from '../workflows/store.js';
import type {StorePools} from './connections.js';
import type {SourceReference} from './archive.js';
import type {SourceAccessRepository} from './access.js';
import type {DerivedRepository,DerivativeReference} from './derived.js';
import type {GuardRepository,GuardBinding} from './guards.js';
import type {PreparedContextRepository} from './prepared-context.js';
import type {RuntimeTurnRepository} from './turns.js';
import type {LearnedMemoryRepository,PreparedDependency} from './learned.js';
import type {EntityRepository} from './entities.js';
import type {MemoryAccessRepository} from './memory-access.js';
import type {SelectionRepository} from './selections.js';
import {selectionId} from './selections.js';
import type {SharingContentRepository} from './sharing.js';
import {ProjectRepository,SharingPolicyRepository,writeProject,writeAssignment,type Assignment} from './projects.js';
import {foregroundReplyActive} from './automatic-publication.js';
import {knowledgeId as id,knowledgeRevision as revision,knowledgeObject as exact,parseKnowledgeProposal,organizationIdentity,
 type KnowledgeProposal,type OrganizationProposal,type ReviewProposal} from './knowledge-contract.js';

const protocol='knowledge-management-v1';
const owner:Reader={admin:true,scope:null};
const activeStates=['queued','waiting'];
export interface KnowledgeManagementServices {
 stores:StorePools;access:SourceAccessRepository;derived:DerivedRepository;guards:GuardRepository;prepared:PreparedContextRepository;
 turns:RuntimeTurnRepository;learned:LearnedMemoryRepository;projects:ProjectRepository;entities:EntityRepository;
 sharing:SharingPolicyRepository;shared:SharingContentRepository;memoryAccess:MemoryAccessRepository;selections:SelectionRepository;
 detect:(text:string)=>Promise<unknown>;
}
export type OrganizationDelegation={id:string;name:string;enabled:boolean;scopes:string[];project_ids:string[];allow_create:boolean;expires_at:Date|null;
 capture_watermark:string;baselines:Record<string,number>;revision:number};
type Dependencies={sources:SourceReference[];values:PreparedDependency[];owner_rules:{id:string;revision:number;kind:string}[];proposal_revision:number|null;proposal_hash:string;projects?:{id:string;revision:number}[];topics?:Record<string,string[]>};
type ProposalRow={id:string;request_hash:string;kind:string;origin:'turn'|'learning';source_reference:SourceReference;source_scope:string;logical_profile:string|null;
 source_job_id:string|null;proposal_reference:DerivativeReference;binding:GuardBinding;dependencies:Dependencies;delegation_id:string|null;delegation_revision:number|null;
 state:string;revision:number;approved:boolean;result:any;error_code:string|null};

/** The runtime proposes typed changes. Only this trusted boundary evaluates and applies authority. */
export class KnowledgeManagementRepository {
 readonly stores:StorePools;
 constructor(readonly s:KnowledgeManagementServices){this.stores=s.stores;}

 async delegations(principal:Reader,after='') {
  admin(principal);if(after)id(after);
  const rows=(await this.stores.control.query('SELECT * FROM organization_delegations WHERE id>$1 ORDER BY id LIMIT 101',[after])).rows;
  const assignments=(await this.stores.control.query('SELECT space_id,revision,mode FROM project_assignments')).rows;
  const current=new Map(assignments.map(a=>[a.space_id,a.revision]));
  return {delegations:rows.slice(0,100).map(d=>({...d,suspended_scopes:d.scopes.filter((scope:string)=>(current.get(scope)??0)!==d.baselines[scope]||
   d.baselines['parent:'+scope]!==undefined&&(current.get(parentSpace(scope)!)??0)!==d.baselines['parent:'+scope]),
   expired:!!d.expires_at&&d.expires_at<=new Date()})),next:rows.length>100?rows[99].id:null};
 }

 async saveDelegation(principal:Reader,input:unknown) {
  admin(principal);const b=exact(input,['id','name','enabled','scopes','project_ids','allow_create','expires_at','expected_revision','operation_id','resume_scopes']);
  const operation=string(b.operation_id,200),identity=b.id===undefined?digest('organization-delegation:'+operation):id(b.id),expected=revision(b.expected_revision);
  if(!operation.trim()||typeof b.enabled!=='boolean'||typeof b.allow_create!=='boolean'||!Array.isArray(b.scopes)||!b.scopes.length||b.scopes.length>100||!Array.isArray(b.project_ids)||b.project_ids.length>100)throw new HttpError(400,'invalid_organization_delegation');
  const scopes=[...new Set<string>(b.scopes.map(validateSpace))].sort(),projects=[...new Set<string>(b.project_ids.map(id))].sort(),name=string(b.name,200).trim();
  const expires=b.expires_at==null||b.expires_at===''?null:new Date(string(b.expires_at,100));
  if(!name||expires&&(!Number.isFinite(expires.getTime())||b.enabled&&expires<=new Date()))throw new HttpError(400,'invalid_organization_delegation');
  const hash=digest(canonical({...b,id:identity})),db=await this.stores.control.connect();
  try{await db.query('BEGIN');await db.query('SELECT epoch FROM guard_state WHERE singleton FOR UPDATE');
   const replay=(await db.query('SELECT request_hash,record FROM organization_delegation_history WHERE operation_id=$1',[operation])).rows[0];
   if(replay){if(replay.request_hash!==hash)throw new HttpError(409,'organization_command_conflict');await db.query('COMMIT');return replay.record;}
   const prior=(await db.query('SELECT * FROM organization_delegations WHERE id=$1 FOR UPDATE',[identity])).rows[0];
   if((prior?.revision??0)!==expected)throw new HttpError(409,'organization_delegation_changed');
   if(b.enabled&&(await db.query("SELECT id FROM projects WHERE id=ANY($1::text[]) AND state='active'",[projects])).rowCount!==projects.length)throw new HttpError(400,'active_project_required');
   // Sequence allocation is conservative even when capture commits out of order.
   const watermark=String((await this.stores.archive.query('SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS watermark FROM events_capture_sequence_seq')).rows[0].watermark);
   const rows=(await db.query('SELECT space_id,revision,mode FROM project_assignments WHERE space_id=ANY($1::text[])',[[...scopes,...scopes.map(parentSpace).filter(Boolean)]])).rows;
   if(b.resume_scopes!==undefined&&(!Array.isArray(b.resume_scopes)||b.resume_scopes.some((s:unknown)=>!scopes.includes(String(s)))))throw new HttpError(400,'invalid_resume_scopes');
   const baselines=Object.fromEntries(scopes.map(scope=>[scope,prior?.scopes.includes(scope)&&!b.resume_scopes?.includes(scope)?prior.baselines[scope]:rows.find(r=>r.space_id===scope)?.revision??0]));
   for(const scope of scopes){const parent=parentSpace(scope),own=rows.find(r=>r.space_id===scope);
    if(parent&&(!own||own.mode==='inherit'))baselines['parent:'+scope]=prior?.scopes.includes(scope)&&!b.resume_scopes?.includes(scope)&&prior.baselines['parent:'+scope]!==undefined?
     prior.baselines['parent:'+scope]:rows.find(r=>r.space_id===parent)?.revision??0;
   }
   const saved=(await db.query(`INSERT INTO organization_delegations(id,name,enabled,scopes,project_ids,allow_create,expires_at,capture_watermark,baselines,revision)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET name=$2,enabled=$3,scopes=$4,project_ids=$5,allow_create=$6,
    expires_at=$7,capture_watermark=$8,baselines=$9,revision=$10,updated_at=now() RETURNING *`,
    [identity,name,b.enabled,JSON.stringify(scopes),JSON.stringify(projects),b.allow_create,expires,watermark,JSON.stringify(baselines),expected+1])).rows[0];
   await db.query('INSERT INTO organization_delegation_history(operation_id,delegation_id,request_hash,record) VALUES($1,$2,$3,$4)',[operation,identity,hash,saved]);
   await db.query(`UPDATE knowledge_proposals SET state='review',error_code='organization_delegation_changed',revision=revision+1,updated_at=now()
    WHERE delegation_id=$1 AND state IN ('queued','waiting') AND NOT approved`,[identity]);
   await db.query('COMMIT');return saved;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }

 /** A current live owner-private turn; never a group, job, review or admin caller. */
 async ownerTurn(principal:Reader) {
  if(principal.admin||principal.scope!==null||(principal.purpose??'assistant')!=='assistant')throw new HttpError(403,'owner_private_turn_required');
  const turn=await this.s.turns.binding(principal);
  if(!turn.owner||turn.job||turn.reference?.store!=='archive')throw new HttpError(403,'owner_private_turn_required');
  const source=await this.s.access.archive.verify(turn.reference);
  const intake=(await this.stores.control.query('SELECT transport,state FROM source_intakes WHERE event_id=$1',[source.reference.id])).rows[0];
  if(source.origin!=='live'||!['telegram_update','browser_input'].includes(source.kind)||intake?.transport!=='capture'||intake?.state!=='ready'||
   turn.scope!==this.s.access.policy().owner_id)throw new HttpError(403,'owner_private_turn_required');
  return {turn,source,binding:await this.s.guards.state()};
 }

 async inspect(principal:Reader,input:unknown={}) {
  if(!principal.admin)await this.ownerTurn(principal);
  const b=exact(input,['space','q','after','entity_id','fact_id','entities_after','delegations_after','sharing_after','grants_after','claims_after']);
  const cursor=(key:string)=>b[key]===undefined||b[key]===''?'':id(b[key]);
  const space=b.space===undefined?null:validateSpace(b.space),query=string(b.q??'',200),binding=await this.s.guards.state();
  if(b.entity_id!==undefined&&b.fact_id!==undefined)throw new HttpError(400,'knowledge_inspection_target_conflict');
  const available=async(row:any)=>{
   for(const source of row.evidence as SourceReference[])if(!await this.s.access.canRead(principal,source,binding))return false;
   return true;
  };
  const prepared=async(result:Record<string,unknown>)=>{
   if(principal.admin)return result;
   // Owner access and provider guarding are separate. Never mark raw names,
   // claims, rule wording, or descriptions as preapproved provider content.
   const value=await this.s.prepared.prepare(principal,result,this.s.detect);
   await this.s.turns.assertAudience(principal);return value as Record<string,unknown>;
  };
  if(b.fact_id!==undefined){
   const factId=id(b.fact_id),fact=(await this.stores.derived.query(`SELECT e.id,e.subject_entity_id,e.predicate,e.object_entity_id,
    v.revision,v.content,v.relationship_kind,v.attribution,v.uncertainty,v.evidence FROM entity_claims e
    JOIN entity_claim_versions v ON v.claim_id=e.id AND v.revision=e.active_revision WHERE e.id=$1 AND NOT v.retired`,[factId])).rows[0];
   if(!fact||!await available(fact))throw new HttpError(404,'memory_fact_not_found');
   const grants=(await this.stores.control.query(`SELECT id,destination,fact_id,fact_revision,revision,mode,state,expires_at,guard_revision,text_hash,binding,representation_reference
    FROM memory_fact_grants WHERE fact_id=$1 AND id>$2 ORDER BY id LIMIT 11`,[factId,cursor('grants_after')])).rows;
   const inspected=[];
   for(const {binding:grantBinding,representation_reference,...grant} of grants.slice(0,10)){
    let effective_state=grant.state;
    if(grant.state==='active'){
     if(grant.expires_at&&grant.expires_at<=new Date())effective_state='expired';
     else if(grant.fact_revision!==fact.revision||canonical(grantBinding)!==canonical(binding))effective_state='suspended';
     else try{const representation=await this.s.guards.read('derived_artifacts:'+representation_reference.id,binding);
      if(representation.revision!==grant.guard_revision||digest(String((representation.value as any).text??''))!==grant.text_hash)effective_state='suspended';
     }catch{effective_state='unavailable';}
    }
    inspected.push({...grant,effective_state});
   }
   return prepared({fact,grants:inspected,grants_next:grants.length>10?grants[9].id:null});
  }
  if(b.entity_id!==undefined){
   const entityId=id(b.entity_id),entity=(await this.stores.control.query('SELECT id,kind,name,state,project_id,merged_into,revision FROM memory_entities WHERE id=$1',[entityId])).rows[0];
   if(!entity)throw new HttpError(404,'entity_not_found');
   const rows=(await this.stores.derived.query(`SELECT e.id,e.subject_entity_id,e.predicate,e.object_entity_id,
    v.revision,v.content,v.relationship_kind,v.attribution,v.uncertainty,v.evidence FROM entity_claims e
    JOIN entity_claim_versions v ON v.claim_id=e.id AND v.revision=e.active_revision
    WHERE (e.subject_entity_id=$1 OR e.object_entity_id=$1) AND e.id>$2 AND NOT v.retired ORDER BY e.id LIMIT 6`,[entityId,cursor('claims_after')])).rows;
   const claims=[];for(const claim of rows.slice(0,5))if(await available(claim))claims.push(claim);
   return prepared({entity,claims,claims_next:rows.length>5?rows[4].id:null,partial:rows.length>5});
  }
  const projects=(await this.stores.control.query(`SELECT * FROM projects WHERE id>$1 AND ($2='' OR name ILIKE '%'||$2||'%') ORDER BY id LIMIT 11`,[cursor('after'),query])).rows;
  const entityPage=await this.s.entities.list(principal,{query,after:cursor('entities_after')});
  const delegationPage=await this.delegations(owner,cursor('delegations_after'));
  const rules=space?(await this.stores.control.query(`SELECT * FROM sharing_rules WHERE destination=$1 AND id>$2 ORDER BY id LIMIT 11`,[space,cursor('sharing_after')])).rows:[];
  return prepared({projects:projects.slice(0,10),next:projects.length>10?projects[9].id:null,
   entities:{entities:entityPage.entities.slice(0,10),next:entityPage.entities.length>10?entityPage.entities[9]!.id:entityPage.next},
   ...(space?{assignment:await this.s.projects.effective(space),sharing_rules:rules.slice(0,10),sharing_next:rules.length>10?rules[9].id:null}:{}),
   delegations:delegationPage.delegations.slice(0,10),delegations_next:delegationPage.delegations.length>10?delegationPage.delegations[9]!.id:delegationPage.next,
   automatic_operations:['create_project','assign_conversation'],review_required:['identity_links','corrections','sharing','fact_access','project_edits']});
 }

 private async snapshot(principal:Reader,ids:string[],binding:GuardBinding):Promise<Dependencies> {
  const sources:SourceReference[]=[],values:PreparedDependency[]=[];
  for(const identity of [...new Set(ids)]) {
   const source=(await this.s.access.archive.captured(identity)).reference;
   if(!await this.s.access.canRead(principal,source,binding))throw new HttpError(403,'organization_source_denied');
   sources.push(source);const guarded=await this.s.guards.read('events:'+identity,binding);
   values.push({source_id:'events:'+identity,revision:guarded.revision,value_hash:digest(canonical(guarded.value))});
   const selections=(await this.stores.derived.query("SELECT artifact_id,kind FROM derivative_selections WHERE event_id=$1 AND active_revision IS NOT NULL AND kind IN ('transcript','extracted_text') ORDER BY id LIMIT 9",[identity])).rows;
   if(selections.length>8)throw new HttpError(400,'organization_evidence_limit');
   for(const selection of selections){const current=await this.s.selections.current(identity,selection.artifact_id,selection.kind,binding);
    values.push({source_id:'derived_artifacts:'+current.id,revision:current.guard_revision,value_hash:digest(canonical(current.value)),selection:{id:selectionId(identity,selection.artifact_id,selection.kind),revision:current.revision}});}
  }
  return {sources,values,owner_rules:[],proposal_revision:null,proposal_hash:''};
 }

 private evidence(value:KnowledgeProposal){return value.kind==='organization'?[...new Set([...value.creates.flatMap(c=>c.evidence_ids),...value.assignments.flatMap(a=>a.evidence_ids)])]:[];}

 async propose(principal:Reader,input:unknown) {
  const {turn,source,binding}=await this.ownerTurn(principal),body=exact(input,['operation_id','proposal']),operation=string(body.operation_id,200);
  if(!operation.trim())throw new HttpError(400,'operation_id_required');const proposal=parseKnowledgeProposal(body.proposal);
  const evidence=this.evidence(proposal);
  if(proposal.kind==='fact_grant'||proposal.kind==='entity_correct'){
   const fact=(await this.stores.derived.query(`SELECT v.revision,v.evidence FROM entity_claims c JOIN entity_claim_versions v
    ON v.claim_id=c.id AND v.revision=c.active_revision WHERE c.id=$1`,[proposal.kind==='fact_grant'?proposal.payload.fact_id:proposal.target_id])).rows[0];
   if(!fact||fact.revision!==(proposal.kind==='fact_grant'?proposal.payload.fact_revision:proposal.payload.expected_revision))throw new HttpError(409,'memory_fact_changed');
   evidence.push(...(fact.evidence as SourceReference[]).map(e=>e.id));
  }
  const dependencies=await this.snapshot(principal,[source.reference.id,...evidence],binding);
  const identity=digest(canonical([protocol,'turn',source.reference,operation]));
  return this.persist(identity,proposal,{origin:'turn',source:source.reference,space:turn.scope,profile:turn.logical_profile,job:null,binding,dependencies});
 }

 private async persist(identity:string,proposal:KnowledgeProposal,input:{origin:'turn'|'learning';source:SourceReference;space:string;profile:string|null;job:string|null;binding:GuardBinding;dependencies:Dependencies}) {
  const hash=digest(canonical({proposal,source:input.source}));
  const replay=(await this.stores.control.query('SELECT id,request_hash,state,revision FROM knowledge_proposals WHERE id=$1',[identity])).rows[0];
  if(replay){if(input.origin==='turn'&&replay.request_hash!==hash)throw new HttpError(409,'knowledge_proposal_conflict');return {id:replay.id,state:replay.state,revision:replay.revision};}
  if(proposal.kind==='organization')input.dependencies.projects??=(await this.stores.control.query('SELECT id,revision FROM projects WHERE id=ANY($1::text[])',[proposal.assignments.flatMap(a=>a.project_id?[a.project_id]:[])])).rows;
  const assignmentScopes=proposal.kind==='organization'?proposal.assignments.map(a=>a.space_id):proposal.kind==='project_assignment'?[proposal.payload.space_id]:[];
  input.dependencies.topics=Object.fromEntries(await Promise.all(assignmentScopes.map(async space=>[space,await this.affectedTopics(space,this.stores.control)])));
  const reference=await this.s.derived.record({operation_id:'knowledge-proposal:'+identity,source:input.source,kind:'knowledge_proposal',content:Buffer.from(canonical(proposal)),
   producer:input.origin==='learning'?'honcho':'hermes',producer_version:protocol,configuration:{schema:protocol},provenance:{dependencies:input.dependencies,origin:input.origin}});
  await this.s.guards.prepare(reference,protocol,this.s.detect);
  const binding=await this.s.guards.state();if(binding.generation!==input.binding.generation||binding.mode!==input.binding.mode)throw new HttpError(409,'knowledge_context_changed');
  const guarded=await this.s.guards.read('derived_artifacts:'+reference.id,binding),text=String((guarded.value as any).text??'');
  // Masking must not change the operation the model proposed; owner edits require a new proposal.
  if(canonical(JSON.parse(text))!==canonical(proposal))throw new HttpError(409,'knowledge_proposal_guarded');
  input.dependencies.proposal_revision=guarded.revision;input.dependencies.proposal_hash=digest(text);
  const match=proposal.kind==='organization'?await this.matchDelegation(proposal,{...input,binding},undefined):null;
  const state=match?'queued':'review',db=await this.stores.control.connect();
  try{await db.query('BEGIN');const guard=(await db.query('SELECT epoch,mode FROM guard_state WHERE singleton FOR UPDATE')).rows[0];
   if(Number(guard.epoch)!==binding.epoch||guard.mode!==binding.mode)throw new HttpError(409,'guard_context_changed');
   await db.query(`INSERT INTO knowledge_proposals(id,request_hash,kind,origin,source_reference,source_scope,logical_profile,source_job_id,proposal_reference,binding,dependencies,
    delegation_id,delegation_revision,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO NOTHING`,
    [identity,hash,proposal.kind,input.origin,input.source,input.space,input.profile,input.job,reference,binding,input.dependencies,match?.id??null,match?.revision??null,state]);
   await requestWorkflow(db,'organization','proposal:'+identity,1);await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  return {id:identity,state,revision:1};
 }

 private async row(identity:string):Promise<ProposalRow>{const row=(await this.stores.control.query('SELECT * FROM knowledge_proposals WHERE id=$1',[id(identity)])).rows[0];if(!row)throw new HttpError(404,'knowledge_proposal_not_found');return row;}
 private async content(row:ProposalRow,binding?:GuardBinding):Promise<KnowledgeProposal>{
  const artifact=(await this.stores.derived.query('SELECT content,content_hash FROM derived_artifacts WHERE id=$1 AND NOT imported',[row.proposal_reference.id])).rows[0];
  if(!artifact||artifact.content_hash!==row.proposal_reference.input_hash||digest(artifact.content)!==artifact.content_hash)throw new HttpError(409,'knowledge_proposal_changed');
  if(binding){const prepared=await this.s.guards.read('derived_artifacts:'+row.proposal_reference.id,binding);
   if(prepared.revision!==row.dependencies.proposal_revision||digest(String((prepared.value as any).text??''))!==row.dependencies.proposal_hash)throw new HttpError(409,'knowledge_proposal_changed');}
  return parseKnowledgeProposal(JSON.parse(artifact.content.toString()));
 }
 async proposal(principal:Reader,identity:string):Promise<Record<string,any>>{if(!principal.admin)await this.ownerTurn(principal);const row=await this.row(identity);
  if(!principal.admin){
   // A status remains inspectable after retirement without redisclosing the retired evidence.
   const status={id:row.id,kind:row.kind,state:row.state,revision:row.revision,approved:row.approved,error_code:row.error_code};
   await this.s.prepared.allow(principal,status);await this.s.turns.assertAudience(principal);return status;
  }
  const proposal=await this.content(row),decision_history=(await this.stores.control.query('SELECT operation_id,result,created_at FROM knowledge_decisions WHERE proposal_id=$1 ORDER BY created_at,operation_id',[row.id])).rows;
  return {...row,proposal,evidence:row.dependencies.sources,affected_topics:row.dependencies.topics??{},decision_history};}
 async proposals(principal:Reader,after=''){admin(principal);if(after)id(after);const rows=(await this.stores.control.query(`SELECT id FROM knowledge_proposals WHERE $1='' OR
  (created_at,id)<(SELECT created_at,id FROM knowledge_proposals WHERE id=$1) ORDER BY created_at DESC,id DESC LIMIT 101`,[after])).rows;
  return {proposals:await Promise.all(rows.slice(0,100).map(row=>this.proposal(principal,row.id))),next:rows.length>100?rows[99].id:null};}

 private async validate(row:ProposalRow):Promise<GuardBinding>{
  const binding=await this.s.guards.state();
  if(binding.generation!==row.binding.generation||binding.mode!==row.binding.mode)throw new HttpError(409,'knowledge_context_changed');
  try{await this.s.learned.validateDependencies(row.dependencies.values,binding);}
  catch(error){if(error instanceof HttpError&&error.code==='memory_refresh_required')throw new HttpError(409,'knowledge_dependencies_changed');throw error;}
  for(const source of row.dependencies.sources){
   if(!await this.s.access.canRead({admin:false,scope:null},source,binding)||row.origin==='learning'&&!await this.s.access.canLearn(source,binding))throw new HttpError(409,'knowledge_evidence_unavailable');
  }
  for(const rule of row.dependencies.owner_rules){
   const saved=(await this.stores.derived.query(`SELECT e.active_revision,g.active_revision AS guard_revision FROM learned_entries e
    LEFT JOIN learned_versions v ON v.entry_id=e.id AND v.revision=e.active_revision
    LEFT JOIN guard_sources g ON g.id='derived_artifacts:'||v.derived_id WHERE e.id=$1`,[rule.id])).rows[0];
   if(Number(rule.kind==='owner_guard'?saved?.guard_revision:saved?.active_revision)!==rule.revision)throw new HttpError(409,'knowledge_rule_changed');
  }
  await this.content(row,binding);return binding;
 }

 private async affectedTopics(space:string,db:Pick<pg.PoolClient,'query'>):Promise<string[]>{
  if(parentSpace(space))return [];
  const observed=(await this.stores.archive.query(`SELECT DISTINCT metadata->'audience'->>'topic_id' AS topic FROM source_observations
   WHERE metadata->'audience'->>'chat_id'=$1 AND metadata->'audience'->>'topic_state'='known'`,[space])).rows;
  const assignments=(await db.query('SELECT space_id,mode FROM project_assignments WHERE starts_with(space_id,$1)',[space+'/topic/'])).rows;
  const topics=new Set([...observed.filter(r=>/^[1-9]\d*$/.test(r.topic)).map(r=>space+'/topic/'+r.topic),...assignments.map(a=>a.space_id)]);
  return [...topics].filter(topic=>!assignments.some(a=>a.space_id===topic&&a.mode!=='inherit')).sort();
 }

 private async matchDelegation(proposal:OrganizationProposal,input:{source:SourceReference;space:string;origin:string;binding:GuardBinding},db?:pg.PoolClient,required?:{id:string;revision:number}):Promise<OrganizationDelegation|null>{
  const control=db??this.stores.control;
  const rows=(await control.query('SELECT * FROM organization_delegations WHERE enabled AND (expires_at IS NULL OR expires_at>now()) ORDER BY id')).rows as OrganizationDelegation[];
  const captured=await this.s.access.archive.verify(input.source);
  const intake=(await control.query('SELECT transport,state FROM source_intakes WHERE event_id=$1',[input.source.id])).rows[0];
  if(captured.origin!=='live'||intake?.transport!=='capture'||intake.state!=='ready')return null;
  const evidence=new Map<string,string>();
  for(const identity of this.evidence(proposal)){
   const source=(await this.s.access.archive.captured(identity)).reference;
   if(!await this.s.access.canLearn(source,input.binding))return null;
   const scope=await this.s.access.space(source);if(!scope)return null;evidence.set(identity,scope);
  }
  for(const permission of rows){
   if(required&&(permission.id!==required.id||permission.revision!==required.revision))continue;
   if(input.origin==='learning'&&(!permission.scopes.includes(input.space)||BigInt(captured.sequence)<=BigInt(permission.capture_watermark))||proposal.creates.length&&!permission.allow_create)continue;
   if([...evidence.values()].some(space=>!permission.scopes.includes(space)))continue;
   let permitted=true;
   for(const create of proposal.creates)if((await control.query("SELECT 1 FROM projects WHERE lower(name)=lower($1) LIMIT 1",[create.name])).rowCount)permitted=false;
   for(const space of new Set([...evidence.values(),...(input.origin==='learning'?[input.space]:[])])){
    if(!await this.baselineMatches(permission,space,control))permitted=false;
   }
   for(const change of [...proposal.creates,...proposal.assignments])if(input.origin==='learning'&&!change.evidence_ids.includes(input.source.id))permitted=false;
   for(const assignment of proposal.assignments){
    if(!assignment.purpose_evidence||!permission.scopes.includes(assignment.space_id)||input.origin==='learning'&&assignment.space_id!==input.space){permitted=false;break;}
    // Evidence of another project's existence is not evidence of this conversation's purpose.
    if(assignment.evidence_ids.some(e=>evidence.get(e)!==assignment.space_id)){permitted=false;break;}
    const current=(await control.query('SELECT revision FROM project_assignments WHERE space_id=$1',[assignment.space_id])).rows[0];
    if(!await this.baselineMatches(permission,assignment.space_id,control)||(current?.revision??0)!==assignment.expected_revision){permitted=false;break;}
    if(assignment.project_id&&!permission.project_ids.includes(assignment.project_id)&&!(await control.query('SELECT 1 FROM organization_project_origins WHERE project_id=$1 AND delegation_id=$2',[assignment.project_id,permission.id])).rowCount){permitted=false;break;}
    if(assignment.project_id&&(await control.query(`SELECT 1 FROM projects p JOIN projects other ON lower(other.name)=lower(p.name) AND other.id<>p.id
     WHERE p.id=$1 AND other.state='active' LIMIT 1`,[assignment.project_id])).rowCount){permitted=false;break;}
    for(const topic of await this.affectedTopics(assignment.space_id,control)){
     if(!permission.scopes.includes(topic)||!await this.baselineMatches(permission,topic,control))permitted=false;
    }
   }
   if(permitted)return permission;
  }
  return null;
 }

 private async baselineMatches(permission:OrganizationDelegation,space:string,db:Pick<pg.PoolClient,'query'>){
  const rows=(await db.query('SELECT space_id,revision,mode FROM project_assignments WHERE space_id=$1 OR space_id=$2',[space,parentSpace(space)])).rows;
  const own=rows.find(r=>r.space_id===space);
  if((own?.revision??0)!==permission.baselines[space])return false;
  if(parentSpace(space)&&(!own||own.mode==='inherit'))return permission.baselines['parent:'+space]===(rows.find(r=>r.space_id===parentSpace(space))?.revision??0);
  return true;
 }

 private async learning(identity:string):Promise<string|null>{
  const job=(await this.stores.control.query('SELECT * FROM interpretation_jobs WHERE id=$1',[id(identity)])).rows[0];
  if(!job||job.state!=='done')return null;
  const first=(await this.stores.control.query("SELECT id FROM interpretation_jobs WHERE source_reference->>'id'=$1 ORDER BY created_at,id LIMIT 1",[job.source_reference.id])).rows[0];
  if(first?.id!==job.id)return null;
  const contextRow=(await this.stores.derived.query('SELECT content,content_hash FROM derived_artifacts WHERE id=$1 AND NOT imported',[job.input_reference.id])).rows[0];
  const result=await this.s.derived.checkpoint('learning-result:'+identity);
  if(!contextRow||contextRow.content_hash!==job.input_reference.input_hash||digest(contextRow.content)!==contextRow.content_hash||!result)return null;
  let proposal:OrganizationProposal,context:any;
  try{context=JSON.parse(contextRow.content.toString());const parsed=JSON.parse(result.content.toString());
   if(!parsed.organization)return null;
   proposal=parseKnowledgeProposal({...parsed.organization,kind:'organization',reason:parsed.organization.reason??'Organize the permitted conversation evidence.'}) as OrganizationProposal;
  }catch{return null;}
  const captured=await this.s.access.archive.verify(job.source_reference);
  if(captured.origin!=='live')return null;
  const eligible=(await this.stores.control.query(`SELECT id,revision FROM organization_delegations WHERE enabled AND (expires_at IS NULL OR expires_at>now())
   AND scopes ? $1 AND capture_watermark<$2 ORDER BY id`,[context.space,captured.sequence])).rows;
  if(!eligible.length)return null;
  const permitted=new Set<string>(context.evidence.map((e:any)=>e.reference.id));
  if(this.evidence(proposal).some(e=>!permitted.has(e))||[...proposal.creates,...proposal.assignments].some(c=>!c.evidence_ids.includes(job.source_reference.id)))return null;
  if(proposal.assignments.some(a=>a.project_id&&!context.organization_context?.projects.some((p:any)=>p.id===a.project_id)))return null;
  // The intended effects and original evidence survive repeated reasoning and epoch changes.
  const proposalId=digest(canonical([protocol,'learning',job.source_reference,organizationIdentity(proposal)]));
  if((await this.stores.control.query('SELECT 1 FROM knowledge_proposals WHERE id=$1',[proposalId])).rowCount)return proposalId;
  const dependencies:Dependencies={sources:context.evidence.map((e:any)=>e.reference),values:context.dependencies,
   owner_rules:(context.rule_inputs??[]).filter((r:any)=>r.kind==='owner'||r.kind==='owner_guard').map(({id,revision,kind}:any)=>({id,revision,kind})),
   projects:(context.organization_context?.projects??[]).filter((p:any)=>proposal.assignments.some(a=>a.project_id===p.id)).map(({id,revision}:any)=>({id,revision})),proposal_revision:null,proposal_hash:''};
  await this.persist(proposalId,proposal,{origin:'learning',source:job.source_reference,space:context.space,profile:null,job:identity,binding:context.binding,dependencies});
  return proposalId;
 }

 private async completed(row:ProposalRow):Promise<'ready'|'waiting'|'cancelled'>{
  if(row.origin==='learning')return (await this.stores.control.query("SELECT 1 FROM interpretation_jobs WHERE id=$1 AND state='done'",[row.source_job_id])).rowCount?'ready':'waiting';
  const run=(await this.stores.control.query('SELECT state FROM managed_runs WHERE event_id=$1',[row.source_reference.id])).rows[0];
  if(run)return run.state==='done'?'ready':['failed','cancelled','ambiguous'].includes(run.state)?'cancelled':'waiting';
  const dispatch=(await this.stores.control.query("SELECT state,error_code FROM dispatches WHERE source_reference->>'id'=$1 ORDER BY created_at DESC LIMIT 1",[row.source_reference.id])).rows[0];
  if(!dispatch)return 'waiting';
  return dispatch.state==='done'||dispatch.state==='suppressed'&&dispatch.error_code==='intentional_silence'?'ready':['failed','cancelled','ambiguous','suppressed'].includes(dispatch.state)?'cancelled':'waiting';
 }

 private async outcome(db:Pick<pg.PoolClient,'query'>,identity:string,state:string,reason:string|null=null,result?:unknown){
  const saved=(await db.query(`UPDATE knowledge_proposals SET state=$2,error_code=$3,result=COALESCE($4,result),
   revision=revision+CASE WHEN state IS DISTINCT FROM $2 OR error_code IS DISTINCT FROM $3 OR $4 IS NOT NULL THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1 RETURNING state,revision`,[identity,state,reason,result===undefined?null:JSON.stringify(result)])).rows[0];
  return {...saved,...(reason?{reason}:{})};
 }

 async process(jobId:string):Promise<{state:string;reason?:string}>{
  const [kind,key]=jobId.split(':');if(!['learning','proposal'].includes(kind!)||!key)throw new HttpError(400,'invalid_organization_job');
  const identity=kind==='learning'?await this.learning(key):id(key);if(!identity)return {state:'noop'};
  const db=await this.stores.control.connect();let locked=false;
  try{
   locked=(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,803356)) AS held',[identity])).rows[0].held;
   if(!locked)return {state:'waiting',reason:'organization_busy'};
   let row=await this.row(identity);if(!activeStates.includes(row.state))return {state:row.state};
   const operation='knowledge-apply:'+identity;
   // An exact reviewed command may have committed just before its worker stopped.
   const receipt=(await db.query('SELECT result FROM owner_commands WHERE id=$1',[operation])).rows[0]??
    (await db.query("SELECT jsonb_build_object('id',grant_id,'revision',revision) AS result FROM memory_access_decisions WHERE operation_id=$1",[operation])).rows[0];
   if(receipt&&row.approved)return await this.outcome(db,identity,'applied',null,{operation_id:operation,receipt:receipt.result});
   const completion=await this.completed(row);
   if(completion!=='ready')return await this.outcome(db,identity,completion,completion==='waiting'?'turn_completion_pending':'source_turn_incomplete');
   const binding=await this.validate(row),proposal=await this.content(row,binding);
   await db.query('BEGIN');
   const guard=(await db.query('SELECT epoch,mode FROM guard_state WHERE singleton FOR UPDATE')).rows[0];
   if(Number(guard.epoch)!==binding.epoch||guard.mode!==binding.mode)throw new HttpError(409,'guard_context_changed');
   row=(await db.query('SELECT * FROM knowledge_proposals WHERE id=$1 FOR UPDATE',[identity])).rows[0];
   if(!activeStates.includes(row.state)){await db.query('COMMIT');return {state:row.state};}
   for(const [scope,topics] of Object.entries(row.dependencies.topics??{}))if(canonical(topics)!==canonical(await this.affectedTopics(scope,db)))throw new HttpError(409,'organization_topics_changed');
   if(await foregroundReplyActive(db,binding)){const result=await this.outcome(db,identity,'waiting','foreground_reply_active');await db.query('COMMIT');return result;}
   if(proposal.kind==='organization'){
    const permission=row.approved?null:await this.matchDelegation(proposal,{origin:row.origin,source:row.source_reference,space:row.source_scope,binding},db,
     row.delegation_id?{id:row.delegation_id,revision:row.delegation_revision!}:undefined);
    if(!row.approved&&!permission){const result=await this.outcome(db,identity,'review','organization_review_required');await db.query('COMMIT');return result;}
    const result=await this.applyOrganization(db,row,proposal,permission,binding);await db.query('COMMIT');return result;
   }
   if(!row.approved){const result=await this.outcome(db,identity,'review');await db.query('COMMIT');return result;}
   await db.query('COMMIT');
   const result=await this.applyReviewed(proposal,{...owner,generation:binding.generation,guard_epoch:binding.epoch},operation);
   return await this.outcome(db,identity,'applied',null,{operation_id:operation,receipt:result});
  }catch(error){
   await db.query('ROLLBACK');const code=error instanceof HttpError?error.code:'organization_application_failed';
   const transient=['guard_context_changed','guard_transition_pending','memory_refresh_required','organization_busy','foreground_reply_active'].includes(code);
   return await this.outcome(db,identity,transient?'waiting':error instanceof HttpError&&[403,409].includes(error.status)?'stale':'failed',code);
  }finally{if(locked)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,803356))',[identity]);db.release();}
 }

 private async invalidate(db:pg.PoolClient){const epoch=Number((await db.query('UPDATE guard_state SET epoch=epoch+1 WHERE singleton RETURNING epoch')).rows[0].epoch);
  await requestWorkflow(db,'honcho','refresh',epoch);await requestWorkflow(db,'memory_review','refresh',epoch);return epoch;}

 private async applyOrganization(db:pg.PoolClient,row:ProposalRow,proposal:OrganizationProposal,permission:OrganizationDelegation|null,binding:GuardBinding){
  const created:any[]=[],assignments:{before:Assignment|null;after:Assignment}[]=[],keys=new Map<string,string>();
  for(const dependency of row.dependencies.projects??[]){const project=(await db.query('SELECT revision,state FROM projects WHERE id=$1',[dependency.id])).rows[0];
   if(!project||project.state!=='active'||project.revision!==dependency.revision)throw new HttpError(409,'organization_project_changed');}
  for(const create of proposal.creates){
   // Never guess which of identically named projects was meant.
   if(!row.approved&&(await db.query('SELECT 1 FROM projects WHERE lower(name)=lower($1)',[create.name])).rowCount)throw new HttpError(409,'organization_project_name_conflict');
   const projectId=digest(canonical(['organized-project',row.id,create.name.toLocaleLowerCase()]));
   const project=await writeProject(db,{id:projectId,name:create.name,description:create.description,state:'active',expected_revision:0});created.push(project);keys.set(create.key,projectId);
   await db.query('INSERT INTO organization_project_origins(project_id,delegation_id,proposal_id,draft_key) VALUES($1,$2,$3,$4)',[projectId,permission?.id??null,row.id,create.key]);
  }
  for(const change of proposal.assignments){
   const before=(await db.query('SELECT space_id,project_id,mode,revision FROM project_assignments WHERE space_id=$1',[change.space_id])).rows[0]??null;
   if((before?.revision??0)!==change.expected_revision)throw new HttpError(409,'assignment_revision_conflict');
   const project_id=change.project_id??keys.get(change.project_key!)!;
   if(before?.mode==='assigned'&&before.project_id===project_id)continue;
   const after=await writeAssignment(db,{space_id:change.space_id,project_id,mode:'assigned',expected_revision:change.expected_revision});assignments.push({before,after});
   if(permission){permission.baselines[change.space_id]=after.revision;delete permission.baselines['parent:'+change.space_id];
    for(const scope of permission.scopes)if(parentSpace(scope)===change.space_id&&permission.baselines['parent:'+scope]!==undefined)permission.baselines['parent:'+scope]=after.revision;}
  }
  if(permission&&assignments.length)await db.query('UPDATE organization_delegations SET baselines=$2,updated_at=now() WHERE id=$1',[permission.id,permission.baselines]);
  const changed=!!(created.length||assignments.length),epoch=changed?await this.invalidate(db):binding.epoch;
  return this.outcome(db,row.id,'applied',null,{operation_id:'knowledge-apply:'+row.id,created,assignments,changed,epoch,
   authorization:permission?{delegation_id:permission.id,revision:permission.revision}:{owner_review:true},evidence:row.dependencies.sources});
 }

 private async applyReviewed(proposal:ReviewProposal,principal:Reader,operation_id:string){
  const input={...proposal.payload,operation_id},target=proposal.target_id!;
  switch(proposal.kind){
   case 'project_save':return this.s.projects.save(principal,input);
   case 'project_assignment':return this.s.projects.assign(principal,input);
   case 'entity_rename':return this.s.entities.rename(principal,target,input);
   case 'entity_correct':return this.s.entities.correct(principal,target,input);
   case 'entity_merge':return this.s.entities.merge(principal,target,input);
   case 'entity_unmerge':return this.s.entities.unmerge(principal,target,input);
   case 'sharing_rule':return this.s.sharing.save(principal,input);
   case 'fact_grant':return this.s.memoryAccess.grant(principal,input);
   case 'fact_revoke':return this.s.memoryAccess.revoke(principal,target,input);
  }
 }

 async decide(principal:Reader,identity:string,input:unknown){
  admin(principal);id(identity);const body=exact(input,['decision','expected_revision','operation_id']),expected=revision(body.expected_revision),operation=string(body.operation_id,200);
  if(!operation.trim()||!['approve','reject','cancel'].includes(body.decision))throw new HttpError(400,'invalid_knowledge_decision');
  const hash=digest(canonical({identity,...body})),db=await this.stores.control.connect();
  try{await db.query('SELECT pg_advisory_lock(hashtextextended($1,803356))',[identity]);await db.query('BEGIN');
   await db.query('SELECT epoch FROM guard_state WHERE singleton FOR UPDATE');
   const replay=(await db.query('SELECT request_hash,result FROM knowledge_decisions WHERE operation_id=$1',[operation])).rows[0];
   if(replay){if(replay.request_hash!==hash)throw new HttpError(409,'knowledge_decision_conflict');await db.query('COMMIT');return replay.result;}
   const row=(await db.query('SELECT * FROM knowledge_proposals WHERE id=$1 FOR UPDATE',[identity])).rows[0] as ProposalRow;
   if(!row||row.revision!==expected||!['review','queued','waiting','stale','failed'].includes(row.state))throw new HttpError(409,'knowledge_proposal_changed');
   if(body.decision==='approve'){
    await this.validate(row);await db.query('UPDATE knowledge_proposals SET approved=true WHERE id=$1',[identity]);
   }
   const result={...await this.outcome(db,identity,body.decision==='approve'?'queued':'cancelled',body.decision==='approve'?null:'owner_'+body.decision),
    decision:body.decision,previous:{state:row.state,error_code:row.error_code,revision:row.revision,result:row.result}};
   if(body.decision==='approve')await requestWorkflow(db,'organization','proposal:'+identity,result.revision);
   await db.query('INSERT INTO knowledge_decisions(operation_id,proposal_id,request_hash,result) VALUES($1,$2,$3,$4)',[operation,identity,hash,result]);
   await db.query('COMMIT');return result;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{await db.query('SELECT pg_advisory_unlock(hashtextextended($1,803356))',[identity]);db.release();}
 }

 async undo(principal:Reader,identity:string,input:unknown){
  admin(principal);id(identity);const body=exact(input,['expected_revision','operation_id']),expected=revision(body.expected_revision),operation=string(body.operation_id,200);
  if(!operation.trim())throw new HttpError(400,'operation_id_required');const hash=digest(canonical({identity,...body,undo:true})),db=await this.stores.control.connect();
  try{await db.query('SELECT pg_advisory_lock(hashtextextended($1,803356))',[identity]);await db.query('BEGIN');await db.query('SELECT epoch FROM guard_state WHERE singleton FOR UPDATE');
   const replay=(await db.query('SELECT request_hash,result FROM knowledge_decisions WHERE operation_id=$1',[operation])).rows[0];
   if(replay){if(replay.request_hash!==hash)throw new HttpError(409,'knowledge_decision_conflict');await db.query('COMMIT');return replay.result;}
   const row=(await db.query('SELECT * FROM knowledge_proposals WHERE id=$1 FOR UPDATE',[identity])).rows[0] as ProposalRow;
   if(!row||row.revision!==expected||row.state!=='applied'||row.kind!=='organization')throw new HttpError(409,'knowledge_undo_unavailable');
   const result=row.result,restored=[];
   for(const change of result.assignments){const current=(await db.query('SELECT * FROM project_assignments WHERE space_id=$1',[change.after.space_id])).rows[0];
    if(current?.revision!==change.after.revision)throw new HttpError(409,'knowledge_undo_conflict');
    restored.push(await writeAssignment(db,{space_id:current.space_id,project_id:change.before?.project_id??null,mode:change.before?.mode??'inherit',expected_revision:current.revision}));}
   for(const created of result.created){
    if((await db.query('SELECT 1 FROM project_assignments WHERE project_id=$1',[created.id])).rowCount)throw new HttpError(409,'knowledge_undo_conflict');
    await writeProject(db,{...created,state:'archived',expected_revision:created.revision});
   }
   const epoch=result.changed?await this.invalidate(db):null;
   const saved=await this.outcome(db,identity,'undone',null,{...result,undo:{operation_id:operation,assignments:restored,epoch}});
   await db.query('INSERT INTO knowledge_decisions(operation_id,proposal_id,request_hash,result) VALUES($1,$2,$3,$4)',[operation,identity,hash,saved]);
   await db.query('COMMIT');return saved;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{await db.query('SELECT pg_advisory_unlock(hashtextextended($1,803356))',[identity]);db.release();}
 }
}

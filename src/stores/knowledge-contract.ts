import {HttpError,object,string} from '../http.js';
import {validateSpace} from '../spaces.js';

export const knowledgeId=(value:unknown):string=>{const id=string(value,64);if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_knowledge_identity');return id;};
export const knowledgeRevision=(value:unknown):number=>{if(!Number.isSafeInteger(value)||Number(value)<0)throw new HttpError(400,'invalid_revision');return Number(value);};
export function knowledgeObject(value:unknown,keys:string[]):Record<string,any>{const row=object(value);if(Object.keys(row).some(k=>!keys.includes(k)))throw new HttpError(400,'unknown_knowledge_field');return row;}
const words=(value:unknown,size:number)=>{const result=string(value,size).trim();if(!result)throw new HttpError(400,'knowledge_text_required');return result;};
const evidence=(value:unknown):string[]=>{if(!Array.isArray(value)||!value.length||value.length>30)throw new HttpError(400,'organization_evidence_required');return [...new Set(value.map(knowledgeId))].sort();};
export type ProjectCreation={key:string;name:string;description:string;evidence_ids:string[]};
export type ProjectAssignment={space_id:string;project_id?:string;project_key?:string;expected_revision:number;evidence_ids:string[];reason:string;purpose_evidence:boolean};
export type OrganizationProposal={kind:'organization';reason:string;creates:ProjectCreation[];assignments:ProjectAssignment[]};
export const reviewKinds=['project_save','project_assignment','entity_rename','entity_correct','entity_merge','entity_unmerge','sharing_rule','fact_grant','fact_revoke'] as const;
export type ReviewKind=typeof reviewKinds[number];
export type ReviewProposal={kind:ReviewKind;reason:string;target_id?:string;payload:Record<string,any>};
export type KnowledgeProposal=OrganizationProposal|ReviewProposal;
const payloadKeys:Record<ReviewKind,string[]>={
 project_save:['id','name','description','state','expected_revision'],project_assignment:['space_id','project_id','mode','expected_revision'],
 entity_rename:['name','expected_revision'],entity_correct:['content','relationship_kind','attribution','uncertainty','retired','expected_revision'],
 entity_merge:['target_id','expected_revision'],entity_unmerge:['expected_revision'],
 sharing_rule:['id','name','sources','destination','enabled','mode','instructions','expected_revision'],
 fact_grant:['fact_id','fact_revision','destination','wording','expires_at'],fact_revoke:['expected_revision']
};
export function parseKnowledgeProposal(input:unknown):KnowledgeProposal {
 const head=object(input);
 if(head.kind==='organization') {
  const row=knowledgeObject(input,['kind','reason','creates','assignments']);
  if(!Array.isArray(row.creates)||!Array.isArray(row.assignments)||!row.creates.length&&!row.assignments.length||row.creates.length+row.assignments.length>30)throw new HttpError(400,'organization_batch_limit');
  const creates:ProjectCreation[]=row.creates.map(value=>{const c=knowledgeObject(value,['key','name','description','evidence_ids']),key=words(c.key,80);
   if(!/^[a-zA-Z0-9_-]+$/.test(key))throw new HttpError(400,'invalid_project_key');
   return {key,name:words(c.name,200),description:string(c.description??'',4000),evidence_ids:evidence(c.evidence_ids)};});
  if(new Set(creates.map(c=>c.key)).size!==creates.length||new Set(creates.map(c=>c.name.toLocaleLowerCase())).size!==creates.length)throw new HttpError(400,'duplicate_project_creation');
  const assignments:ProjectAssignment[]=row.assignments.map(value=>{const a=knowledgeObject(value,['space_id','project_id','project_key','expected_revision','evidence_ids','reason','purpose_evidence']);
   if((a.project_id!==undefined)===(a.project_key!==undefined)||typeof a.purpose_evidence!=='boolean')throw new HttpError(400,'invalid_organization_assignment');
   const project_key=a.project_key===undefined?undefined:words(a.project_key,80);
   if(project_key&&!creates.some(c=>c.key===project_key))throw new HttpError(400,'unknown_project_key');
   return {space_id:validateSpace(a.space_id),...(project_key?{project_key}:{project_id:knowledgeId(a.project_id)}),expected_revision:knowledgeRevision(a.expected_revision),evidence_ids:evidence(a.evidence_ids),reason:words(a.reason,2000),purpose_evidence:a.purpose_evidence};});
  if(new Set(assignments.map(a=>a.space_id)).size!==assignments.length)throw new HttpError(400,'duplicate_organization_assignment');
  return {kind:'organization',reason:words(row.reason,4000),creates,assignments};
 }
 const row=knowledgeObject(input,['kind','reason','target_id','payload']),kind=row.kind as ReviewKind;
 if(!reviewKinds.includes(kind))throw new HttpError(400,'unsupported_knowledge_operation');
 const payload=knowledgeObject(row.payload,payloadKeys[kind]);
 if(kind!=='fact_grant')knowledgeRevision(payload.expected_revision);else {knowledgeId(payload.fact_id);knowledgeRevision(payload.fact_revision);validateSpace(payload.destination);words(payload.wording,12000);}
 const targeted=kind.startsWith('entity_')||kind==='fact_revoke';
 if(targeted!==(row.target_id!==undefined))throw new HttpError(400,'knowledge_target_required');
 if(payload.id!==undefined)knowledgeId(payload.id);
 if(kind==='project_save'){words(payload.name,200);string(payload.description??'',4000);if(!['active','archived'].includes(payload.state))throw new HttpError(400,'invalid_project');}
 if(kind==='project_assignment'){validateSpace(payload.space_id);if(!['assigned','none','inherit'].includes(payload.mode))throw new HttpError(400,'invalid_project_assignment');if(payload.mode==='assigned')knowledgeId(payload.project_id);}
 if(kind==='entity_rename')words(payload.name,200);
 if(kind==='entity_merge')knowledgeId(payload.target_id);
 if(kind==='entity_correct'){string(payload.content,8000);if(!['direct','reported','inferred'].includes(payload.attribution)||!['uncertain','supported','explicit'].includes(payload.uncertainty)||typeof payload.retired!=='boolean')throw new HttpError(400,'invalid_entity_correction');}
 if(kind==='sharing_rule'){
  words(payload.name,200);validateSpace(payload.destination);string(payload.instructions??'',4000);
  if(!Array.isArray(payload.sources)||payload.sources.length>100||typeof payload.enabled!=='boolean'||!['approved','filtered'].includes(payload.mode))throw new HttpError(400,'invalid_sharing_rule');
  payload.sources=payload.sources.map(validateSpace);if(payload.sources.includes(payload.destination)||payload.enabled&&!payload.sources.length)throw new HttpError(400,'invalid_sharing_rule');
 }
 return {kind,reason:words(row.reason,4000),...(targeted?{target_id:knowledgeId(row.target_id)}:{}),payload};
}

/** Descriptive rationale is excluded; evidence and exact intended effects determine identity. */
export function organizationIdentity(value:OrganizationProposal){return {
 creates:value.creates.map(({name,evidence_ids})=>({name:name.toLocaleLowerCase(),evidence_ids})).sort((a,b)=>a.name.localeCompare(b.name)),
 assignments:value.assignments.map(a=>({space_id:a.space_id,project:a.project_id??value.creates.find(c=>c.key===a.project_key)!.name.toLocaleLowerCase(),evidence_ids:a.evidence_ids})).sort((a,b)=>a.space_id.localeCompare(b.space_id))
};}

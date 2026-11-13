import {HttpError,object,string} from '../http.js';
import {groupSpace,parentSpace,validateSpace} from '../spaces.js';
import {withoutNulls} from '../interpretations.js';

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
/** The organization part of a learning answer, or null when only private-chat or topic assignments were proposed. Honcho answers an
 * absent field as null: a null list is empty, and an item's null field, such as the unused one of project_id and project_key, is left
 * out. A private chat never joins a project (ADR-0242) and a topic always follows its group's (ADR-0246), so an assignment of
 * either is dropped, not the whole answer. */
export function learnedOrganization(organization:Record<string,unknown>):OrganizationProposal|null {
 const items=(value:unknown)=>Array.isArray(value)?value.map(withoutNulls):value??[];
 const assignments=items(organization.assignments);
 const dropped=(item:unknown)=>{if(!item||typeof item!=='object')return false;
  try{const space=validateSpace((item as Record<string,unknown>).space_id);return !groupSpace(space)||parentSpace(space)!==null;}catch{return false;}};
 const kept=Array.isArray(assignments)?assignments.filter(item=>!dropped(item)):assignments;
 const creates=items(organization.creates);
 // An answer that only assigned private chats or topics proposes nothing; an answer that proposed nothing is still malformed.
 if(Array.isArray(assignments)&&Array.isArray(kept)&&kept.length<assignments.length&&!kept.length&&Array.isArray(creates)&&!creates.length)return null;
 return parseKnowledgeProposal({...organization,creates,assignments:kept,kind:'organization',
  reason:organization.reason??'Organize the permitted conversation evidence.'}) as OrganizationProposal;
}
/** The private chats a proposal would share from or into, or put in a project; only a group or topic may be (ADR-0242). */
export function proposalPrivateChats(value:KnowledgeProposal):string[] {
 const named=value.kind==='organization'?value.assignments.map(a=>a.space_id):value.kind==='project_assignment'?(value.payload.mode==='assigned'?[value.payload.space_id]:[]):
  value.kind==='sharing_rule'?[...value.payload.sources,value.payload.destination]:value.kind==='fact_grant'?[value.payload.destination]:[];
 return [...new Set(named.filter((space:string)=>!groupSpace(space)))].sort();
}
/**
 * A proposal the agent makes, or one already saved. A new one never names a private chat where it would share from or
 * into, or put in a project (ADR-0242), and never puts a topic in a project or in none: a topic follows its group's
 * project (ADR-0246). A saved one (`stored`) is read as it was saved, so a proposal from before those rules still lists
 * and opens, and the owner can cancel it; applying it parses it as new and so is refused.
 */
export function parseKnowledgeProposal(input:unknown,options:{stored?:boolean}={}):KnowledgeProposal {
 const shareable=(value:unknown,code:string):string=>{const space=validateSpace(value);if(!options.stored&&!groupSpace(space))throw new HttpError(400,code);return space;};
 const group=(space:string):string=>{if(!options.stored&&parentSpace(space))throw new HttpError(400,'project_topic_follows_group');return space;};
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
   return {space_id:group(shareable(a.space_id,'project_private_chat')),...(project_key?{project_key}:{project_id:knowledgeId(a.project_id)}),expected_revision:knowledgeRevision(a.expected_revision),evidence_ids:evidence(a.evidence_ids),reason:words(a.reason,2000),purpose_evidence:a.purpose_evidence};});
  if(new Set(assignments.map(a=>a.space_id)).size!==assignments.length)throw new HttpError(400,'duplicate_organization_assignment');
  return {kind:'organization',reason:words(row.reason,4000),creates,assignments};
 }
 const row=knowledgeObject(input,['kind','reason','target_id','payload']),kind=row.kind as ReviewKind;
 if(!reviewKinds.includes(kind))throw new HttpError(400,'unsupported_knowledge_operation');
 const payload=knowledgeObject(row.payload,payloadKeys[kind]);
 if(kind!=='fact_grant')knowledgeRevision(payload.expected_revision);else {knowledgeId(payload.fact_id);knowledgeRevision(payload.fact_revision);shareable(payload.destination,'memory_grant_private_destination');words(payload.wording,12000);}
 const targeted=kind.startsWith('entity_')||kind==='fact_revoke';
 if(targeted!==(row.target_id!==undefined))throw new HttpError(400,'knowledge_target_required');
 if(payload.id!==undefined)knowledgeId(payload.id);
 if(kind==='project_save'){words(payload.name,200);string(payload.description??'',4000);if(!['active','archived'].includes(payload.state))throw new HttpError(400,'invalid_project');}
 if(kind==='project_assignment'){validateSpace(payload.space_id);if(!['assigned','none','inherit'].includes(payload.mode))throw new HttpError(400,'invalid_project_assignment');if(payload.mode==='assigned'){knowledgeId(payload.project_id);shareable(payload.space_id,'project_private_chat');}
  if(payload.mode!=='inherit')group(payload.space_id);}
 if(kind==='entity_rename')words(payload.name,200);
 if(kind==='entity_merge')knowledgeId(payload.target_id);
 if(kind==='entity_correct'){string(payload.content,8000);if(!['direct','reported','inferred'].includes(payload.attribution)||!['uncertain','supported','explicit'].includes(payload.uncertainty)||typeof payload.retired!=='boolean')throw new HttpError(400,'invalid_entity_correction');}
 if(kind==='sharing_rule'){
  words(payload.name,200);shareable(payload.destination,'sharing_private_chat');string(payload.instructions??'',4000);
  if(!Array.isArray(payload.sources)||payload.sources.length>100||typeof payload.enabled!=='boolean'||!['approved','filtered'].includes(payload.mode))throw new HttpError(400,'invalid_sharing_rule');
  payload.sources=payload.sources.map(source=>shareable(source,'sharing_private_chat'));if(payload.sources.includes(payload.destination)||payload.enabled&&!payload.sources.length)throw new HttpError(400,'invalid_sharing_rule');
 }
 return {kind,reason:words(row.reason,4000),...(targeted?{target_id:knowledgeId(row.target_id)}:{}),payload};
}

/** Descriptive rationale is excluded; evidence and exact intended effects determine identity. */
export function organizationIdentity(value:OrganizationProposal){return {
 creates:value.creates.map(({name,evidence_ids})=>({name:name.toLocaleLowerCase(),evidence_ids})).sort((a,b)=>a.name.localeCompare(b.name)),
 assignments:value.assignments.map(a=>({space_id:a.space_id,project:a.project_id??value.creates.find(c=>c.key===a.project_key)!.name.toLocaleLowerCase(),evidence_ids:a.evidence_ids})).sort((a,b)=>a.space_id.localeCompare(b.space_id))
};}

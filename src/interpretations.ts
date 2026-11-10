import {canonical} from './archive.js';
import {HttpError,object,string} from './http.js';
import type {SourceReference} from './stores/archive.js';

export type InterpretationScope={kind:'conversation'|'project';id:string};
export interface Interpretation {
  kind:'meaning'|'state'|'convention';subject:string;text:string;scope:InterpretationScope;
  uncertainty:'uncertain'|'supported'|'explicit';evidence:SourceReference[];
  quote?:{source_id:string;text:string};conflicts:string[];
}
export interface LearningEvidence {reference:SourceReference;text:string;space:string}
/** A dropped model item keeps only its section and validation code; the saved result keeps the item itself. */
export type LearningRejection={section:'interpretations'|'entity_suggestions'|'entity_claims';code:string};
const resultKeys=['interpretations','entity_suggestions','entity_claims','organization'];

const plain={type:'string'},ids={type:'array',maxItems:30,items:plain},oneOf=(description:string)=>({type:'string',description});
const list=(maxItems:number,properties:Record<string,unknown>)=>({type:'array',maxItems,items:{type:'object',properties}});
/** The answer Honcho's peer chat gives for learning. Honcho checks and repairs the model's JSON against it and
 * returns every field, an absent one as null. Fields stay optional and allowed values are only described, so the
 * checks below still drop one invalid item on its own. Honcho's repair keeps an item cut off at the output limit;
 * evidence_ids comes last, so such an item has none and is dropped too. */
export const learningResultSchema={type:'object',required:['interpretations'],properties:{
  interpretations:list(12,{kind:oneOf('meaning, state or convention'),subject:plain,text:plain,
    scope:{type:'object',properties:{kind:oneOf('conversation or project'),id:plain}},uncertainty:oneOf('uncertain, supported or explicit'),
    quote:{type:'object',properties:{source_id:plain,text:plain}},conflicts:ids,evidence_ids:ids}),
  entity_suggestions:list(12,{kind:oneOf('person, project or binding'),name:plain,candidate_id:plain,same_as:plain,reason:plain,evidence_ids:ids}),
  entity_claims:list(20,{subject_id:plain,predicate:plain,content:plain,object_entity_id:plain,
    relationship_kind:oneOf('contextual, participates, responsible, depends_on or associated'),attribution:oneOf('direct, reported or inferred'),
    speaker_entity_id:plain,uncertainty:oneOf('uncertain, supported or explicit'),evidence_ids:ids}),
  organization:{type:'object',properties:{reason:plain,creates:list(8,{key:plain,name:plain,description:plain,evidence_ids:ids}),
    assignments:list(20,{space_id:plain,project_id:plain,project_key:plain,expected_revision:{type:'integer'},reason:plain,
      purpose_evidence:{type:'boolean'},evidence_ids:ids})}}}};
/** A saved answer is the JSON object Honcho returned for learningResultSchema. */
export function learningResult(text:string):Record<string,unknown> {
  let value:unknown;try{value=JSON.parse(text);}catch{value=null;}
  if(!value||typeof value!=='object'||Array.isArray(value)||!Object.keys(value).some(key=>resultKeys.includes(key)))
    throw new HttpError(422,'invalid_interpretation_result');
  return value as Record<string,unknown>;
}
/** Bounded model sections keep their valid leading items; null or absent means none. */
export function resultItems(value:unknown,limit:number,section:LearningRejection['section'],rejected:LearningRejection[]):unknown[] {
  if(value===undefined||value===null)return [];
  if(!Array.isArray(value)){rejected.push({section,code:'invalid_'+section});return [];}
  for(let index=limit;index<value.length;index++)rejected.push({section,code:section+'_limit'});
  return value.slice(0,limit);
}
/** Optional model fields set to null mean the field is absent. */
export function withoutNulls(value:unknown):unknown {
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  return Object.fromEntries(Object.entries(value).filter(([,item])=>item!==null));
}

/** A learned rule can guide a new conclusion but is not an original source ID. */
export function triggeredInterpretations(input:unknown,trigger:string,ruleIds:string[]):unknown {
  const result=object(input);
  if(!Array.isArray(result.interpretations))return input;
  const rules=new Set(ruleIds);
  return {...result,interpretations:result.interpretations.filter(raw=>
    raw&&typeof raw==='object'&&Array.isArray(raw.evidence_ids)&&raw.evidence_ids.includes(trigger)).map(raw=>({
      ...raw,evidence_ids:raw.evidence_ids.filter((id:unknown)=>!rules.has(String(id)))
    }))};
}

/** A model can propose interpretations, never administration or privacy policy.
 * One invalid item is dropped and recorded; the other items of the same result remain usable. */
export function parseInterpretations(input:unknown,evidence:LearningEvidence[],space:string,projects:{id:string;name:string}[],sessionId?:string):{values:Interpretation[];rejected:LearningRejection[]} {
  const result=object(input),rejected:LearningRejection[]=[],values:Interpretation[]=[];
  if(Object.keys(result).some(k=>!resultKeys.includes(k)))throw new HttpError(422,'invalid_interpretation_result');
  for(const raw of resultItems(result.interpretations,12,'interpretations',rejected))try{values.push(parseInterpretation(raw,evidence,space,projects,sessionId));}
  catch(error){if(!(error instanceof HttpError))throw error;rejected.push({section:'interpretations',code:error.code});}
  return {values,rejected};
}
function parseInterpretation(raw:unknown,evidence:LearningEvidence[],space:string,projects:{id:string;name:string}[],sessionId?:string):Interpretation {
  const value=object(withoutNulls(raw)),allowed=['kind','subject','text','scope','uncertainty','evidence_ids','quote','conflicts'];
  if(Object.keys(value).some(k=>!allowed.includes(k))||!['meaning','state','convention'].includes(String(value.kind))||
    !['uncertain','supported','explicit'].includes(String(value.uncertainty)))throw new HttpError(422,'invalid_interpretation');
  const subject=string(value.subject,300).trim(),text=string(value.text,8000).trim(),scope=object(value.scope);
  if(!subject||!text||Object.keys(scope).some(k=>!['kind','id'].includes(k))||!['conversation','project'].includes(String(scope.kind)))
    throw new HttpError(422,'invalid_interpretation_scope');
  if(!Array.isArray(value.evidence_ids)||!value.evidence_ids.length||value.evidence_ids.length>30||value.evidence_ids.some(id=>typeof id!=='string'))
    throw new HttpError(422,'interpretation_evidence_required');
  const sources=[...new Set(value.evidence_ids as string[])].map(id=>{
    const source=evidence.find(e=>e.reference.id===id);if(!source)throw new HttpError(422,'unavailable_interpretation_evidence');return source;
  });
  let quote:Interpretation['quote'];
  if(value.quote!==undefined){const q=object(value.quote);quote={source_id:string(q.source_id,64),text:string(q.text,4000)};
    if(!quote.text.trim()||!sources.some(e=>e.reference.id===quote!.source_id&&e.text.includes(quote!.text)))throw new HttpError(422,'unverified_convention_quote');}
  if((value.kind==='convention'||value.uncertainty==='explicit')&&!quote)throw new HttpError(422,'convention_quote_required');
  if(scope.kind==='conversation') {
    // Honcho sometimes names its current session instead of the conversation.
    // Only that trusted, exact session alias can resolve to the evidence space.
    if(sources.some(e=>e.space!==space)||(scope.id!==space&&(!sessionId||scope.id!==sessionId)))
      throw new HttpError(422,'interpretation_scope_mismatch');
  } else {
    const project=projects.find(p=>p.id===scope.id);
    const quoted=quote?.text??'';
    const named=project&&quoted.includes(project.name)&&projects.filter(p=>quoted.includes(p.name)).length===1;
    const identified=project&&quoted.includes('project:'+project.id);
    if(value.kind!=='convention'||!quote||!project||(!named&&!identified))throw new HttpError(422,'explicit_project_reference_required');
  }
  const conflicts=value.conflicts??[];
  if(!Array.isArray(conflicts)||conflicts.length>30||conflicts.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))throw new HttpError(422,'invalid_interpretation_conflicts');
  return {kind:value.kind as Interpretation['kind'],subject,text,scope:{kind:scope.kind as InterpretationScope['kind'],id:scope.kind==='conversation'?space:string(scope.id,256)},
    uncertainty:value.uncertainty as Interpretation['uncertainty'],evidence:sources.map(e=>e.reference),...(quote?{quote}:{}),conflicts:[...new Set(conflicts as string[])]};
}

export interface InterpretationVersion extends Interpretation {
  id:string;revision:number;author:'honcho'|'participant'|'owner';retired:boolean;
}
const conventionWords=(text:string)=>(text.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}\p{Extended_Pictographic}]+/gu)??[])
  .filter(word=>!['a','an','the','that','is','was'].includes(word)).join(' ');
/** Explicit conflicts remain visible. Arrival order is never a tie-breaker. */
export function applicableInterpretations(versions:InterpretationVersion[]) {
  const groups=new Map<string,InterpretationVersion[]>();
  for(const version of versions.filter(v=>!v.retired)) {
    const category=version.kind==='convention'?'meaning':version.kind;
    const key=canonical([version.scope,category,version.subject]),group=groups.get(key)??[];group.push(version);groups.set(key,group);
  }
  return [...groups.values()].map(group=>{
    const rank=(v:InterpretationVersion)=>v.author==='owner'?3:v.author==='participant'||v.kind==='convention'||v.uncertainty==='explicit'?2:1;
    const highest=Math.max(...group.map(rank)),selected=group.filter(v=>rank(v)===highest).sort((a,b)=>a.id.localeCompare(b.id));
    const sameMeaning=selected.every(v=>v.kind==='convention')?
      new Set(selected.map(v=>conventionWords(v.text))).size===1:new Set(selected.map(v=>v.text)).size===1;
    const conflict=!sameMeaning||selected.some(v=>v.conflicts.some(id=>selected.some(other=>other.id===id)));
    return {scope:selected[0]!.scope,kind:selected[0]!.kind,subject:selected[0]!.subject,conflict,
      text:conflict?null:selected[0]!.text,selected:selected.map(v=>v.id),superseded:group.filter(v=>rank(v)<highest).map(v=>v.id).sort()};
  });
}

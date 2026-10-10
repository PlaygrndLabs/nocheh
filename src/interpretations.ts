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

/** Find the end of the JSON object that starts at `start`, honoring strings. */
function objectEnd(text:string,start:number):number {
  let depth=0,quoted=false,escaped=false;
  for(let index=start;index<text.length;index++) {
    const char=text[index];
    if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
    if(char==='"')quoted=true;else if(char==='{')depth++;else if(char==='}'&&--depth===0)return index;
  }
  return -1;
}
/** Reasoning models can wrap the requested JSON in a Markdown fence or a sentence.
 * The first complete top-level object carrying a requested section is the result. */
export function learningResult(text:string):Record<string,unknown> {
  const candidates=[text.trim()];
  for(const match of text.matchAll(/```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)```/g))candidates.push(match[1]!.trim());
  for(let start=text.indexOf('{');start>=0;) {
    const end=objectEnd(text,start);if(end<0)break;
    candidates.push(text.slice(start,end+1));start=text.indexOf('{',end+1);
  }
  for(const candidate of candidates) {
    let value:unknown;try{value=JSON.parse(candidate);}catch{continue;}
    if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).some(key=>resultKeys.includes(key)))return value as Record<string,unknown>;
  }
  throw new HttpError(422,'invalid_interpretation_result');
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

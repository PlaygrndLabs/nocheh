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

/** A model can propose interpretations, never administration or privacy policy. */
export function parseInterpretations(input:unknown,evidence:LearningEvidence[],space:string,projects:{id:string;name:string}[]):Interpretation[] {
  const result=object(input);
  if(Object.keys(result).some(k=>!['interpretations','entity_suggestions','entity_claims'].includes(k))||!Array.isArray(result.interpretations)||result.interpretations.length>12)
    throw new HttpError(422,'invalid_interpretation_result');
  return result.interpretations.map(raw=>{
    const value=object(raw),allowed=['kind','subject','text','scope','uncertainty','evidence_ids','quote','conflicts'];
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
      if(scope.id!==space||sources.some(e=>e.space!==space))throw new HttpError(422,'interpretation_scope_mismatch');
    } else {
      const project=projects.find(p=>p.id===scope.id);
      const quoted=quote?.text??'';
      const named=project&&quoted.includes(project.name)&&projects.filter(p=>quoted.includes(p.name)).length===1;
      const identified=project&&quoted.includes('project:'+project.id);
      if(value.kind!=='convention'||!quote||!project||(!named&&!identified))throw new HttpError(422,'explicit_project_reference_required');
    }
    const conflicts=value.conflicts??[];
    if(!Array.isArray(conflicts)||conflicts.length>30||conflicts.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))throw new HttpError(422,'invalid_interpretation_conflicts');
    return {kind:value.kind as Interpretation['kind'],subject,text,scope:{kind:scope.kind as InterpretationScope['kind'],id:string(scope.id,256)},
      uncertainty:value.uncertainty as Interpretation['uncertainty'],evidence:sources.map(e=>e.reference),...(quote?{quote}:{}),conflicts:[...new Set(conflicts as string[])]};
  });
}

export interface InterpretationVersion extends Interpretation {
  id:string;revision:number;author:'honcho'|'participant'|'owner';retired:boolean;
}
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
    const conflict=new Set(selected.map(v=>v.text)).size>1||selected.some(v=>v.conflicts.some(id=>selected.some(other=>other.id===id)));
    return {scope:selected[0]!.scope,kind:selected[0]!.kind,subject:selected[0]!.subject,conflict,
      text:conflict?null:selected[0]!.text,selected:selected.map(v=>v.id),superseded:group.filter(v=>rank(v)<highest).map(v=>v.id).sort()};
  });
}

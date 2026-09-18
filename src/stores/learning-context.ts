import {canonical,digest} from '../archive.js';
import {HttpError} from '../http.js';
import {applicableInterpretations,type InterpretationVersion,type LearningEvidence} from '../interpretations.js';
import type {SourceReference} from './archive.js';
import {SourceAccessRepository} from './access.js';
import {GuardRepository,type GuardBinding} from './guards.js';
import {LearnedMemoryRepository,type PreparedDependency} from './learned.js';
import {ProjectRepository} from './projects.js';
import {SelectionRepository,selectionId} from './selections.js';

export interface PreparedLearningContext {
  source:SourceReference;source_object:string;space:string;binding:GuardBinding;
  evidence:LearningEvidence[];dependencies:PreparedDependency[];
  observations:{source:SourceReference;value:unknown;derivatives:{kind:string;id:string;value:unknown}[]}[];
  rules:ReturnType<typeof applicableInterpretations>;rule_ids:string[];projects:{id:string;name:string}[];
  limitations:string[];
}
export class LearningContextRepository {
  constructor(readonly access:SourceAccessRepository,readonly guards:GuardRepository,readonly learned:LearnedMemoryRepository,
    readonly selections:SelectionRepository,readonly projects:ProjectRepository){}

  async prepare(source:SourceReference,binding:GuardBinding):Promise<PreparedLearningContext> {
    const space=await this.access.space(source);
    if(!space)throw new HttpError(409,'learning_context_pending');
    if(!await this.access.canLearn(source,binding))throw new HttpError(403,'learning_consent_required');
    const observed=await this.access.relationships.describe(source),principal=this.access.principal(space);
    const audience=observed.audience;
    const relations=await this.access.relationships.context(source,audience?{kind:'conversation',chat_id:audience.chat_id,
      topic_id:audience.topic_state==='known'?audience.topic_id!:null}:{kind:'owner'},30);
    const references=new Map([[source.id,source]]),limitations:string[]=[];
    for(const target of relations.targets) {
      if(target.unresolved)limitations.push('target_not_observed');
      if(target.next)limitations.push('target_history_truncated');
      const activity=await this.access.relationships.activity(target.identity,'',30);
      if(activity.next)limitations.push('activity_history_truncated');
      for(const reference of [...target.references,...activity.references]) {
        if(references.size>=30){limitations.push('evidence_limit');break;}
        if(await this.access.canLearn(reference,binding)&&await this.access.canRead(principal,reference,binding))references.set(reference.id,reference);
        else limitations.push('target_context_not_permitted');
      }
    }
    const dependencies:PreparedDependency[]=[],evidence:LearningEvidence[]=[],observations:PreparedLearningContext['observations']=[];
    for(const reference of references.values()) {
      const id='events:'+reference.id,guarded=await this.guards.read(id,binding),value=guarded.value as any;
      dependencies.push({source_id:id,revision:guarded.revision,value_hash:digest(canonical(value))});
      const derivatives:PreparedLearningContext['observations'][number]['derivatives']=[],texts=[String(value.text??'')];
      const selected=(await this.access.stores.derived.query(`SELECT artifact_id,kind FROM derivative_selections WHERE event_id=$1
        AND kind IN ('transcript','extracted_text') AND active_revision IS NOT NULL ORDER BY id LIMIT 31`,[reference.id])).rows;
      if(selected.length>30)throw new HttpError(409,'learning_derivative_limit');
      const media=(await this.access.stores.archive.query("SELECT id FROM artifacts WHERE event_id=$1 AND kind IN ('voice','audio','video_note')",[reference.id])).rows;
      if(media.some(m=>!selected.some(s=>s.artifact_id===m.id&&s.kind==='transcript')))throw new HttpError(409,'derivative_selection_pending');
      for(const selection of selected) {
        const current=await this.selections.current(reference.id,selection.artifact_id,selection.kind,binding);
        dependencies.push({source_id:'derived_artifacts:'+current.id,revision:current.guard_revision,value_hash:digest(canonical(current.value)),
          selection:{id:selectionId(reference.id,selection.artifact_id,selection.kind),revision:current.revision}});
        derivatives.push({kind:selection.kind,id:current.id,value:current.value});texts.push(String((current.value as any).text??''));
      }
      // Nested replies can contain another topic's text. Resolve their independent
      // source references instead of smuggling embedded target content into this scope.
      const scoped=structuredClone(value);
      for(const kind of ['message','edited_message','channel_post','edited_channel_post'])if(scoped.payload?.[kind]) {
        delete scoped.payload[kind].reply_to_message;delete scoped.payload[kind].external_reply;
      }
      observations.push({source:reference,value:scoped,derivatives});evidence.push({reference,text:texts.join('\n'),space});
    }
    const project=(await this.projects.effective(space)).project,projects=[];
    if(project?.state==='active') {
      projects.push({id:project.id,name:project.name});
      const duplicate=(await this.access.stores.control.query("SELECT id FROM projects WHERE id<>$1 AND name=$2 AND state='active' LIMIT 1",[project.id,project.name])).rows[0];
      if(duplicate)projects.push({id:duplicate.id,name:project.name});
    }
    const candidates=(await this.access.stores.derived.query(`SELECT id FROM learned_entries WHERE active_revision IS NOT NULL AND
      ((scope_kind='conversation' AND scope_id=$1) OR (scope_kind='project' AND scope_id=$2)) ORDER BY id LIMIT 101`,[space,project?.state==='active'?project.id:null])).rows;
    if(candidates.length>100)throw new HttpError(409,'learning_rule_limit');
    const versions:InterpretationVersion[]=[];
    for(const candidate of candidates)try {
      const version=await this.learned.read(principal,candidate.id,binding,async reference=>
        await this.access.canLearn(reference,binding)&&await this.access.canRead(principal,reference,binding));
      if(version.author!=='owner'&&version.kind!=='convention'&&version.uncertainty!=='explicit')continue;
      if(version.author!=='owner'&&(await this.access.stores.archive.query(`SELECT 1 FROM source_observations o JOIN source_revisions r ON r.id=o.revision_id
        WHERE o.event_id=ANY($1::text[]) AND r.object_id=$2 LIMIT 1`,[version.evidence.map(e=>e.id),observed.object_id])).rowCount)continue;
      versions.push(version);
    } catch(error) {
      if(error instanceof HttpError&&['learned_memory_not_found','memory_refresh_required'].includes(error.code))continue;throw error;
    }
    await this.guards.assertCurrent(binding);
    return {source,source_object:observed.object_id,space,binding,evidence,dependencies,observations,
      rules:applicableInterpretations(versions),rule_ids:versions.map(v=>v.id),projects,limitations:[...new Set(limitations)]};
  }
}

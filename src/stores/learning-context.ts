import {canonical,digest} from '../archive.js';
import {HttpError} from '../http.js';
import {parentSpace} from '../spaces.js';
import {applicableInterpretations,type InterpretationVersion,type LearningEvidence} from '../interpretations.js';
import type {SourceReference} from './archive.js';
import {SourceAccessRepository} from './access.js';
import {GuardRepository,type GuardBinding} from './guards.js';
import {LearnedMemoryRepository,type PreparedDependency} from './learned.js';
import {ProjectRepository} from './projects.js';
import {SelectionRepository,selectionId} from './selections.js';
import {RECORDINGS} from './reprocessing.js';
import {EntityRepository,type EntityContext,type KnownPeople,type WaitingCards} from './entities.js';

export type LearningRuleInput={kind:'source';dependency:PreparedDependency}|{kind:'owner'|'owner_guard';id:string;revision:number;text:string};
export interface PreparedLearningContext {
  source:SourceReference;source_object:string;space:string;binding:GuardBinding;
  evidence:LearningEvidence[];dependencies:PreparedDependency[];
  observations:{source:SourceReference;value:unknown;derivatives:{kind:string;id:string;value:unknown}[]}[];
  // Older persisted contexts predate rule_inputs; fresh preparation always supplies it.
  rules:ReturnType<typeof applicableInterpretations>;rule_ids:string[];rule_inputs?:LearningRuleInput[];projects:{id:string;name:string}[];
  entities:EntityContext&KnownPeople&WaitingCards;
  /** A topic's assignment names the group whose project it always follows (`follows_group`); only that group moves (ADR-0247). */
  organization_context?:{assignment:{space_id:string;project_id:string|null;revision:number;inherited:boolean;follows_group?:string};projects:{id:string;name:string;revision:number}[]};
  limitations:string[];
}
/**
 * What the owner's notes review asks of prepare (ADR-0257). `admit` says whether a related message, or the evidence of a
 * rule, may go into the owner's notes; one it refuses is left out, and so are the rules resting on it and any quote of
 * it. `admitPinned` asks the same of the message a pin carries, by its own author; one it refuses is taken out of the
 * pin, which stays. `not_learned` takes it out too, but not as left out for its sender: Nocheh's own card, notice or
 * reminder is not learned. `admitQuoted` asks the same of the message a quote repeats part of, even one never archived
 * (another bot's, or one in a chat this review does not read); one it refuses is taken out of the message quoting it,
 * which stays. `collect` gets the ids left out (a pin's or a quote's own id when only what it carried was), the rules kept,
 * the ids of the rules left out with them, `bare_reaction` when the source is a reaction to a message that was left out,
 * `empty_pin` when the source is a pin of Nocheh's card, notice or reminder, or of Nocheh's message not archived yet, with
 * nothing else in it, and each kept rule's recorded inputs (`inputs`: the source ids of its stored dependencies, by rule
 * id). Honcho passes none and interpretations only `collect`, so they learn from everyone's messages, as before, other
 * bots' included. For every caller a pin loses Nocheh's card, notice or reminder, and Nocheh's own account's message the
 * archive does not hold as Nocheh's learned one (not archived yet, or a forward of one); a quote of Nocheh's own words is
 * left out of the message quoting it, and out of a message a pin carries (NoteSourceRepository.carried, ADR-0256,
 * ADR-0257).
 */
export interface LearningContextOptions {
  admit?:(reference:SourceReference)=>Promise<boolean>;
  admitPinned?:(reference:SourceReference)=>Promise<boolean|'not_learned'>;
  admitQuoted?:(reference:SourceReference)=>Promise<boolean>;
  collect?:{dropped:string[];versions:InterpretationVersion[];refused:string[];bare_reaction:boolean;empty_pin?:boolean;inputs:Map<string,string[]>};
}
export class LearningContextRepository {
  constructor(readonly access:SourceAccessRepository,readonly guards:GuardRepository,readonly learned:LearnedMemoryRepository,
    readonly selections:SelectionRepository,readonly projects:ProjectRepository,readonly entities:EntityRepository){}

  async prepare(source:SourceReference,binding:GuardBinding,options:LearningContextOptions={}):Promise<PreparedLearningContext> {
    const space=await this.access.space(source);
    if(!space)throw new HttpError(409,'learning_context_pending');
    if(!await this.access.canLearn(source,binding))throw new HttpError(403,'learning_consent_required');
    const observed=await this.access.relationships.describe(source),principal=this.access.principal(space);
    const audience=observed.audience;
    // Relations within this very conversation only (its Nocheh chat or topic, ADR-0252), never its group's others.
    const relations=await this.access.relationships.context(source,audience?{kind:'recall',scope:{space,group:null}}:{kind:'owner'},30);
    const references=new Map([[source.id,source]]),limitations:string[]=[],dropped=new Set<string>(),targets=new Set<string>(),reacted=new Set<string>();
    for(const target of relations.targets) {
      if(target.unresolved)limitations.push('target_not_observed');
      if(target.next)limitations.push('target_history_truncated');
      for(const reference of target.references){targets.add(reference.id);if(target.kind==='reaction_to')reacted.add(reference.id);}
      const activity=await this.access.relationships.activity(target.identity,'',30);
      if(activity.next)limitations.push('activity_history_truncated');
      for(const reference of [...target.references,...activity.references]) {
        if(references.size>=30){limitations.push('evidence_limit');break;}
        if(!(await this.access.canLearn(reference,binding)&&await this.access.canRead(principal,reference,binding)))limitations.push('target_context_not_permitted');
        // What someone not allowed there sent is left out of the owner's notes review, without taking one of the 30 places.
        else if(options.admit&&!references.has(reference.id)&&!await options.admit(reference)){limitations.push('sender_not_allowed');dropped.add(reference.id);}
        else references.set(reference.id,reference);
      }
    }
    // A quote repeats part of the message replied to, so it goes when that message was left out.
    const unquote=[...dropped].some(id=>targets.has(id));
    const dependencies:PreparedDependency[]=[],evidence:LearningEvidence[]=[],observations:PreparedLearningContext['observations']=[],unpinned:string[]=[],unquoted:string[]=[];
    let emptyPin=false;
    for(const reference of references.values()) {
      const id='events:'+reference.id,guarded=await this.guards.read(id,binding),value=guarded.value as any;
      dependencies.push({source_id:id,revision:guarded.revision,value_hash:digest(canonical(value))});
      const derivatives:PreparedLearningContext['observations'][number]['derivatives']=[],texts=[String(value.text??'')];
      const selected=(await this.access.stores.derived.query(`SELECT artifact_id,kind FROM derivative_selections WHERE event_id=$1
        AND kind IN ('transcript','extracted_text') AND active_revision IS NOT NULL ORDER BY id LIMIT 31`,[reference.id])).rows;
      if(selected.length>30)throw new HttpError(409,'learning_derivative_limit');
      const media=(await this.access.stores.archive.query('SELECT id FROM artifacts WHERE event_id=$1 AND kind=ANY($2::text[])',[reference.id,RECORDINGS])).rows;
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
        const message=scoped.payload[kind];
        const carried=message.quote||message.pinned_message?(await this.entities.sources.carried([reference.id])).get(reference.id):undefined;
        delete message.reply_to_message;delete message.external_reply;
        // A pinned message carries its own reply too, with the words of the message it answers (a poll, a contact).
        if(message.pinned_message&&typeof message.pinned_message==='object'){delete message.pinned_message.reply_to_message;delete message.pinned_message.external_reply;}
        // A quote of Nocheh's own words, learned or not, is never the sender's: it goes, and the sender's own words stay. A
        // learned message is evidence of its own; a card, notice or reminder is not learned, and Nocheh's own account's
        // message the archive does not hold as Nocheh's (not archived yet, or a forward of one) is cut as a card is.
        // Another bot's message is someone else's, and its quote stays, as anyone else's does, except in the owner's notes
        // review, where a quote of what someone not allowed there wrote goes, another bot's included, archived or not.
        const quoted=!message.quote||unquote||carried?.quote||!options.admit||!options.admitQuoted?true:await options.admitQuoted(reference);
        if(unquote||carried?.quote||!quoted)delete message.quote;
        if(!quoted){limitations.push('sender_not_allowed');unquoted.push(reference.id);}
        // A pin carries the message it pinned whole. Nocheh's own card, notice or reminder stays out of everything learned
        // from it, whoever pinned it, and so does Nocheh's own account's message the archive does not hold as Nocheh's
        // (carried: `bot`); what someone not allowed there wrote, another bot's message included, stays out of the owner's
        // notes review only. A quote inside the pinned message goes as a quote does.
        const pinned:boolean|'not_learned'=!message.pinned_message?true:carried?.pinned==='unlearned'||carried?.pinned==='bot'?'not_learned':
          options.admit&&options.admitPinned?await options.admitPinned(reference):true;
        if(pinned!==true)delete message.pinned_message;
        else if(carried?.pinned_quote&&message.pinned_message&&typeof message.pinned_message==='object')delete message.pinned_message.quote;
        if(pinned===false){limitations.push('sender_not_allowed');unpinned.push(reference.id);}
        // The source itself, a pin of only Nocheh's card or of Nocheh's message not archived yet, leaves nothing to review.
        if(pinned==='not_learned'&&reference.id===source.id&&!texts.some(text=>text.trim())&&!derivatives.length)emptyPin=true;
      }
      observations.push({source:reference,value:scoped,derivatives});evidence.push({reference,text:texts.join('\n'),space});
    }
    const effective=await this.projects.effective(space),project=effective.project,projects=[];
    if(project?.state==='active') {
      projects.push({id:project.id,name:project.name,revision:project.revision});
      const duplicate=(await this.access.stores.control.query("SELECT id,revision FROM projects WHERE id<>$1 AND name=$2 AND state='active' LIMIT 1",[project.id,project.name])).rows[0];
      if(duplicate)projects.push({id:duplicate.id,name:project.name,revision:duplicate.revision});
    }
    const all=(await this.access.stores.control.query("SELECT id,name,description,state,revision FROM projects WHERE state='active' ORDER BY id LIMIT 101")).rows;
    if(all.length>100)limitations.push('project_catalog_limit');
    const corpus=(evidence.find(item=>item.reference.id===source.id)?.text??'').toLocaleLowerCase(),mentioned=[];
    // A project is found by its name or by any other name the owner confirmed for it. A name
    // that more than one project uses names none of them.
    const catalog=all.slice(0,100),aliases=await this.entities.projectAliases(catalog.map(candidate=>candidate.id)),owners=new Map<string,Set<string>>();
    const names=(candidate:{id:string;name:string})=>[...new Set([...(candidate.name.trim()?[candidate.name.toLocaleLowerCase()]:[]),
      ...(aliases.get(candidate.id)??[]).map(alias=>alias.toLocaleLowerCase()).filter(alias=>alias.trim())])];
    for(const candidate of catalog)for(const name of names(candidate))owners.set(name,(owners.get(name)??new Set()).add(candidate.id));
    for(const candidate of catalog)if(candidate.id!==project?.id) {
      const used=names(candidate).filter(name=>corpus.includes(name));if(!used.length)continue;
      if(used.some(name=>owners.get(name)!.size===1)){projects.push({id:candidate.id,name:candidate.name,revision:candidate.revision});mentioned.push(candidate);}
      else limitations.push('ambiguous_project_reference');
    }
    const local=await this.entities.context(source,mentioned,corpus),waiting=await this.entities.waiting(principal,binding);
    if(waiting.partial)limitations.push('waiting_suggestion_limit');
    const entities={...local,...await this.entities.knownPeople(evidence.map(item=>item.reference),local.speaker),waiting:waiting.waiting};
    const candidates=(await this.access.stores.derived.query(`SELECT e.id,v.dependencies,g.active_revision AS rule_guard_revision,r.author AS rule_guard_author
      FROM learned_entries e JOIN learned_versions v ON v.entry_id=e.id AND v.revision=e.active_revision
      LEFT JOIN guard_sources g ON g.id='derived_artifacts:'||v.derived_id
      LEFT JOIN guard_revisions r ON r.source_id=g.id AND r.revision=g.active_revision WHERE e.active_revision IS NOT NULL AND
      ((scope_kind='conversation' AND scope_id=$1) OR (scope_kind='project' AND scope_id=$2))
      ORDER BY v.author='owner' DESC,e.kind='convention' DESC,v.created_at DESC,e.id LIMIT 101`,[space,project?.state==='active'?project.id:null])).rows;
    // A busy chat keeps learning past 100 rules: the owner's own rules, then conventions, then the newest are kept.
    if(candidates.length>100){candidates.pop();limitations.push('rule_catalog_limit');}
    const versions:InterpretationVersion[]=[],ruleInputs=new Map<string,LearningRuleInput>(),refused=new Set<string>(),unread:string[]=[];
    const recorded=new Map<string,string[]>();
    for(const candidate of candidates)try {
      const version=await this.learned.read(principal,candidate.id,binding,async reference=>{
        if(!(await this.access.canLearn(reference,binding)&&await this.access.canRead(principal,reference,binding)))return false;
        // A rule resting on what someone not allowed there sent stays out of the owner's notes review with it.
        if(options.admit&&!await options.admit(reference)){refused.add(candidate.id);return false;}
        return true;
      });
      if(version.author!=='owner'&&version.kind!=='convention'&&version.uncertainty!=='explicit')continue;
      if(version.author!=='owner'&&(await this.access.stores.archive.query(`SELECT 1 FROM source_observations o JOIN source_revisions r ON r.id=o.revision_id
        WHERE o.event_id=ANY($1::text[]) AND r.object_id=$2 LIMIT 1`,[version.evidence.map(e=>e.id),observed.object_id])).rowCount)continue;
      versions.push(version);
      // What code recorded the rule was learned from, whatever the model cited of it.
      recorded.set(version.id,Array.isArray(candidate.dependencies)?candidate.dependencies.map((dependency:any)=>String(dependency?.source_id??'')):[]);
      // Generated wording and model-chosen rule identities are not new evidence.
      // Automatic guidance changes only when its authorized source inputs change.
      const inputs:LearningRuleInput[]=version.author==='owner'?
        [{kind:'owner',id:version.id,revision:version.revision,text:version.text}]:
        (candidate.dependencies as PreparedDependency[]).map(dependency=>({kind:'source',dependency}));
      if(version.author!=='owner'&&binding.mode==='on'&&candidate.rule_guard_author==='owner')
        inputs.push({kind:'owner_guard',id:version.id,revision:candidate.rule_guard_revision,text:canonical(version)});
      for(const input of inputs)ruleInputs.set(canonical(input),input);
    } catch(error) {
      if(error instanceof HttpError&&['learned_memory_not_found','memory_refresh_required'].includes(error.code)){if(refused.has(candidate.id)){limitations.push('rule_sender_not_allowed');unread.push(candidate.id);}continue;}
      throw error;
    }
    if(options.collect) {
      options.collect.dropped.push(...new Set([...dropped,...unpinned,...unquoted]));options.collect.versions.push(...versions);options.collect.refused.push(...unread);
      for(const [id,inputs] of recorded)options.collect.inputs.set(id,inputs);
      // A reaction left with nothing it reacts to says nothing the owner's notes could use, nor does a pin of a card alone.
      options.collect.bare_reaction=[...reacted].some(id=>dropped.has(id))&&![...reacted].some(id=>references.has(id));
      options.collect.empty_pin=emptyPin&&references.size===1;
    }
    await this.guards.assertCurrent(binding);
    return {source,source_object:observed.object_id,space,binding,evidence,dependencies,observations,
      organization_context:{assignment:{space_id:space,project_id:project?.id??null,revision:effective.own_assignment?.revision??0,inherited:effective.inherited,
        ...(parentSpace(space)?{follows_group:parentSpace(space)!}:{})},projects:projects.map(p=>({id:p.id,name:p.name,revision:p.revision}))},
      rules:applicableInterpretations(versions),rule_ids:versions.map(v=>v.id),rule_inputs:[...ruleInputs.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,v])=>v),projects,entities,limitations:[...new Set(limitations)]};
  }
}

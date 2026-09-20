import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import type {SourceReference} from './archive.js';
import type {SourceAccessRepository} from './access.js';
import type {StorePools} from './connections.js';
import {OwnerCommands} from './owner-commands.js';
import type {Project,ProjectRepository} from './projects.js';
import type {PreparedLearningContext} from './learning-context.js';

const protocol='nocheh-connected-entities-v1';
export type EntityKind='person'|'project';
export type RelationshipKind='contextual'|'participates'|'responsible'|'depends_on'|'associated';
export interface MemoryEntity {id:string;kind:EntityKind;name:string;state:'active'|'merged'|'rejected';project_id:string|null;merged_into:string|null;revision:number}
export interface EntityContext {speaker:MemoryEntity|null;project:MemoryEntity|null;mentioned_projects:MemoryEntity[];mentioned_people:MemoryEntity[];session_id:string}
export interface EntityClaimInput {
 subject_id:string;predicate:string;content:string;object_entity_id?:string;relationship_kind?:RelationshipKind;
 attribution:'direct'|'reported'|'inferred';speaker_entity_id?:string;uncertainty:'uncertain'|'supported'|'explicit';evidence:SourceReference[];
}

const entityId=(value:unknown):string=>{const id=string(value,64);if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_entity_id');return id;};
const revision=(value:unknown):number=>{if(!Number.isSafeInteger(value)||Number(value)<0)throw new HttpError(400,'invalid_revision');return Number(value);};
const exact=(value:unknown,keys:string[])=>{const row=object(value);if(Object.keys(row).some(key=>!keys.includes(key)))throw new HttpError(400,'unknown_entity_field');return row;};
const participantName=(payload:unknown,fallback:string):string=>{
  try {
    const value=JSON.parse(Buffer.isBuffer(payload)?payload.toString():String(payload)),message=value.message??value.edited_message??value.channel_post??value.edited_channel_post??value;
    const actor=message?.from??message?.sender??value.from;
    if(!actor||typeof actor!=='object')return fallback;
    const part=(name:string)=>typeof actor[name]==='string'?actor[name].trim().slice(0,100):'';
    const name=[part('first_name'),part('last_name')].filter(Boolean).join(' ').trim()||part('username');
    return name.slice(0,200)||fallback;
  } catch{return fallback;}
};

export const honchoPeerId=(entity:Pick<MemoryEntity,'kind'|'id'>):string=>`${entity.kind}_${entity.id}`;
export const evidencePeerId=(source:SourceReference):string=>`evidence_${digest(canonical(['nocheh-connected-evidence-v1',source.id])).slice(0,48)}`;

/** Canonical identities live in control; source evidence and inferred claims remain in their owned stores. */
export class EntityRepository {
  private readonly commands:OwnerCommands;
  constructor(readonly stores:StorePools,readonly access:SourceAccessRepository,readonly projects:ProjectRepository){this.commands=new OwnerCommands(stores.control);}

  private async row(id:string):Promise<MemoryEntity> {
    const row=(await this.stores.control.query('SELECT * FROM memory_entities WHERE id=$1',[entityId(id)])).rows[0];
    if(!row)throw new HttpError(404,'entity_not_found');return row;
  }
  async ensureProject(project:Project):Promise<MemoryEntity> {
    const id=digest(canonical([protocol,'project',project.id]));
    await this.stores.control.query(`INSERT INTO memory_entities(id,kind,name,state,project_id)
      VALUES($1,'project',$2,'active',$3) ON CONFLICT(id) DO UPDATE SET name=$2,updated_at=now() WHERE memory_entities.project_id=$3`,[id,project.name,project.id]);
    const binding=digest(canonical([protocol,'project-binding',project.id]));
    await this.stores.control.query(`INSERT INTO memory_entity_bindings(id,entity_id,binding_kind,label,state)
      VALUES($1,$2,'project',$3,'exact') ON CONFLICT(id) DO UPDATE SET label=$3,updated_at=now()`,[binding,id,project.name]);
    return this.row(id);
  }
  async ensureParticipant(source:SourceReference):Promise<MemoryEntity|null> {
    await this.access.archive.verify(source);
    const found=(await this.stores.archive.query(`SELECT o.id,o.platform,o.namespace,o.kind,o.external_id,e.payload FROM source_relations r
      JOIN source_objects o ON o.id=r.target_id JOIN events e ON e.id=r.event_id
      WHERE r.event_id=$1 AND r.kind='authored_by' ORDER BY o.id LIMIT 2`,[source.id])).rows;
    if(found.length!==1)return null;
    const identity=found[0],id=digest(canonical([protocol,'person',identity.id]));
    const name=participantName(identity.payload,`${identity.platform} ${identity.kind} ${identity.external_id}`);
    await this.stores.control.query(`INSERT INTO memory_entities(id,kind,name,state)
      VALUES($1,'person',$2,'active') ON CONFLICT(id) DO UPDATE SET name=$2,updated_at=now()`,[id,name]);
    const binding=digest(canonical([protocol,'source-binding',identity.id]));
    await this.stores.control.query(`INSERT INTO memory_entity_bindings(id,entity_id,binding_kind,source_object_id,label,state)
      VALUES($1,$2,'source_identity',$3,$4,'exact') ON CONFLICT(id) DO NOTHING`,[binding,id,identity.id,name]);
    return this.row(id);
  }
  async context(source:SourceReference,knownProjects:Project[],text=''):Promise<EntityContext> {
    const speaker=await this.ensureParticipant(source),space=await this.access.space(source),effective=space?await this.projects.effective(space):null;
    const project=effective?.project?.state==='active'?await this.ensureProject(effective.project):null;
    const mentionedProjects=[];
    for(const candidate of knownProjects)if(candidate.state==='active'&&candidate.id!==project?.project_id)mentionedProjects.push(await this.ensureProject(candidate));
    const mentionedPeople:MemoryEntity[]=[],corpus=text.toLocaleLowerCase();
    if(corpus&&space) {
      const candidates=(await this.list(this.access.principal(space),{kind:'person'})).entities;
      for(const entity of candidates)if(entity.id!==speaker?.id) {
        const aliases=(await this.stores.control.query(`SELECT mention_key FROM memory_entity_bindings
          WHERE entity_id=$1 AND binding_kind='mention' AND state='confirmed' ORDER BY id LIMIT 21`,[entity.id])).rows;
        if(aliases.length<=20&&aliases.some(row=>corpus.includes(String(row.mention_key))))mentionedPeople.push(entity);
      }
    }
    const conversation=(await this.stores.archive.query(`SELECT o.id FROM source_relations r JOIN source_objects o ON o.id=r.target_id
      WHERE r.event_id=$1 AND r.kind IN ('contained_in','in_thread') ORDER BY CASE r.kind WHEN 'in_thread' THEN 0 ELSE 1 END,o.id LIMIT 1`,[source.id])).rows[0]?.id;
    return {speaker,project,mentioned_projects:mentionedProjects,mentioned_people:mentionedPeople,
      session_id:digest(canonical([protocol,'conversation',conversation??space??source.id]))};
  }
  async suggest(kind:'person'|'project'|'binding',name:string,source:SourceReference,reason:string,candidate?:string) {
    const clean=string(name,200).trim();if(!clean)throw new HttpError(400,'invalid_entity_name');
    const id=digest(canonical([protocol,'suggestion',kind,clean.toLocaleLowerCase(),source,candidate??null]));
    await this.stores.control.query(`INSERT INTO memory_entity_suggestions(id,kind,name,candidate_entity_id,source_reference,reason)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,[id,kind,clean,candidate??null,source,reason]);
    return (await this.stores.control.query('SELECT * FROM memory_entity_suggestions WHERE id=$1',[id])).rows[0];
  }
  async decide(principal:Reader,id:string,input:unknown) {
    admin(principal);const body=exact(input,['decision','entity_id','expected_revision','operation_id']),decision=String(body.decision);
    if(!['confirm','reject'].includes(decision))throw new HttpError(400,'invalid_entity_decision');
    const expected=revision(body.expected_revision),suggestionId=entityId(id),target=body.entity_id===undefined?null:entityId(body.entity_id);
    const operationId=string(body.operation_id,200);
    return this.commands.run(principal,operationId,{kind:'entity_suggestion',suggestionId,decision,target,expected},async db=>{
      const suggestion=(await db.query('SELECT * FROM memory_entity_suggestions WHERE id=$1 FOR UPDATE',[suggestionId])).rows[0];
      if(!suggestion)throw new HttpError(404,'entity_suggestion_not_found');
      if(suggestion.revision!==expected)throw new HttpError(409,'entity_suggestion_conflict');
      let entity:MemoryEntity|null=null;
      if(decision==='confirm') {
        if(target) {
          entity=(await db.query('SELECT * FROM memory_entities WHERE id=$1',[target])).rows[0]??null;
          if(!entity||entity.state!=='active')throw new HttpError(409,'active_entity_required');
          if(suggestion.kind!=='binding'&&entity.kind!==suggestion.kind)throw new HttpError(409,'entity_kind_mismatch');
        }
        else {
          if(suggestion.kind==='binding')throw new HttpError(400,'entity_target_required');
          const kind=suggestion.kind as EntityKind,created=digest(canonical([protocol,kind,'confirmed',suggestion.id]));
          const projectId=kind==='project'?digest(canonical([protocol,'suggested-project',suggestion.id])):null;
          if(projectId)await db.query(`INSERT INTO projects(id,name,description,state,revision) VALUES($1,$2,$3,'active',1) ON CONFLICT(id) DO NOTHING`,
            [projectId,suggestion.name,'Confirmed from a Nocheh entity suggestion.']);
          await db.query(`INSERT INTO memory_entities(id,kind,name,state,project_id) VALUES($1,$2,$3,'active',$4)`,
            [created,kind,suggestion.name,projectId]);
          entity=(await db.query('SELECT * FROM memory_entities WHERE id=$1',[created])).rows[0];
        }
        if(entity) {
          const authored=suggestion.kind==='binding'?(await this.stores.archive.query(`SELECT target_id FROM source_relations
            WHERE event_id=$1 AND kind='authored_by' ORDER BY target_id LIMIT 2`,[suggestion.source_reference.id])).rows:[];
          if(authored.length===1) {
            const binding=digest(canonical([protocol,'confirmed-source',authored[0].target_id]));
            await db.query(`INSERT INTO memory_entity_bindings(id,entity_id,binding_kind,source_object_id,label,state)
              VALUES($1,$2,'source_identity',$3,$4,'confirmed') ON CONFLICT(id) DO UPDATE SET entity_id=$2,state='confirmed',revision=memory_entity_bindings.revision+1,updated_at=now()`,
              [binding,entity.id,authored[0].target_id,suggestion.name]);
          } else {
            const mention=String(suggestion.name).trim().toLocaleLowerCase(),binding=digest(canonical([protocol,'confirmed-mention',entity.id,mention]));
            await db.query(`INSERT INTO memory_entity_bindings(id,entity_id,binding_kind,mention_key,label,state)
              VALUES($1,$2,'mention',$3,$4,'confirmed') ON CONFLICT(id) DO UPDATE SET state='confirmed',revision=memory_entity_bindings.revision+1,updated_at=now()`,
              [binding,entity.id,mention,suggestion.name]);
          }
        }
      }
      await db.query('UPDATE memory_entity_suggestions SET status=$2,revision=revision+1,updated_at=now() WHERE id=$1',
        [suggestionId,decision==='confirm'?'confirmed':'rejected']);
      return {id:suggestionId,status:decision==='confirm'?'confirmed':'rejected',entity};
    });
  }
  async merge(principal:Reader,id:string,input:unknown) {
    admin(principal);const body=exact(input,['target_id','expected_revision','operation_id']),source=entityId(id),target=entityId(body.target_id),expected=revision(body.expected_revision);
    if(source===target)throw new HttpError(400,'entity_merge_self');
    return this.commands.run(principal,string(body.operation_id,200),{kind:'entity_merge',source,target,expected},async db=>{
      const from=(await db.query('SELECT * FROM memory_entities WHERE id=$1 FOR UPDATE',[source])).rows[0],to=(await db.query('SELECT * FROM memory_entities WHERE id=$1',[target])).rows[0];
      if(!from||!to)throw new HttpError(404,'entity_not_found');if(from.revision!==expected)throw new HttpError(409,'entity_revision_conflict');
      if(from.kind!==to.kind||from.state!=='active'||to.state!=='active')throw new HttpError(409,'entity_merge_invalid');
      await db.query(`INSERT INTO memory_entity_binding_moves(id,binding_id,from_entity_id,to_entity_id,merge_revision)
        SELECT encode(sha256(convert_to('nocheh-binding-move-v1:'||id||':'||$1||':'||$3::text,'UTF8')),'hex'),id,$1,$2,$3::int
        FROM memory_entity_bindings WHERE entity_id=$1`,[source,target,expected+1]);
      await db.query('UPDATE memory_entity_bindings SET entity_id=$2,revision=revision+1,updated_at=now() WHERE entity_id=$1',[source,target]);
      await db.query("UPDATE memory_entities SET state='merged',merged_into=$2,revision=revision+1,updated_at=now() WHERE id=$1",[source,target]);
      return {id:source,state:'merged',merged_into:target,revision:expected+1};
    });
  }
  async unmerge(principal:Reader,id:string,input:unknown) {
    admin(principal);const body=exact(input,['expected_revision','operation_id']),source=entityId(id),expected=revision(body.expected_revision);
    return this.commands.run(principal,string(body.operation_id,200),{kind:'entity_unmerge',source,expected},async db=>{
      const row=(await db.query('SELECT * FROM memory_entities WHERE id=$1 FOR UPDATE',[source])).rows[0];
      if(!row)throw new HttpError(404,'entity_not_found');if(row.revision!==expected||row.state!=='merged')throw new HttpError(409,'entity_revision_conflict');
      await db.query(`UPDATE memory_entity_bindings b SET entity_id=m.from_entity_id,revision=b.revision+1,updated_at=now()
        FROM memory_entity_binding_moves m WHERE m.binding_id=b.id AND m.from_entity_id=$1 AND m.merge_revision=$2 AND NOT m.undone`,[source,expected]);
      await db.query('UPDATE memory_entity_binding_moves SET undone=true WHERE from_entity_id=$1 AND merge_revision=$2 AND NOT undone',[source,expected]);
      await db.query("UPDATE memory_entities SET state='active',merged_into=NULL,revision=revision+1,updated_at=now() WHERE id=$1",[source]);
      return {id:source,state:'active',revision:expected+1};
    });
  }
  async publishClaim(input:EntityClaimInput,binding:unknown,operation:string,author:'honcho'|'owner'='honcho') {
    const subject=await this.row(input.subject_id);if(subject.state!=='active')throw new HttpError(409,'entity_not_active');
    if(input.object_entity_id)await this.row(input.object_entity_id);if(input.speaker_entity_id)await this.row(input.speaker_entity_id);
    if(!input.evidence.length||input.evidence.length>30)throw new HttpError(422,'entity_claim_evidence_required');
    const predicate=string(input.predicate,100),content=string(input.content,8000).trim();if(!predicate||!content)throw new HttpError(422,'invalid_entity_claim');
    if(!!input.object_entity_id!==!!input.relationship_kind)throw new HttpError(422,'invalid_entity_relationship');
    const claim=digest(canonical([protocol,subject.id,predicate,input.object_entity_id??null])),db=await this.stores.derived.connect();
    try {await db.query('BEGIN');const current=(await db.query('SELECT active_revision FROM entity_claims WHERE id=$1 FOR UPDATE',[claim])).rows[0];
      if(current) {
        const prior=(await db.query('SELECT * FROM entity_claim_versions WHERE claim_id=$1 AND revision=$2',[claim,current.active_revision])).rows[0];
        if(prior&&!prior.retired&&prior.content===content&&prior.relationship_kind===(input.relationship_kind??null)&&prior.attribution===input.attribution&&
          prior.speaker_entity_id===(input.speaker_entity_id??null)&&prior.uncertainty===input.uncertainty&&canonical(prior.evidence)===canonical(input.evidence)) {
          await db.query('COMMIT');return {id:claim,revision:Number(current.active_revision)};
        }
      }
      const next=Number(current?.active_revision??0)+1,op=digest(canonical([operation,claim,next,input]));
      await db.query('INSERT INTO entity_claims(id,subject_entity_id,predicate,object_entity_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[claim,subject.id,predicate,input.object_entity_id??null]);
      await db.query(`INSERT INTO entity_claim_versions(operation_id,claim_id,revision,expected_revision,content,relationship_kind,attribution,speaker_entity_id,
        uncertainty,author,evidence,dependencies,input_binding) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'[]',$12)`,
        [op,claim,next,current?.active_revision??null,content,input.relationship_kind??null,input.attribution,input.speaker_entity_id??null,input.uncertainty,author,JSON.stringify(input.evidence),binding]);
      await db.query('UPDATE entity_claims SET active_revision=$2 WHERE id=$1',[claim,next]);await db.query('COMMIT');return {id:claim,revision:next};
    } catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async publishDiscoveries(context:PreparedLearningContext,input:unknown,operation:string) {
    const value=object(input),known=[context.entities.speaker,context.entities.project,...context.entities.mentioned_projects,...context.entities.mentioned_people].filter((item):item is MemoryEntity=>!!item);
    const knownIds=new Set(known.map(item=>item.id)),evidence=new Map(context.evidence.map(item=>[item.reference.id,item.reference])),published=[],suggestions=[];
    const suggested=value.entity_suggestions??[];
    if(!Array.isArray(suggested)||suggested.length>12)throw new HttpError(422,'invalid_entity_suggestions');
    for(const raw of suggested) {
      const row=exact(raw,['kind','name','candidate_id','reason','evidence_ids']);
      if(!['person','project','binding'].includes(String(row.kind))||!Array.isArray(row.evidence_ids)||!row.evidence_ids.length||row.evidence_ids.length>30)
        throw new HttpError(422,'invalid_entity_suggestion');
      const references=row.evidence_ids.map(id=>{const ref=evidence.get(String(id));if(!ref)throw new HttpError(422,'entity_evidence_unavailable');return ref;});
      const candidate=row.candidate_id===undefined?undefined:entityId(row.candidate_id);if(candidate&&!knownIds.has(candidate))throw new HttpError(422,'entity_candidate_unavailable');
      suggestions.push(await this.suggest(row.kind as 'person'|'project'|'binding',string(row.name,200),references[0]!,string(row.reason,1000),candidate));
    }
    if(context.entities.project&&context.entities.speaker)published.push(await this.publishClaim({subject_id:context.entities.project.id,predicate:'participates',
      content:`${context.entities.speaker.name} participated in ${context.entities.project.name}.`,object_entity_id:context.entities.speaker.id,
      relationship_kind:'participates',attribution:'inferred',speaker_entity_id:context.entities.speaker.id,uncertainty:'supported',evidence:[context.source]},context.binding,operation+':participation'));
    if(context.entities.project)for(const target of context.entities.mentioned_projects)published.push(await this.publishClaim({subject_id:context.entities.project.id,
      predicate:'contextual',content:`${target.name} was mentioned in ${context.entities.project.name} context.`,object_entity_id:target.id,relationship_kind:'contextual',
      attribution:'inferred',uncertainty:'supported',evidence:[context.source],
      ...(context.entities.speaker?{speaker_entity_id:context.entities.speaker.id}:{})},context.binding,operation+':contextual:'+target.id));
    if(context.entities.project)for(const target of context.entities.mentioned_people)published.push(await this.publishClaim({subject_id:context.entities.project.id,
      predicate:'contextual',content:`${target.name} was mentioned in ${context.entities.project.name} context.`,object_entity_id:target.id,relationship_kind:'contextual',
      attribution:'inferred',uncertainty:'supported',evidence:[context.source],
      ...(context.entities.speaker?{speaker_entity_id:context.entities.speaker.id}:{})},context.binding,operation+':contextual:'+target.id));
    const claims=value.entity_claims??[];if(!Array.isArray(claims)||claims.length>20)throw new HttpError(422,'invalid_entity_claims');
    for(const raw of claims) {
      const row=exact(raw,['subject_id','predicate','content','object_entity_id','relationship_kind','attribution','speaker_entity_id','uncertainty','evidence_ids']);
      const subject=entityId(row.subject_id),objectId=row.object_entity_id===undefined?undefined:entityId(row.object_entity_id),speaker=row.speaker_entity_id===undefined?undefined:entityId(row.speaker_entity_id);
      if(!knownIds.has(subject)||objectId&&!knownIds.has(objectId)||speaker&&!knownIds.has(speaker)||!['direct','reported','inferred'].includes(String(row.attribution))||
        !['uncertain','supported','explicit'].includes(String(row.uncertainty))||!Array.isArray(row.evidence_ids)||!row.evidence_ids.length||row.evidence_ids.length>30)
        throw new HttpError(422,'invalid_entity_claim');
      if(row.attribution==='direct'&&(!speaker||speaker!==subject||speaker!==context.entities.speaker?.id)||
        row.attribution==='reported'&&(!speaker||speaker!==context.entities.speaker?.id))throw new HttpError(422,'entity_attribution_mismatch');
      const references=row.evidence_ids.map(id=>{const ref=evidence.get(String(id));if(!ref)throw new HttpError(422,'entity_evidence_unavailable');return ref;});
      published.push(await this.publishClaim({subject_id:subject,predicate:string(row.predicate,100),content:string(row.content,8000),
        attribution:row.attribution as EntityClaimInput['attribution'],uncertainty:row.uncertainty as EntityClaimInput['uncertainty'],evidence:references,
        ...(objectId?{object_entity_id:objectId}:{}),...(row.relationship_kind?{relationship_kind:row.relationship_kind as RelationshipKind}:{}),
        ...(speaker?{speaker_entity_id:speaker}:{})},context.binding,operation+':claim:'+published.length));
    }
    return {published,suggestions};
  }
  async correct(principal:Reader,id:string,input:unknown) {
    admin(principal);const body=exact(input,['content','attribution','uncertainty','retired','expected_revision','operation_id']),claim=entityId(id),expected=revision(body.expected_revision);
    const attribution=String(body.attribution),uncertainty=String(body.uncertainty);
    if(!['direct','reported','inferred'].includes(attribution)||!['uncertain','supported','explicit'].includes(uncertainty)||typeof body.retired!=='boolean')
      throw new HttpError(400,'invalid_entity_correction');
    const ownerOperation=string(body.operation_id,200),operation=digest(canonical(['entity-owner-correction',ownerOperation,claim,expected+1]));
    return this.commands.run(principal,ownerOperation,{kind:'entity_claim_correction',claim,body},async()=>{
      const db=await this.stores.derived.connect();try{await db.query('BEGIN');
        const replay=(await db.query('SELECT revision,retired FROM entity_claim_versions WHERE operation_id=$1',[operation])).rows[0];
        if(replay){await db.query('COMMIT');return {id:claim,revision:replay.revision,retired:replay.retired};}
        const entry=(await db.query('SELECT * FROM entity_claims WHERE id=$1 FOR UPDATE',[claim])).rows[0];
        if(!entry)throw new HttpError(404,'entity_claim_not_found');if(entry.active_revision!==expected)throw new HttpError(409,'entity_claim_revision_conflict');
        const prior=(await db.query('SELECT * FROM entity_claim_versions WHERE claim_id=$1 AND revision=$2',[claim,expected])).rows[0],next=expected+1;
        await db.query(`INSERT INTO entity_claim_versions(operation_id,claim_id,revision,expected_revision,content,relationship_kind,attribution,speaker_entity_id,
          uncertainty,author,retired,evidence,dependencies,input_binding) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'owner',$10,$11,$12,$13)`,
          [operation,claim,next,expected,string(body.content,8000),prior.relationship_kind,attribution,prior.speaker_entity_id,uncertainty,body.retired,
            JSON.stringify(prior.evidence),JSON.stringify(prior.dependencies),JSON.stringify(prior.input_binding)]);
        await db.query('UPDATE entity_claims SET active_revision=$2 WHERE id=$1',[claim,next]);await db.query('COMMIT');return {id:claim,revision:next,retired:body.retired};
      }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    });
  }
  private async visible(principal:Reader,entity:MemoryEntity):Promise<boolean> {
    if(principal.admin||principal.scope===null)return true;
    if(entity.kind==='project'&&(await this.projects.effective(principal.space??principal.scope)).project?.id===entity.project_id)return true;
    const ids=(await this.stores.control.query("SELECT source_object_id FROM memory_entity_bindings WHERE entity_id=$1 AND state IN ('exact','confirmed') AND source_object_id IS NOT NULL",[entity.id])).rows.map(r=>r.source_object_id);
    if(ids.length&&(await this.stores.archive.query(`SELECT 1 FROM source_relations r JOIN events e ON e.id=r.event_id
      WHERE r.target_id=ANY($1::text[]) AND r.kind='authored_by' AND e.scope=$2 LIMIT 1`,[ids,principal.scope])).rowCount)return true;
    const claims=(await this.stores.derived.query(`SELECT v.evidence FROM entity_claims e JOIN entity_claim_versions v ON v.claim_id=e.id AND v.revision=e.active_revision
      WHERE NOT v.retired AND (e.subject_entity_id=$1 OR e.object_entity_id=$1) ORDER BY e.id LIMIT 101`,[entity.id])).rows;
    const binding=await this.access.guards.state();
    for(const claim of claims.slice(0,100))if((claim.evidence as SourceReference[]).length&&
      (await Promise.all((claim.evidence as SourceReference[]).map(ref=>this.access.canRead(principal,ref,binding)))).every(Boolean))return true;
    return false;
  }
  private async readableClaims(principal:Reader,id:string) {
    const rows=(await this.stores.derived.query(`SELECT e.*,v.revision,v.content,v.relationship_kind,v.attribution,v.speaker_entity_id,v.uncertainty,v.author,v.retired,v.evidence,v.created_at
      FROM entity_claims e JOIN entity_claim_versions v ON v.claim_id=e.id AND v.revision=e.active_revision WHERE NOT v.retired
      AND (e.subject_entity_id=$1 OR e.object_entity_id=$1) ORDER BY CASE v.uncertainty WHEN 'explicit' THEN 0 WHEN 'supported' THEN 1 ELSE 2 END,e.id LIMIT 201`,[id])).rows;
    const visible=[];for(const row of rows.slice(0,200)){
      let allowed=true;for(const ref of row.evidence as SourceReference[])if(!await this.access.canRead(principal,ref,await this.access.guards.state())){allowed=false;break;}
      if(allowed)visible.push(row);
    }return {claims:visible,partial:rows.length>200};
  }
  async inspect(principal:Reader,id:string) {
    const entity=await this.row(id);if(!await this.visible(principal,entity))throw new HttpError(404,'entity_not_found');
    const memory=await this.readableClaims(principal,entity.id),bindings=principal.admin?(await this.stores.control.query('SELECT * FROM memory_entity_bindings WHERE entity_id=$1 ORDER BY id',[entity.id])).rows:[];
    return {entity,bindings,...memory};
  }
  async history(principal:Reader,id:string,before?:number) {
    if(before!==undefined&&(!Number.isSafeInteger(before)||before<1||before>2147483647))throw new HttpError(400,'invalid_entity_revision');
    const claim=entityId(id),entry=(await this.stores.derived.query('SELECT * FROM entity_claims WHERE id=$1',[claim])).rows[0];
    if(!entry)throw new HttpError(404,'entity_claim_not_found');
    const subject=await this.row(entry.subject_entity_id);if(!await this.visible(principal,subject))throw new HttpError(404,'entity_claim_not_found');
    const rows=(await this.stores.derived.query(`SELECT * FROM entity_claim_versions WHERE claim_id=$1 AND revision<$2 ORDER BY revision DESC LIMIT 51`,
      [claim,before??2147483647])).rows,versions=[];
    const binding=await this.access.guards.state();
    for(const row of rows.slice(0,50))if((await Promise.all((row.evidence as SourceReference[]).map(ref=>this.access.canRead(principal,ref,binding)))).every(Boolean))versions.push(row);
    return {versions,next:rows.length>50?rows[49].revision:null};
  }
  async connected(principal:Reader,query:string,limit=12) {
    const corpus=query.trim().toLocaleLowerCase(),first=await this.list(principal),matches=first.entities
      .filter(entity=>corpus.includes(entity.name.trim().toLocaleLowerCase())).sort((a,b)=>b.name.length-a.name.length||a.id.localeCompare(b.id));
    const names=new Map<string,MemoryEntity[]>();for(const entity of matches){const name=entity.name.trim().toLocaleLowerCase(),group=names.get(name)??[];group.push(entity);names.set(name,group);}
    const ambiguities=[...names.entries()].filter(([,entities])=>entities.length>1).map(([name,entities])=>({name,entity_ids:entities.map(entity=>entity.id)}));
    const connected=await this.connectedFrom(principal,matches.slice(0,3).map(entity=>entity.id),limit);
    return {...connected,ambiguities,partial:connected.partial||!!first.next||matches.length>3};
  }
  async connectedFrom(principal:Reader,seedIds:string[],limit=12) {
    const seeds=[];for(const id of [...new Set(seedIds)].slice(0,3)){const entity=await this.row(id);if(await this.visible(principal,entity))seeds.push(entity);}
    const seen=new Set(seeds.map(entity=>entity.id));
    const queue=seeds.map(entity=>({entity,path:[entity.name],depth:0})),results:Array<{entity:MemoryEntity;path:string[]}>=[];let partial=false;
    while(queue.length&&results.length<limit) {
      const current=queue.shift()!;results.push({entity:current.entity,path:current.path});if(current.depth>=3)continue;
      const memory=await this.readableClaims(principal,current.entity.id);
      partial ||= memory.partial;
      for(const claim of memory.claims) {
        const other=claim.subject_entity_id===current.entity.id?claim.object_entity_id:claim.subject_entity_id;
        if(!other||seen.has(other))continue;
        const entity=await this.row(other);if(entity.state!=='active'||!await this.visible(principal,entity))continue;
        seen.add(other);queue.push({entity,path:[...current.path,`${claim.relationship_kind??claim.predicate}: ${entity.name}`],depth:current.depth+1});
      }
    }
    return {entities:results,partial:partial||queue.length>0};
  }
  async list(principal:Reader,input:{query?:string;kind?:string;after?:string;state?:string}={}) {
    const query=String(input.query??'').trim().toLocaleLowerCase(),kind=input.kind??'',after=input.after??'',state=input.state??'active';
    if(kind&&!['person','project'].includes(kind))throw new HttpError(400,'invalid_entity_kind');
    if(!['active','all'].includes(state)||state==='all'&&!principal.admin)throw new HttpError(400,'invalid_entity_state');
    const entities:MemoryEntity[]= [];let cursor=after;
    while(entities.length<100) {
      const rows=(await this.stores.control.query(`SELECT * FROM memory_entities WHERE id>$1 AND ($4='all' OR state='active') AND ($2='' OR kind=$2)
        AND ($3='' OR lower(name) LIKE '%'||$3||'%') ORDER BY id LIMIT 101`,[cursor,kind,query,state])).rows;
      const page=rows.slice(0,100);if(!page.length)return {entities,next:null};
      for(let index=0;index<page.length;index++) {
        const row=page[index] as MemoryEntity;cursor=row.id;
        if(await this.visible(principal,row))entities.push(row);
        if(entities.length===100)return {entities,next:index<page.length-1||rows.length>100?cursor:null};
      }
      if(rows.length<=100)return {entities,next:null};
    }
    return {entities,next:cursor};
  }
  async suggestions(principal:Reader,after=''){admin(principal);const rows=(await this.stores.control.query("SELECT * FROM memory_entity_suggestions WHERE status='pending' AND id>$1 ORDER BY id LIMIT 101",[after])).rows;return {suggestions:rows.slice(0,100),next:rows.length>100?rows[99].id:null};}
}

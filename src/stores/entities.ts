import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import type {SourceReference} from './archive.js';
import type {SourceAccessRepository} from './access.js';
import type {StorePools} from './connections.js';
import type {GuardBinding} from './guards.js';
import {OwnerCommands} from './owner-commands.js';
import type {Project,ProjectRepository} from './projects.js';
import type {PreparedLearningContext} from './learning-context.js';
import {resultItems,withoutNulls,type LearningRejection} from '../interpretations.js';

const protocol='nocheh-connected-entities-v1';
export type EntityKind='person'|'project';
export type RelationshipKind='contextual'|'participates'|'responsible'|'depends_on'|'associated';
const relationshipKinds=['contextual','participates','responsible','depends_on','associated'];
export interface MemoryEntity {id:string;kind:EntityKind;name:string;state:'active'|'merged'|'rejected';project_id:string|null;merged_into:string|null;revision:number}
export interface EntityContext {speaker:MemoryEntity|null;project:MemoryEntity|null;mentioned_projects:MemoryEntity[];mentioned_people:MemoryEntity[];session_id:string}
/** People already known to a learning turn: the owner, and everyone else who wrote its evidence. */
export interface KnownPeople {owner:MemoryEntity|null;participants:MemoryEntity[]}
/** A person or project card still waiting for the owner, with every name folded into it. */
export interface WaitingSuggestion {id:string;kind:'person'|'project';name:string;also_called:string[]}
/** Cards a learning turn may see, so a new name for the same person or project joins its card. */
export interface WaitingCards {waiting?:WaitingSuggestion[]}
export interface EntityClaimInput {
 subject_id:string;predicate:string;content:string;object_entity_id?:string;relationship_kind?:RelationshipKind;
 attribution:'direct'|'reported'|'inferred';speaker_entity_id?:string;uncertainty:'uncertain'|'supported'|'explicit';evidence:SourceReference[];
}

const entityId=(value:unknown):string=>{const id=string(value,64);if(!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'invalid_entity_id');return id;};
export function attributedSpeaker(attribution:'direct'|'reported'|'inferred',subject:string,supplied:string|undefined,trusted:string|undefined):string|undefined {
  // A direct claim about the actual source speaker can omit a redundant speaker ID.
  // Never replace a conflicting explicit ID or infer who reported another subject.
  const speaker=supplied??(attribution==='direct'&&subject===trusted?trusted:undefined);
  if(attribution==='direct'&&(!speaker||speaker!==subject||speaker!==trusted)||
    attribution==='reported'&&(!speaker||speaker!==trusted))throw new HttpError(422,'entity_attribution_mismatch');
  return speaker;
}
const revision=(value:unknown):number=>{if(!Number.isSafeInteger(value)||Number(value)<0)throw new HttpError(400,'invalid_revision');return Number(value);};
const exact=(value:unknown,keys:string[])=>{const row=object(value);if(Object.keys(row).some(key=>!keys.includes(key)))throw new HttpError(400,'unknown_entity_field');return row;};
const participantName=(payload:unknown,fallback:string):string=>{
  try {
    const value=JSON.parse(Buffer.isBuffer(payload)?payload.toString():String(payload)),message=value.message??value.edited_message??value.channel_post??value.edited_channel_post??value;
    // A reaction update names its actor as message_reaction.user.
    const actor=message?.from??message?.sender??value.from??value.message_reaction?.user;
    if(!actor||typeof actor!=='object')return fallback;
    const part=(name:string)=>typeof actor[name]==='string'?actor[name].trim().slice(0,100):'';
    const name=[part('first_name'),part('last_name')].filter(Boolean).join(' ').trim()||part('username');
    return name.slice(0,200)||fallback;
  } catch{return fallback;}
};

const isBot=(payload:unknown):boolean=>{
  try {
    const value=JSON.parse(Buffer.isBuffer(payload)?payload.toString():String(payload)),message=value.message??value.edited_message??value.channel_post??value.edited_channel_post??value;
    return (message?.from??value.message_reaction?.user)?.is_bot===true;
  } catch{return false;}
};
/** A suggested name compared with another: case, an @ and a trailing "(…)", such as a username or
 * another spelling, never make someone or something new. */
export const nameKey=(name:string)=>name.replace(/\([^)]*\)\s*$/,'').replace(/^@/,'').trim().toLocaleLowerCase();

const projectEntityId=(projectId:string)=>digest(canonical([protocol,'project',projectId]));
export const honchoPeerId=(entity:Pick<MemoryEntity,'kind'|'id'>):string=>`${entity.kind}_${entity.id}`;
export const evidencePeerId=(source:SourceReference):string=>`evidence_${digest(canonical(['nocheh-connected-evidence-v1',source.id])).slice(0,48)}`;

export interface FoldedName {id:string;name:string;reason:string;revision:number;source_reference:SourceReference;created_at:string|null}
/** The names folded into each waiting person or project card, oldest first. */
export async function foldedNames(control:Pick<StorePools['control'],'query'>,ids:string[]):Promise<Map<string,FoldedName[]>> {
  const names=new Map<string,FoldedName[]>();if(!ids.length)return names;
  for(const row of (await control.query(`SELECT id,name,reason,revision,source_reference,created_at,merged_into FROM memory_entity_suggestions
    WHERE merged_into=ANY($1::text[]) AND status='pending' ORDER BY created_at,id`,[ids])).rows) {
    const list=names.get(row.merged_into)??[];
    list.push({id:row.id,name:row.name,reason:row.reason,revision:Number(row.revision),source_reference:row.source_reference,
      created_at:row.created_at instanceof Date?row.created_at.toISOString():row.created_at??null});
    names.set(row.merged_into,list);
  }
  return names;
}
/** Canonical identities live in control; source evidence and inferred claims remain in their owned stores. */
/** The conversation object a source's Honcho session follows: its topic, else its chat. */
export async function conversationObject(archive:Pick<StorePools['archive'],'query'>,eventId:string):Promise<string|undefined> {
  const own=(await archive.query(`SELECT o.id,r.kind FROM source_relations r JOIN source_objects o ON o.id=r.target_id
    WHERE r.event_id=$1 AND r.kind IN ('contained_in','in_thread') ORDER BY CASE r.kind WHEN 'in_thread' THEN 0 ELSE 1 END,o.id`,[eventId])).rows;
  if(own[0]?.kind==='in_thread')return own[0].id;
  // A reaction update names no topic. Like its audience, it follows the message it
  // reacts to, so it lands in that topic's session; contradictory topics fall back to the chat.
  const topics=(await archive.query(`SELECT DISTINCT thread.target_id AS id FROM source_relations target
    JOIN source_revisions revision ON revision.object_id=target.target_id JOIN source_observations observation ON observation.revision_id=revision.id
    JOIN source_relations thread ON thread.event_id=observation.event_id AND thread.kind='in_thread'
    WHERE target.event_id=$1 AND target.kind='reaction_to'`,[eventId])).rows;
  return topics.length===1?topics[0].id:own[0]?.id;
}

export class EntityRepository {
  private readonly commands:OwnerCommands;
  constructor(readonly stores:StorePools,readonly access:SourceAccessRepository,readonly projects:ProjectRepository){this.commands=new OwnerCommands(stores.control);}

  private async row(id:string):Promise<MemoryEntity> {
    const row=(await this.stores.control.query('SELECT * FROM memory_entities WHERE id=$1',[entityId(id)])).rows[0];
    if(!row)throw new HttpError(404,'entity_not_found');return row;
  }
  async ensureProject(project:Project):Promise<MemoryEntity> {
    // A project has one entity, whichever path made it first: a confirmed card or this one.
    const id=(await this.stores.control.query(`INSERT INTO memory_entities(id,kind,name,state,project_id)
      VALUES($1,'project',$2,'active',$3) ON CONFLICT(project_id) WHERE project_id IS NOT NULL DO UPDATE SET name=$2,updated_at=now() RETURNING id`,
      [projectEntityId(project.id),project.name,project.id])).rows[0].id;
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
    return found.length===1?this.ensureIdentity(found[0]):null;
  }
  private async ensureIdentity(identity:{id:string;platform:string;kind:string;external_id:string;payload:unknown}):Promise<MemoryEntity|null> {
    const id=digest(canonical([protocol,'person',identity.id])),binding=digest(canonical([protocol,'source-binding',identity.id]));
    const linked=(await this.stores.control.query('SELECT entity_id,state FROM memory_entity_bindings WHERE id=$1',[binding])).rows[0];
    const known=participantName(identity.payload,''),name=known||`${identity.platform} ${identity.kind} ${identity.external_id}`;
    // Only an untouched exact platform identity follows platform display names, and only to a name
    // the update supplies. Owner renames and confirmed or moved bindings retain their chosen identity.
    if(!linked||linked.entity_id===id&&linked.state==='exact')await this.stores.control.query(`INSERT INTO memory_entities(id,kind,name,state)
      VALUES($1,'person',$2,'active') ON CONFLICT(id) DO UPDATE SET name=$2,updated_at=now()
      WHERE $4::boolean AND memory_entities.revision=1 AND memory_entities.state='active' AND NOT EXISTS
        (SELECT 1 FROM memory_entity_bindings WHERE id=$3 AND (state<>'exact' OR entity_id<>$1))`,[id,name,binding,!!known]);
    if(!linked)await this.stores.control.query(`INSERT INTO memory_entity_bindings(id,entity_id,binding_kind,source_object_id,label,state)
      VALUES($1,$2,'source_identity',$3,$4,'exact') ON CONFLICT(id) DO NOTHING`,[binding,id,identity.id,name]);
    const current=(await this.stores.control.query(`SELECT e.* FROM memory_entity_bindings b JOIN memory_entities e ON e.id=b.entity_id
      WHERE b.id=$1 AND b.state IN ('exact','confirmed') AND e.state='active'`,[binding])).rows[0];
    return current??null;
  }
  /** The owner's own Telegram account and the other authors of the evidence are known people,
   * so learning links them by ID instead of asking the owner to remember them again. */
  async knownPeople(references:SourceReference[],speaker:MemoryEntity|null):Promise<KnownPeople> {
    const ownerId=this.access.policy().owner_id;
    const owned=ownerId?(await this.stores.archive.query(`SELECT o.id,o.platform,o.namespace,o.kind,o.external_id,e.payload FROM source_objects o
      JOIN source_relations r ON r.target_id=o.id AND r.kind='authored_by' JOIN events e ON e.id=r.event_id
      WHERE o.platform='telegram' AND o.namespace='bot-api' AND o.kind='actor' AND o.external_id=$1 ORDER BY e.capture_sequence DESC LIMIT 1`,[ownerId])).rows[0]:undefined;
    const owner=owned?await this.ensureIdentity(owned):null;
    // A message an assistant wrote names the bot, which is not a person to remember.
    const authors=(await this.stores.archive.query(`SELECT DISTINCT ON (o.id) o.id,o.platform,o.namespace,o.kind,o.external_id,e.payload FROM source_relations r
      JOIN source_objects o ON o.id=r.target_id JOIN events e ON e.id=r.event_id
      WHERE r.event_id=ANY($1::text[]) AND r.kind='authored_by' AND o.kind='actor' ORDER BY o.id,e.capture_sequence DESC LIMIT 31`,[references.map(ref=>ref.id)])).rows;
    const participants:MemoryEntity[]=[],seen=new Set([owner?.id,speaker?.id]);
    for(const identity of authors.slice(0,30)) {
      if(isBot(identity.payload))continue;
      const entity=await this.ensureIdentity(identity);
      if(entity&&!seen.has(entity.id)){seen.add(entity.id);participants.push(entity);}
    }
    return {owner,participants};
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
    const conversation=await conversationObject(this.stores.archive,source.id);
    return {speaker,project,mentioned_projects:mentionedProjects,mentioned_people:mentionedPeople,
      session_id:digest(canonical([protocol,'conversation',conversation??space??source.id]))};
  }
  async suggest(kind:'person'|'project'|'binding',name:string,source:SourceReference,reason:string,candidate?:string,sameAs?:string) {
    const clean=string(name,200).trim();if(!clean)throw new HttpError(400,'invalid_entity_name');
    // One question per name: later evidence for the same suggestion, pending or already
    // decided, never adds another card. The first evidence stays as its example.
    const id=digest(canonical([protocol,'suggestion',kind,clean.toLocaleLowerCase(),candidate??null]));
    if(kind==='binding') {
      await this.stores.control.query(`INSERT INTO memory_entity_suggestions(id,kind,name,candidate_entity_id,source_reference,reason)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,[id,kind,clean,candidate??null,source,reason]);
      return (await this.stores.control.query('SELECT * FROM memory_entity_suggestions WHERE id=$1',[id])).rows[0];
    }
    // Another name for a person or project already waiting joins that card, so one answer covers every name.
    // The card stays locked until the name is saved, so an answer or a fold cannot land in between.
    return this.transaction(async db=>{
      const known=(await db.query('SELECT * FROM memory_entity_suggestions WHERE id=$1',[id])).rows[0];if(known)return known;
      const into=await this.waitingCard(db,kind,clean,id,candidate??null,sameAs);
      const added=(await db.query(`INSERT INTO memory_entity_suggestions(id,kind,name,candidate_entity_id,source_reference,reason,merged_into)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING merged_into`,[id,kind,clean,candidate??null,source,reason,into])).rows[0];
      if(added?.merged_into)await db.query('UPDATE memory_entity_suggestions SET revision=revision+1,updated_at=now() WHERE id=$1',[added.merged_into]);
      return (await db.query('SELECT * FROM memory_entity_suggestions WHERE id=$1',[id])).rows[0];
    });
  }
  /** The waiting card a new name joins, locked: the card learning named, else the oldest card with a name that
   * is the same apart from case, an @ or a trailing "(…)". Both must be the same kind and point at the same known
   * entity. A card answered or folded meanwhile is followed to where it went, or the name waits as its own card. */
  private async waitingCard(db:import('pg').PoolClient,kind:'person'|'project',name:string,id:string,candidate:string|null,sameAs?:string):Promise<string|null> {
    const key=nameKey(name);
    for(let attempt=0;attempt<3;attempt++) {
      const named=sameAs?(await db.query(`SELECT coalesce(merged_into,id) AS card FROM memory_entity_suggestions
        WHERE id=$1 AND kind=$2 AND status='pending' AND candidate_entity_id IS NOT DISTINCT FROM $3`,[sameAs,kind,candidate])).rows[0]:undefined;
      // The same key as nameKey(): a trailing "(…)" and a leading @ removed, then trimmed and lower-cased.
      const matched=named??(key?(await db.query(`SELECT coalesce(merged_into,id) AS card FROM memory_entity_suggestions
        WHERE kind=$1 AND status='pending' AND id<>$2 AND candidate_entity_id IS NOT DISTINCT FROM $3
          AND lower(btrim(regexp_replace(regexp_replace(name,$5,''),'^@','')))=$4 ORDER BY created_at,id LIMIT 1`,
        [kind,id,candidate,key,'\\([^)]*\\)\\s*$'])).rows[0]:undefined);
      if(!matched)return null;
      const card=(await db.query(`SELECT id FROM memory_entity_suggestions WHERE id=$1 AND kind=$2 AND status='pending' AND merged_into IS NULL
        AND candidate_entity_id IS NOT DISTINCT FROM $3 FOR UPDATE`,[matched.card,kind,candidate])).rows[0];
      if(card)return card.id;
    }
    return null;
  }
  private async transaction<T>(change:(db:import('pg').PoolClient)=>Promise<T>):Promise<T> {
    const db=await this.stores.control.connect();
    try{await db.query('BEGIN');const result=await change(db);await db.query('COMMIT');return result;}
    catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  /** The owner says a waiting card is the same person or project as another waiting card. Its names, and
   * any already folded into it, then wait on that card. Nothing is remembered or linked until the owner
   * answers that card, so this changes no memory and starts no memory refresh. */
  async fold(principal:Reader,id:string,input:unknown) {
    admin(principal);const body=exact(input,['target_id','expected_revision','operation_id']),source=entityId(id),target=entityId(body.target_id),expected=revision(body.expected_revision);
    if(source===target)throw new HttpError(400,'entity_suggestion_fold_self');
    return this.transaction(async db=>{
      // Cards are locked before the names folded into them, as decide and split do, so these never deadlock.
      const rows=(await db.query('SELECT * FROM memory_entity_suggestions WHERE id=ANY($1::text[]) ORDER BY merged_into IS NOT NULL,id FOR UPDATE',[[source,target]])).rows;
      const from=rows.find(row=>row.id===source),to=rows.find(row=>row.id===target);
      if(!from||!to)throw new HttpError(404,'entity_suggestion_not_found');
      if(from.merged_into===target&&from.status==='pending')return {id:source,merged_into:target,revision:from.revision};
      if(from.revision!==expected)throw new HttpError(409,'entity_suggestion_conflict');
      if(from.status!=='pending'||to.status!=='pending'||from.merged_into||to.merged_into||from.kind!==to.kind||from.kind==='binding')
        throw new HttpError(409,'entity_suggestion_fold_invalid');
      await db.query("UPDATE memory_entity_suggestions SET merged_into=$2,revision=revision+1,updated_at=now() WHERE merged_into=$1 OR id=$1",[source,target]);
      await db.query('UPDATE memory_entity_suggestions SET revision=revision+1,updated_at=now() WHERE id=$1',[target]);
      return {id:source,merged_into:target,revision:expected+1};
    });
  }
  /** The owner takes a folded name back out: it waits as its own card again. */
  async split(principal:Reader,id:string,input:unknown) {
    admin(principal);const body=exact(input,['expected_revision','operation_id']),source=entityId(id),expected=revision(body.expected_revision);
    return this.transaction(async db=>{
      const card=(await db.query('SELECT merged_into FROM memory_entity_suggestions WHERE id=$1',[source])).rows[0];
      if(!card)throw new HttpError(404,'entity_suggestion_not_found');
      // The card is locked before its folded name, as decide and fold do, so these never deadlock.
      if(card.merged_into)await db.query('SELECT 1 FROM memory_entity_suggestions WHERE id=$1 FOR UPDATE',[card.merged_into]);
      const row=(await db.query('SELECT * FROM memory_entity_suggestions WHERE id=$1 FOR UPDATE',[source])).rows[0];
      if(!row.merged_into&&row.status==='pending'&&row.revision===expected+1)return {id:source,merged_into:null,revision:row.revision};
      if(row.revision!==expected||row.merged_into!==card.merged_into)throw new HttpError(409,'entity_suggestion_conflict');
      if(!row.merged_into||row.status!=='pending')throw new HttpError(409,'entity_suggestion_split_invalid');
      await db.query('UPDATE memory_entity_suggestions SET revision=revision+1,updated_at=now() WHERE id=$1',[row.merged_into]);
      await db.query('UPDATE memory_entity_suggestions SET merged_into=NULL,revision=revision+1,updated_at=now() WHERE id=$1',[source]);
      return {id:source,merged_into:null,revision:expected+1};
    });
  }
  /** Names folded into each card, oldest first. */
  folded(ids:string[]){return foldedNames(this.stores.control,ids);}
  /** Person and project cards still waiting, newest first, with the names folded into them. A learning turn
   * sees only cards, and folded names, whose evidence its conversation may both read and learn from. Cards
   * are read page by page until `limit` such cards are found, so other chats' cards never crowd them out;
   * `partial` says only that this conversation has more. At most `scan` cards are checked per turn. */
  async waiting(principal:Reader,binding:GuardBinding,limit=20,scan=500):Promise<{waiting:WaitingSuggestion[];partial:boolean}> {
    // A card whose evidence is gone or changed is left out rather than stopping the turn's learning.
    const allowed=async(reference:SourceReference)=>{
      try{return await this.access.canLearn(reference,binding)&&await this.access.canRead(principal,reference,binding);}
      catch(error){if(error instanceof HttpError&&['source_not_found','source_reference_conflict','invalid_source_reference'].includes(error.code))return false;throw error;}
    };
    const cards:WaitingSuggestion[]=[];let after:{cursor_at:string;id:string}|null=null,checked=0;
    while(checked<scan) {
      const rows:{id:string;kind:'person'|'project';name:string;source_reference:SourceReference;cursor_at:string}[]=(await this.stores.control.query(`SELECT id,kind,name,source_reference,created_at::text AS cursor_at FROM memory_entity_suggestions
        WHERE status='pending' AND merged_into IS NULL AND kind IN ('person','project') AND ($1::timestamptz IS NULL OR (created_at,id)<($1,$2))
        ORDER BY created_at DESC,id DESC LIMIT 100`,[after?.cursor_at??null,after?.id??''])).rows;
      if(!rows.length)break;
      const folded=await this.folded(rows.map(row=>row.id));
      for(const row of rows) {
        checked++;after={cursor_at:row.cursor_at,id:row.id};
        if(!await allowed(row.source_reference))continue;
        if(cards.length===limit)return {waiting:cards,partial:true};
        const also=[];for(const name of folded.get(row.id)??[])if(await allowed(name.source_reference))also.push(name.name);
        cards.push({id:row.id,kind:row.kind,name:row.name,also_called:also.slice(0,10)});
      }
      if(rows.length<100)break;
    }
    return {waiting:cards,partial:false};
  }
  /** Names the owner confirmed for each project, so a message that uses only one of them still finds it. */
  async projectAliases(projectIds:string[]):Promise<Map<string,string[]>> {
    const aliases=new Map<string,string[]>();if(!projectIds.length)return aliases;
    for(const row of (await this.stores.control.query(`SELECT e.project_id,b.mention_key FROM memory_entity_bindings b JOIN memory_entities e ON e.id=b.entity_id
      WHERE e.kind='project' AND e.state='active' AND e.project_id=ANY($1::text[]) AND b.binding_kind='mention' AND b.state='confirmed' ORDER BY b.id LIMIT 1000`,[projectIds])).rows) {
      const list=aliases.get(row.project_id)??[];list.push(String(row.mention_key));aliases.set(row.project_id,list);
    }
    return aliases;
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
      // A folded name is answered on its card; the answer covers every name folded into it.
      if(suggestion.merged_into)throw new HttpError(409,'entity_suggestion_folded');
      const folded=(await db.query("SELECT * FROM memory_entity_suggestions WHERE merged_into=$1 AND status='pending' ORDER BY created_at,id FOR UPDATE",[suggestionId])).rows;
      let entity:MemoryEntity|null=null;
      if(decision==='confirm') {
        if(target) {
          entity=(await db.query('SELECT * FROM memory_entities WHERE id=$1',[target])).rows[0]??null;
          if(!entity||entity.state!=='active')throw new HttpError(409,'active_entity_required');
          if(suggestion.kind!=='binding'&&entity.kind!==suggestion.kind)throw new HttpError(409,'entity_kind_mismatch');
        }
        else {
          if(suggestion.kind==='binding')throw new HttpError(400,'entity_target_required');
          const kind=suggestion.kind as EntityKind,projectId=kind==='project'?digest(canonical([protocol,'suggested-project',suggestion.id])):null;
          // A project's entity has the same ID however it was made, so later learning reuses this one.
          const created=projectId?projectEntityId(projectId):digest(canonical([protocol,kind,'confirmed',suggestion.id]));
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
            // Every name shown on the card, exactly as shown, finds this entity later.
            const mentions=new Map<string,string>();
            for(const named of [suggestion,...folded]){const mention=String(named.name).trim().toLocaleLowerCase();if(mention&&!mentions.has(mention))mentions.set(mention,named.name);}
            for(const [mention,label] of mentions) {
              const binding=digest(canonical([protocol,'confirmed-mention',entity.id,mention]));
              await db.query(`INSERT INTO memory_entity_bindings(id,entity_id,binding_kind,mention_key,label,state)
                VALUES($1,$2,'mention',$3,$4,'confirmed') ON CONFLICT(id) DO UPDATE SET state='confirmed',revision=memory_entity_bindings.revision+1,updated_at=now()`,
                [binding,entity.id,mention,label]);
            }
          }
        }
      }
      const status=decision==='confirm'?'confirmed':'rejected';
      await db.query('UPDATE memory_entity_suggestions SET status=$2,revision=revision+1,updated_at=now() WHERE id=$1 OR merged_into=$1 AND status=\'pending\'',
        [suggestionId,status]);
      return {id:suggestionId,status,entity,...(folded.length?{folded:folded.map(row=>row.id)}:{})};
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
  async rename(principal:Reader,id:string,input:unknown) {
    admin(principal);const body=exact(input,['name','expected_revision','operation_id']),target=entityId(id),expected=revision(body.expected_revision),name=string(body.name,200).trim();
    if(!name)throw new HttpError(400,'invalid_entity_name');
    return this.commands.run(principal,string(body.operation_id,200),{kind:'entity_rename',target,expected,name},async db=>{
      const row=(await db.query('SELECT * FROM memory_entities WHERE id=$1 FOR UPDATE',[target])).rows[0];
      if(!row)throw new HttpError(404,'entity_not_found');if(row.revision!==expected)throw new HttpError(409,'entity_revision_conflict');
      if(row.kind!=='person'||row.state!=='active')throw new HttpError(409,'entity_rename_invalid');
      await db.query('UPDATE memory_entities SET name=$2,revision=revision+1,updated_at=now() WHERE id=$1',[target,name]);
      return {id:target,name,revision:expected+1};
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
        if(prior?.author==='owner'&&author!=='owner') {
          await db.query('COMMIT');return {id:claim,revision:Number(current.active_revision)};
        }
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
    // Contexts saved before known people were added carry neither field.
    const value=object(input),known=[context.entities.speaker,context.entities.project,...context.entities.mentioned_projects,...context.entities.mentioned_people,
      context.entities.owner,...(context.entities.participants??[])].filter((item):item is MemoryEntity=>!!item);
    const knownNames={person:new Set(known.filter(item=>item.kind==='person').map(item=>nameKey(item.name))),
      project:new Set(known.filter(item=>item.kind==='project').map(item=>nameKey(item.name)))};
    // A card the turn was shown as waiting; contexts saved before waiting cards were added carry none.
    const waiting=new Map(((context.entities as WaitingCards).waiting??[]).map(card=>[card.id,card.kind]));
    const knownIds=new Set(known.map(item=>item.id)),evidence=new Map(context.evidence.map(item=>[item.reference.id,item.reference])),published=[],suggestions=[],rejected:LearningRejection[]=[];
    // One invalid model item is dropped and recorded; valid items from the same result are kept.
    const checked=<T>(section:LearningRejection['section'],check:()=>T):T|undefined=>{
      try{return check();}catch(error){if(!(error instanceof HttpError))throw error;rejected.push({section,code:error.code});return undefined;}
    };
    for(const raw of resultItems(value.entity_suggestions,12,'entity_suggestions',rejected)) {
      const suggestion=checked('entity_suggestions',()=>{
        const row=exact(withoutNulls(raw),['kind','name','candidate_id','same_as','reason','evidence_ids']);
        if(!['person','project','binding'].includes(String(row.kind))||!Array.isArray(row.evidence_ids)||!row.evidence_ids.length||row.evidence_ids.length>30)
          throw new HttpError(422,'invalid_entity_suggestion');
        const references=row.evidence_ids.map(id=>{const ref=evidence.get(String(id));if(!ref)throw new HttpError(422,'entity_evidence_unavailable');return ref;});
        // A model may put a name or placeholder in candidate_id. Keep that
        // suggestion unbound; only an exact known entity ID may create a link.
        const candidate=typeof row.candidate_id==='string'&&/^[a-f0-9]{64}$/.test(row.candidate_id)?row.candidate_id:undefined;
        if(candidate&&!knownIds.has(candidate))throw new HttpError(422,'entity_candidate_unavailable');
        const name=string(row.name,200).trim();if(!name)throw new HttpError(422,'invalid_entity_name');
        if((row.kind==='person'||row.kind==='project')&&knownNames[row.kind].has(nameKey(name)))throw new HttpError(422,'entity_already_known');
        // same_as joins a waiting card of the same kind. Any other value, such as a name or an
        // unlisted card, is ignored and the suggestion stays as its own card.
        const sameAs=typeof row.same_as==='string'&&waiting.get(row.same_as)===row.kind?row.same_as:undefined;
        return {kind:row.kind as 'person'|'project'|'binding',name,source:references[0]!,reason:string(row.reason,1000),candidate,sameAs};
      });
      if(suggestion)suggestions.push(await this.suggest(suggestion.kind,suggestion.name,suggestion.source,suggestion.reason,suggestion.candidate,suggestion.sameAs));
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
    for(const raw of resultItems(value.entity_claims,20,'entity_claims',rejected)) {
      const claim=checked('entity_claims',():EntityClaimInput=>{
        const row=exact(withoutNulls(raw),['subject_id','predicate','content','object_entity_id','relationship_kind','attribution','speaker_entity_id','uncertainty','evidence_ids']);
        const subject=entityId(row.subject_id),objectId=row.object_entity_id===undefined?undefined:entityId(row.object_entity_id),suppliedSpeaker=row.speaker_entity_id===undefined?undefined:entityId(row.speaker_entity_id);
        if(!knownIds.has(subject)||objectId&&!knownIds.has(objectId)||suppliedSpeaker&&!knownIds.has(suppliedSpeaker)||!['direct','reported','inferred'].includes(String(row.attribution))||
          !['uncertain','supported','explicit'].includes(String(row.uncertainty))||!Array.isArray(row.evidence_ids)||!row.evidence_ids.length||row.evidence_ids.length>30)
          throw new HttpError(422,'invalid_entity_claim');
        // A relationship kind describes the link to an object. Models also label claims
        // without an object; that label links nothing, so the claim stays and the label is ignored.
        if(objectId&&!relationshipKinds.includes(String(row.relationship_kind)))throw new HttpError(422,'invalid_entity_relationship');
        const content=string(row.content,8000).trim(),predicate=string(row.predicate,100);if(!predicate||!content)throw new HttpError(422,'invalid_entity_claim');
        const speaker=attributedSpeaker(row.attribution as EntityClaimInput['attribution'],subject,suppliedSpeaker,context.entities.speaker?.id);
        const references=row.evidence_ids.map(id=>{const ref=evidence.get(String(id));if(!ref)throw new HttpError(422,'entity_evidence_unavailable');return ref;});
        return {subject_id:subject,predicate,content,attribution:row.attribution as EntityClaimInput['attribution'],uncertainty:row.uncertainty as EntityClaimInput['uncertainty'],evidence:references,
          ...(objectId?{object_entity_id:objectId,relationship_kind:row.relationship_kind as RelationshipKind}:{}),...(speaker?{speaker_entity_id:speaker}:{})};
      });
      if(claim)published.push(await this.publishClaim(claim,context.binding,operation+':claim:'+published.length));
    }
    return {published,suggestions,rejected};
  }
  async correct(principal:Reader,id:string,input:unknown) {
    admin(principal);const body=exact(input,['content','relationship_kind','attribution','uncertainty','retired','expected_revision','operation_id']),claim=entityId(id),expected=revision(body.expected_revision);
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
        const relationshipKind=body.relationship_kind===undefined?prior.relationship_kind:String(body.relationship_kind);
        if(entry.object_entity_id&&!relationshipKinds.includes(relationshipKind)||!entry.object_entity_id&&body.relationship_kind!==undefined)
          throw new HttpError(400,'invalid_entity_relationship');
        await db.query(`INSERT INTO entity_claim_versions(operation_id,claim_id,revision,expected_revision,content,relationship_kind,attribution,speaker_entity_id,
          uncertainty,author,retired,evidence,dependencies,input_binding) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'owner',$10,$11,$12,$13)`,
          [operation,claim,next,expected,string(body.content,8000),relationshipKind,attribution,prior.speaker_entity_id,uncertainty,body.retired,
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
  /** Waiting cards, each with the names folded into it. */
  async suggestions(principal:Reader,after='') {
    admin(principal);const rows=(await this.stores.control.query("SELECT * FROM memory_entity_suggestions WHERE status='pending' AND merged_into IS NULL AND id>$1 ORDER BY id LIMIT 101",[after])).rows;
    const page=rows.slice(0,100),folded=await this.folded(page.map(row=>row.id));
    return {suggestions:page.map(row=>({...row,also_called:folded.get(row.id)??[]})),next:rows.length>100?rows[99].id:null};
  }
}

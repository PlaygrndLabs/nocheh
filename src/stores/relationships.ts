import type pg from 'pg';
import {HttpError} from '../http.js';
import {telegramMessageAudience,type ObservedAudience,type ObservedReaction} from '../observed-source.js';
import {canonical} from '../archive.js';
import {sourceObjectId,type SourceIdentity} from '../source-model.js';
import {ArchiveRepository,type SourceReference} from './archive.js';
import {inReadSet,inRecall,observedChat,type ReadSet,type RecallScope} from '../spaces.js';

/** `recall` admits the known conversations of a recall scope: its own, or every conversation of its group when the
 * group's topics share memory. `reads` admits the known conversations of a read set, for an answer reader (ADR-0249).
 * A conversation is the Nocheh chat or topic an original's observed audience names (ADR-0252). */
export type RelationshipAudience={kind:'owner'}|{kind:'recall';scope:RecallScope}|{kind:'reads';set:ReadSet};
const permits=(audience:RelationshipAudience,chat:string|null):boolean=>audience.kind==='owner'||chat!==null&&
  (audience.kind==='reads'?inReadSet(audience.set,chat):inRecall(audience.scope,chat));

// Resolve the older adapter's unknown General projection from the immutable
// full message. This changes neither archived bytes nor the saved descriptor.
function messageAudience(row:any):ObservedAudience|null {
  const saved:ObservedAudience|null=row.metadata?.audience??null;
  if(saved?.topic_state!=='unknown'||row.adapter!=='telegram.bot-api'||row.adapter_version!=='2'||row.completeness!=='full'||
    !['snapshot','update'].includes(row.operation)||row.channel!=='telegram'||
    !['telegram_update','telegram_delivered_message'].includes(row.kind)||row.object_kind!=='message')return saved;
  const body=JSON.parse(row.payload.toString()),message=body.message??body.edited_message??body.channel_post??body.edited_channel_post;
  if(!message||String(message.chat?.id)!==saved.chat_id||row.scope!==saved.chat_id||String(message.message_id)!==row.external_id)return saved;
  const resolved=telegramMessageAudience(message,saved.chat_id);
  return resolved.topic_state==='none'?resolved:saved;
}

const observationColumns=`o.metadata,o.operation,o.adapter,o.adapter_version,o.completeness,
  e.channel,e.kind,e.scope,
  CASE WHEN o.metadata->'audience'->>'topic_state'='unknown' AND o.completeness='full' THEN e.payload END AS payload,
  s.kind AS object_kind,s.external_id`;

/** Archive-only joins. Returns references, never unguarded content or an access grant. */
export class RelationshipRepository {
  constructor(readonly archive:ArchiveRepository){}
  private get pool():pg.Pool{return this.archive.pool;}

  private async targetAudience(objectId:string):Promise<ObservedAudience|null> {
    const {rows}=await this.pool.query(`SELECT ${observationColumns} FROM source_observations o
      JOIN source_revisions r ON r.id=o.revision_id JOIN source_objects s ON s.id=r.object_id
      JOIN events e ON e.id=o.event_id WHERE r.object_id=$1`,[objectId]);
    const audiences=new Map<string,ObservedAudience>();
    for(const row of rows){const value=messageAudience(row);if(value&&value.topic_state!=='unknown')audiences.set(canonical(value),value);}
    // Contradictory membership observations are unavailable to scoped consumers.
    return audiences.size===1?[...audiences.values()][0]!:null;
  }

  /** An original's observed audience as it was captured, its reaction, its object, and `chat`: the Nocheh chat or topic
   * that audience names (observedChat), null when it is unknown or no row names it. */
  async describe(reference:SourceReference):Promise<{audience:ObservedAudience|null;reaction:ObservedReaction|null;object_id:string;chat:string|null}> {
    await this.archive.verify(reference);
    const found=(await this.describeMany([reference.id])).get(reference.id);
    if(!found)throw new HttpError(404,'source_projection_not_found');
    return found;
  }
  /** describe() for many events in one read, for ids the caller has already verified; an event with no observation is
   * left out. A reaction is described by the message it reacts to, as describe() does. */
  async describeMany(ids:readonly string[]):Promise<Map<string,{audience:ObservedAudience|null;reaction:ObservedReaction|null;object_id:string;chat:string|null}>> {
    const found=new Map<string,{audience:ObservedAudience|null;reaction:ObservedReaction|null;object_id:string;chat:string|null}>(),wanted=[...new Set(ids)];
    if(!wanted.length)return found;
    const rows=(await this.pool.query(`SELECT ${observationColumns},r.object_id,o.event_id FROM source_observations o
      JOIN source_revisions r ON r.id=o.revision_id JOIN source_objects s ON s.id=r.object_id
      JOIN events e ON e.id=o.event_id WHERE o.event_id=ANY($1::text[])`,[wanted])).rows;
    const reactions=rows.filter(row=>['reaction_change','reaction_counts'].includes(row.operation)).map(row=>row.event_id);
    const targets=new Map<string,string>();
    if(reactions.length)for(const row of (await this.pool.query("SELECT DISTINCT ON (event_id) event_id,target_id FROM source_relations WHERE event_id=ANY($1::text[]) AND kind='reaction_to' ORDER BY event_id,target_id",
      [reactions])).rows)targets.set(row.event_id,row.target_id);
    for(const row of rows) {
      let audience=messageAudience(row);
      if(['reaction_change','reaction_counts'].includes(row.operation)) {
        const target=targets.get(row.event_id),resolved=target?await this.targetAudience(target):null;
        if(resolved&&resolved.chat_id===audience?.chat_id)audience=resolved;
      }
      found.set(row.event_id,{audience,reaction:row.metadata.reaction??null,object_id:row.object_id,
        chat:audience&&audience.chat_id===row.scope?observedChat(row.channel,audience):null});
    }
    return found;
  }

  async observations(target:SourceIdentity,after='',limit=100):Promise<{references:SourceReference[];next:string|null}> {
    if(!Number.isInteger(limit)||limit<1||limit>200)throw new HttpError(400,'invalid_relationship_page');
    const {rows}=await this.pool.query(`SELECT e.id,e.revision,e.payload_hash FROM source_observations o
      JOIN source_revisions r ON r.id=o.revision_id JOIN events e ON e.id=o.event_id
      WHERE r.object_id=$1 AND e.id>$2 ORDER BY e.id LIMIT $3`,[sourceObjectId(target),after,limit+1]);
    return {references:rows.slice(0,limit).map(r=>({store:'archive',kind:'event',id:r.id,revision:r.revision,input_hash:r.payload_hash})),
      next:rows.length>limit?rows[limit-1].id:null};
  }

  async activity(target:SourceIdentity,after='',limit=100):Promise<{references:SourceReference[];next:string|null}> {
    if(!Number.isInteger(limit)||limit<1||limit>200)throw new HttpError(400,'invalid_relationship_page');
    const {rows}=await this.pool.query(`SELECT DISTINCT e.id,e.revision,e.payload_hash FROM source_relations r JOIN events e ON e.id=r.event_id
      WHERE r.target_id=$1 AND r.kind IN ('reply_to','reaction_to') AND e.id>$2 ORDER BY e.id LIMIT $3`,[sourceObjectId(target),after,limit+1]);
    return {references:rows.slice(0,limit).map(r=>({store:'archive',kind:'event',id:r.id,revision:r.revision,input_hash:r.payload_hash})),
      next:rows.length>limit?rows[limit-1].id:null};
  }

  /**
   * The messages each of these events replies to (ADR-0259): every archived copy of each reply target, oldest first, the
   * way context() finds them, in one read. Only copies whose conversation the audience admits are kept (permits): a
   * target outside it, external to the reader, is left out as context() leaves it out. An access check (canRead) is the
   * caller's, as for context().
   */
  async replyTargets(ids:readonly string[],audience:RelationshipAudience):Promise<Map<string,SourceReference[]>> {
    const found=new Map<string,SourceReference[]>(),wanted=[...new Set(ids)];
    if(!wanted.length)return found;
    const rows=(await this.pool.query(`SELECT r.event_id AS reply,e.id,e.revision,e.payload_hash FROM source_relations r
      JOIN source_revisions v ON v.object_id=r.target_id JOIN source_observations o ON o.revision_id=v.id JOIN events e ON e.id=o.event_id
      WHERE r.event_id=ANY($1::text[]) AND r.kind='reply_to' ORDER BY r.event_id,e.received_at,e.id`,[wanted])).rows;
    const chats=await this.describeMany(rows.map(row=>row.id));
    for(const row of rows) {
      if(!permits(audience,chats.get(row.id)?.chat??null))continue;
      const list=found.get(row.reply)??[];list.push({store:'archive',kind:'event',id:row.id,revision:row.revision,input_hash:row.payload_hash});found.set(row.reply,list);
    }
    return found;
  }
  /**
   * The messages that reply to an object (ADR-0259), by the archive's reply relation (source_relations, its target
   * index): each replying message once, with every copy of it the audience admits (permits), oldest first, its first
   * copy deciding the order. At most `limit` copies are read; `more` says there were others. canRead is the caller's.
   */
  async replies(objectId:string,audience:RelationshipAudience,limit=100):Promise<{replies:{object:string;references:SourceReference[]}[];more:boolean}> {
    if(!Number.isInteger(limit)||limit<1||limit>200)throw new HttpError(400,'invalid_relationship_page');
    const rows=(await this.pool.query(`SELECT e.id,e.revision,e.payload_hash,v.object_id FROM source_relations r JOIN events e ON e.id=r.event_id
      JOIN source_observations o ON o.event_id=e.id JOIN source_revisions v ON v.id=o.revision_id
      WHERE r.target_id=$1 AND r.kind='reply_to' ORDER BY e.received_at,e.id LIMIT $2`,[objectId,limit+1])).rows;
    const chats=await this.describeMany(rows.slice(0,limit).map(row=>row.id)),replies=new Map<string,SourceReference[]>();
    for(const row of rows.slice(0,limit)) {
      if(row.object_id===objectId||!permits(audience,chats.get(row.id)?.chat??null))continue;
      const list=replies.get(row.object_id)??[];list.push({store:'archive',kind:'event',id:row.id,revision:row.revision,input_hash:row.payload_hash});replies.set(row.object_id,list);
    }
    return {replies:[...replies].map(([object,references])=>({object,references})),more:rows.length>limit};
  }

  /** This scope filter is also intersected with the control repository's consent/access policy by callers. */
  async context(reference:SourceReference,audience:RelationshipAudience,limit=100):Promise<{
    source:SourceReference|null;targets:{kind:string;identity:SourceIdentity;references:SourceReference[];unresolved:boolean;next:string|null}[];
  }> {
    const observed=await this.describe(reference);
    if(!permits(audience,observed.chat))return {source:null,targets:[]};
    const rows=await this.pool.query(`SELECT r.kind,o.platform,o.namespace,o.kind AS target_kind,o.external_id FROM source_relations r
      JOIN source_objects o ON o.id=r.target_id WHERE r.event_id=$1 AND r.kind IN ('reply_to','reaction_to') ORDER BY r.kind,o.id`,[reference.id]);
    const targets=[];
    for(const row of rows.rows) {
      const identity:SourceIdentity={platform:row.platform,namespace:row.namespace,kind:row.target_kind,external_id:row.external_id};
      const page=await this.observations(identity,'',limit),references=[];
      for(const candidate of page.references)if(permits(audience,(await this.describe(candidate)).chat))references.push(candidate);
      // External targets are not exposed to an unauthorized conversation, even as existence metadata.
      if(audience.kind!=='owner'&&!references.length)continue;
      targets.push({kind:row.kind,identity,references,unresolved:page.references.length===0,next:page.next});
    }
    return {source:reference,targets};
  }
}

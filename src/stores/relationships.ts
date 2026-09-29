import type pg from 'pg';
import {HttpError} from '../http.js';
import {telegramMessageAudience,type ObservedAudience,type ObservedReaction} from '../observed-source.js';
import {canonical} from '../archive.js';
import {sourceObjectId,type SourceIdentity} from '../source-model.js';
import {ArchiveRepository,type SourceReference} from './archive.js';

export type RelationshipAudience={kind:'owner'}|{kind:'conversation';chat_id:string;topic_id:string|null};
const permits=(audience:RelationshipAudience,observed:ObservedAudience|null):boolean=>audience.kind==='owner'||!!observed&&
  audience.chat_id===observed.chat_id&&(observed.topic_state==='known'?audience.topic_id===observed.topic_id:observed.topic_state==='none'&&audience.topic_id===null);

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

  async describe(reference:SourceReference):Promise<{audience:ObservedAudience|null;reaction:ObservedReaction|null;object_id:string}> {
    await this.archive.verify(reference);
    const row=(await this.pool.query(`SELECT ${observationColumns},r.object_id FROM source_observations o
      JOIN source_revisions r ON r.id=o.revision_id JOIN source_objects s ON s.id=r.object_id
      JOIN events e ON e.id=o.event_id WHERE o.event_id=$1`,[reference.id])).rows[0];
    if(!row)throw new HttpError(404,'source_projection_not_found');
    let audience=messageAudience(row);
    if(['reaction_change','reaction_counts'].includes(row.operation)) {
      const target=(await this.pool.query("SELECT target_id FROM source_relations WHERE event_id=$1 AND kind='reaction_to'",[reference.id])).rows[0];
      const resolved=target?await this.targetAudience(target.target_id):null;
      if(resolved&&resolved.chat_id===audience?.chat_id)audience=resolved;
    }
    return {audience,reaction:row.metadata.reaction??null,object_id:row.object_id};
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

  /** This scope filter is also intersected with the control repository's consent/access policy by callers. */
  async context(reference:SourceReference,audience:RelationshipAudience,limit=100):Promise<{
    source:SourceReference|null;targets:{kind:string;identity:SourceIdentity;references:SourceReference[];unresolved:boolean;next:string|null}[];
  }> {
    const observed=await this.describe(reference);
    if(!permits(audience,observed.audience))return {source:null,targets:[]};
    const rows=await this.pool.query(`SELECT r.kind,o.platform,o.namespace,o.kind AS target_kind,o.external_id FROM source_relations r
      JOIN source_objects o ON o.id=r.target_id WHERE r.event_id=$1 AND r.kind IN ('reply_to','reaction_to') ORDER BY r.kind,o.id`,[reference.id]);
    const targets=[];
    for(const row of rows.rows) {
      const identity:SourceIdentity={platform:row.platform,namespace:row.namespace,kind:row.target_kind,external_id:row.external_id};
      const page=await this.observations(identity,'',limit),references=[];
      for(const candidate of page.references)if(permits(audience,(await this.describe(candidate)).audience))references.push(candidate);
      // External targets are not exposed to an unauthorized conversation, even as existence metadata.
      if(audience.kind!=='owner'&&!references.length)continue;
      targets.push({kind:row.kind,identity,references,unresolved:page.references.length===0,next:page.next});
    }
    return {source:reference,targets};
  }
}

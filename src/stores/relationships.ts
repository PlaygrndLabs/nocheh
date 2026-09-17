import type pg from 'pg';
import {HttpError} from '../http.js';
import type {ObservedAudience,ObservedReaction} from '../observed-source.js';
import {sourceObjectId,type SourceIdentity} from '../source-model.js';
import {ArchiveRepository,type SourceReference} from './archive.js';

export type RelationshipAudience={kind:'owner'}|{kind:'conversation';chat_id:string;topic_id:string|null};
const permits=(audience:RelationshipAudience,observed:ObservedAudience|null):boolean=>audience.kind==='owner'||!!observed&&
  audience.chat_id===observed.chat_id&&(observed.topic_state==='known'?audience.topic_id===observed.topic_id:observed.topic_state==='none'&&audience.topic_id===null);

/** Archive-only joins. Returns references, never unguarded content or an access grant. */
export class RelationshipRepository {
  constructor(readonly archive:ArchiveRepository){}
  private get pool():pg.Pool{return this.archive.pool;}

  private async targetAudience(objectId:string):Promise<ObservedAudience|null> {
    const {rows}=await this.pool.query(`SELECT DISTINCT o.metadata->'audience' AS audience FROM source_observations o
      JOIN source_revisions r ON r.id=o.revision_id WHERE r.object_id=$1
      AND o.metadata->'audience'->>'topic_state' IN ('known','none') LIMIT 2`,[objectId]);
    // Contradictory membership observations are unavailable to scoped consumers.
    return rows.length===1?rows[0].audience:null;
  }

  async describe(reference:SourceReference):Promise<{audience:ObservedAudience|null;reaction:ObservedReaction|null;object_id:string}> {
    await this.archive.verify(reference);
    const row=(await this.pool.query(`SELECT o.metadata,o.operation,r.object_id FROM source_observations o
      JOIN source_revisions r ON r.id=o.revision_id WHERE o.event_id=$1`,[reference.id])).rows[0];
    if(!row)throw new HttpError(404,'source_projection_not_found');
    let audience:ObservedAudience|null=row.metadata.audience??null;
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

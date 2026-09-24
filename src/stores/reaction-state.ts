import type pg from 'pg';
import type {ArchiveRepository,SourceReference} from './archive.js';
import {requestWorkflow} from '../workflows/store.js';

export const reactionStateSchema=`
CREATE TABLE IF NOT EXISTS reaction_states (
 target_id text NOT NULL,actor_id text NOT NULL,mode text NOT NULL CHECK(mode IN ('individual','aggregate')),
 update_id bigint NOT NULL,event_id text NOT NULL,value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(target_id,actor_id,mode)
);
`;

/** Current state is indexed in control; every delivered update remains immutable in archive. */
export class ReactionStateRepository {
  constructor(readonly archive:ArchiveRepository,readonly control:pg.Pool){}
  private async observation(eventId:string) {
    return (await this.archive.pool.query(`SELECT o.operation,o.metadata->'reaction' AS reaction,
      target.target_id,coalesce(actor.target_id,'') AS actor_id
      FROM source_observations o
      JOIN source_relations target ON target.event_id=o.event_id AND target.kind='reaction_to'
      LEFT JOIN source_relations actor ON actor.event_id=o.event_id AND actor.kind='authored_by'
      WHERE o.event_id=$1`,[eventId])).rows[0];
  }
  async capture(db:pg.PoolClient,reference:SourceReference):Promise<void> {
    const row=await this.observation(reference.id);
    if(!row||!['reaction_change','reaction_counts'].includes(row.operation))return;
    const reaction=row.reaction,sequence=Number(reaction?.sequence),mode=row.operation==='reaction_counts'?'aggregate':'individual';
    if(!Number.isSafeInteger(sequence)||sequence<0||mode==='individual'&&!row.actor_id)return;
    const value=mode==='aggregate'?reaction.counts:reaction.after;
    if(value===null)return;
    const changed=await db.query(`INSERT INTO reaction_states(target_id,actor_id,mode,update_id,event_id,value)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(target_id,actor_id,mode) DO UPDATE
      SET update_id=$4,event_id=$5,value=$6,updated_at=now()
      WHERE reaction_states.update_id<$4 RETURNING event_id`,[row.target_id,row.actor_id,mode,sequence,reference.id,JSON.stringify(value)]);
    if(changed.rowCount){
      const epoch=Number((await db.query('UPDATE guard_state SET epoch=epoch+1 WHERE singleton RETURNING epoch')).rows[0].epoch);
      await requestWorkflow(db,'honcho','refresh',epoch);await requestWorkflow(db,'memory_review','refresh',epoch);
    }
  }
  async isCurrent(reference:SourceReference):Promise<boolean> {
    const row=await this.observation(reference.id);
    if(!row||!['reaction_change','reaction_counts'].includes(row.operation))return true;
    const state=(await this.control.query('SELECT event_id FROM reaction_states WHERE target_id=$1 AND actor_id=$2 AND mode=$3',
      [row.target_id,row.actor_id,row.operation==='reaction_counts'?'aggregate':'individual'])).rows[0];
    return state?.event_id===reference.id;
  }
}

import type pg from 'pg';
import type {Reader} from '../access.js';

type Db=Pick<pg.Pool,'query'>|Pick<pg.PoolClient,'query'>;

/**
 * Whether `job` is a schedule's with a run of it going now, not a background job (ADR-0278). Hermes's scheduler runs a
 * schedule under its own job id, which is never a background job's; with `event`, that run is the one of this turn.
 * A schedule's run may read Notion and GitHub as a live turn reads them, with no card; a background job may not.
 */
export async function scheduleRunning(db:Db,job:string|null|undefined,event?:string):Promise<boolean> {
  if(typeof job!=='string'||!job)return false;
  return !!(await db.query(`SELECT 1 FROM managed_runs r WHERE r.channel='scheduler' AND r.job_id=$1 AND r.state='running' AND NOT r.cancel_requested
    AND ($2::text IS NULL OR r.event_id=$2) AND NOT EXISTS(SELECT 1 FROM background_jobs b WHERE b.id=$1)`,[job,event??null])).rowCount;
}

/** A turn's binding marked `scheduled` when it is a schedule's running run (scheduleRunning), for the connector checks. */
export async function lookupTurn<T extends {job?:string|null}>(db:Db,principal:Pick<Reader,'turnEvent'>,turn:T):Promise<T&{scheduled?:boolean}> {
  return turn.job&&principal.turnEvent&&await scheduleRunning(db,turn.job,principal.turnEvent)?{...turn,scheduled:true}:turn;
}

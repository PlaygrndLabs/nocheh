import type pg from 'pg';
import {carriesForward,type GuardBinding} from './guards.js';

/** Call while holding guard_state FOR UPDATE, the same lock used by reply admission. A reply, an operation's follow-up turn
 *  (ADR-0212), a browser or a scheduled run counts in its own epoch. A background job's running run counts while its binding carries to `binding`, except for a
 *  `quiet` change, a reaction or an automatic learning revision, which it goes on across (ADR-0208). */
export async function foregroundReplyActive(db:Pick<pg.PoolClient,'query'>,binding:GuardBinding,quiet=false):Promise<boolean> {
  if((await db.query(`SELECT 1 FROM dispatches WHERE state='running'
    AND binding->>'generation'=$1 AND (binding->>'epoch')::bigint=$2
    UNION ALL SELECT 1 FROM action_continuations WHERE state='running'
    AND binding->>'generation'=$1 AND (binding->>'epoch')::bigint=$2
    UNION ALL SELECT 1 FROM managed_runs WHERE state='running' AND lease_until>now() AND channel<>'background'
    AND binding->>'generation'=$1 AND (binding->>'epoch')::bigint=$2 LIMIT 1`,[binding.generation,binding.epoch])).rowCount)return true;
  if(quiet)return false;
  const jobs=(await db.query(`SELECT binding FROM managed_runs WHERE channel='background' AND state='running' AND lease_until>now()
    AND binding->>'generation'=$1`,[binding.generation])).rows;
  for(const run of jobs)if(await carriesForward(db,run.binding,binding))return true;
  return false;
}

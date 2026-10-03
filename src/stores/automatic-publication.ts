import type pg from 'pg';
import type {GuardBinding} from './guards.js';

/** Call while holding guard_state FOR UPDATE, the same lock used by reply admission. */
export async function foregroundReplyActive(db:Pick<pg.PoolClient,'query'>,binding:GuardBinding):Promise<boolean> {
  return !!(await db.query(`SELECT 1 FROM dispatches WHERE state='running'
    AND binding->>'generation'=$1 AND (binding->>'epoch')::bigint=$2
    UNION ALL SELECT 1 FROM managed_runs WHERE state='running' AND lease_until>now()
    AND binding->>'generation'=$1 AND (binding->>'epoch')::bigint=$2 LIMIT 1`,[binding.generation,binding.epoch])).rowCount;
}

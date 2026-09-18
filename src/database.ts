import pg from 'pg';
import type { Settings } from './config.js';
import {managedRunSchema} from './managed-runs.js';
import {controlledSchema} from './controlled-actions.js';
import { schema } from './archive.js';
import { spaceSchema,backfillSpaces } from './spaces.js';
import { learningSchema } from './learning.js';
import { sharingSchema } from './sharing.js';
import { guardedSchema } from './guarded.js';
import {contextSchema} from './prepared-context.js';
import {honchoSchema} from './honcho.js';
import {securitySchema} from './security/store.js';
import {workflowSchema} from './workflows/store.js';
import {scheduleWorkflowSchema} from './workflows/schedules.js';
import {workflowOwnerSchema} from './workflows/owner.js';
import {migrationSchema} from './workflows/migrations.js';
import {workflowRequestSchema} from './workflows/requests.js';
import {importWorkflowSchema} from './workflows/imports.js';
import {approvalWorkflowSchema} from './workflows/approvals.js';
import {toolWorkflowSchema} from './workflows/host-tools.js';
import {migrateSourceModel} from './source-model.js';

export function connectDatabase(config: Settings): pg.Pool {
  if(config.storageLayout==='original-only-v1')throw Error('separated_storage_repositories_required');
  const pool = new pg.Pool({
    host: process.env.PGHOST ?? 'nocheh-postgres', port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'nocheh', database: process.env.PGDATABASE ?? 'nocheh',
    password: config.databasePassword, max: 8, connectionTimeoutMillis: 5000,
    statement_timeout: 15000, idleTimeoutMillis: 30000,
  });
  const connectionLost=()=>console.error(JSON.stringify({event:'database_connection_lost'}));
  // A checked-out client can disconnect while a step awaits an external call.
  // Pool error handling covers idle clients only; active borrowers still need
  // a listener. Their next query rejects and existing receipt recovery applies.
  pool.on('connect',client=>client.on('error',connectionLost));
  pool.on('error',connectionLost);
  return pool;
}

export async function initialize(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(803300)');
    await client.query(`CREATE TABLE IF NOT EXISTS service_heartbeats (
      service text PRIMARY KEY, seen_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query(schema);
    await migrateSourceModel(client);
    await client.query(managedRunSchema);
    await client.query(spaceSchema);
    await backfillSpaces(client);
    await client.query(learningSchema);
    await client.query(sharingSchema);
    await client.query(controlledSchema);
    await client.query(guardedSchema);
    await client.query(contextSchema);
    await client.query(honchoSchema);
    await client.query(securitySchema);
    await client.query(workflowSchema);
    await client.query(workflowRequestSchema);
    await client.query(importWorkflowSchema);
    await client.query(approvalWorkflowSchema);
    await client.query(toolWorkflowSchema);
    await client.query(scheduleWorkflowSchema);
    await client.query(workflowOwnerSchema);
    await client.query(migrationSchema);
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function heartbeat(pool: pg.Pool, service: string): Promise<void> {
  await pool.query(`INSERT INTO service_heartbeats(service) VALUES($1)
    ON CONFLICT(service) DO UPDATE SET seen_at=now()`, [service]);
}

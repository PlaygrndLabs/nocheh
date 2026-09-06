import pg from 'pg';
import type { Settings } from './config.js';
import { schema } from './archive.js';

export function connectDatabase(config: Settings): pg.Pool {
  const pool = new pg.Pool({
    host: process.env.PGHOST ?? 'postgres', port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'nocheh', database: process.env.PGDATABASE ?? 'nocheh',
    password: config.databasePassword, max: 8, connectionTimeoutMillis: 5000,
    statement_timeout: 15000, idleTimeoutMillis: 30000,
  });
  pool.on('error', () => console.error(JSON.stringify({event: 'database_connection_lost'})));
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
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function heartbeat(pool: pg.Pool, service: string): Promise<void> {
  await pool.query(`INSERT INTO service_heartbeats(service) VALUES($1)
    ON CONFLICT(service) DO UPDATE SET seen_at=now()`, [service]);
}

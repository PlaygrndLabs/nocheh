import { createHash } from 'node:crypto';
import type pg from 'pg';
import { HttpError, object, string } from './http.js';

export const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const schema = `
CREATE TABLE IF NOT EXISTS events (
  id text PRIMARY KEY, source_key text UNIQUE NOT NULL, channel text NOT NULL, bot_id text NOT NULL,
  scope text NOT NULL, source_id text NOT NULL, revision text NOT NULL,
  origin text NOT NULL CHECK(origin IN ('live','import','generated')),
  kind text NOT NULL, occurred_at text, received_at timestamptz NOT NULL DEFAULT now(),
  payload bytea NOT NULL, payload_hash text NOT NULL, original_text bytea,
  search_text text NOT NULL DEFAULT '', wire bytea
);
ALTER TABLE events ADD COLUMN IF NOT EXISTS bot_id text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS events_scope_time ON events(scope, received_at);
CREATE INDEX IF NOT EXISTS events_lexical ON events USING gin(to_tsvector('simple',search_text));
CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY, event_id text NOT NULL REFERENCES events(id), kind text NOT NULL,
  source_ref text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL CHECK(state IN ('pending','ready','failed')) DEFAULT 'pending',
  file_hash text, byte_size bigint, attempts integer NOT NULL DEFAULT 0,
  next_attempt timestamptz NOT NULL DEFAULT now(), error_code text,
  UNIQUE(event_id, source_ref)
);
CREATE TABLE IF NOT EXISTS derived_artifacts (
  id text PRIMARY KEY, event_id text NOT NULL REFERENCES events(id), artifact_id text REFERENCES artifacts(id),
  kind text NOT NULL, content bytea NOT NULL, provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dispatches (
  event_id text PRIMARY KEY REFERENCES events(id),
  state text NOT NULL CHECK(state IN ('pending','running','done','failed','ambiguous','suppressed')),
  attempts integer NOT NULL DEFAULT 0, next_attempt timestamptz NOT NULL DEFAULT now(),
  error_code text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS spool_failures (
  file_name text PRIMARY KEY, attempts integer NOT NULL DEFAULT 1, error_code text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now()
);
`;

export interface Envelope {
  readonly version: 1; readonly key: string; readonly origin: 'live'|'import'|'generated';
  readonly bot_id: string; readonly kind: string; readonly scope: string;
  readonly source_id: string; readonly revision: string; readonly occurred_at: string|null;
  readonly payload: Record<string, unknown>; readonly text: string|null; readonly wire_base64?: string;
}
export function envelope(value: unknown): Envelope {
  const v = object(value);
  if (v.version !== 1 || !['live','import','generated'].includes(String(v.origin))) throw new HttpError(400, 'invalid_envelope');
  for (const key of ['key','bot_id','kind','scope','source_id','revision']) if (!string(v[key],1024)) throw new HttpError(400,'empty_identity');
  if (v.text !== null) string(v.text, 2000000);
  if (v.occurred_at !== null) string(v.occurred_at, 100);
  object(v.payload);
  if (v.wire_base64 !== undefined && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(string(v.wire_base64, 16000000))) throw new HttpError(400,'invalid_wire');
  return v as unknown as Envelope;
}
export function attachmentRefs(payload: Record<string, unknown>): {kind:string; ref:string; metadata:Record<string,unknown>}[] {
  const refs = new Map<string, {kind:string; ref:string; metadata:Record<string,unknown>}>();
  function visit(value: unknown, kind: string, depth: number): void {
    if (depth > 25 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const v of value) visit(v, kind, depth+1); return; }
    const item = value as Record<string,unknown>;
    if (typeof item.file_id === 'string') refs.set(item.file_id, {kind, ref:item.file_id, metadata:item});
    for (const [key,v] of Object.entries(item)) visit(v, key, depth+1);
  }
  visit(payload, 'file', 0); return [...refs.values()];
}

export async function ingest(pool: pg.Pool, value: Envelope): Promise<{id:string; duplicate:boolean}> {
  const id = digest(value.key), payload = Buffer.from(canonical(value.payload));
  // Identity metadata is included: reuse of a key cannot silently move a source to another scope.
  const contentHash = digest(canonical({...value, wire_base64: undefined}));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const added = await client.query(`INSERT INTO events(id,source_key,channel,scope,source_id,revision,origin,kind,occurred_at,payload,payload_hash,original_text,search_text,wire,bot_id)
      VALUES($1,$2,'telegram',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(source_key) DO NOTHING RETURNING id`,
    [id,value.key,value.scope,value.source_id,value.revision,value.origin,value.kind,value.occurred_at,payload,contentHash,
      value.text === null ? null : Buffer.from(value.text), (value.text ?? '').replaceAll('\0',''),
      value.wire_base64 === undefined ? null : Buffer.from(value.wire_base64,'base64'),value.bot_id]);
    if (!added.rowCount) {
      const previous = await client.query<{payload_hash:string}>('SELECT payload_hash FROM events WHERE id=$1',[id]);
      if (previous.rows[0]?.payload_hash !== contentHash) throw new HttpError(409,'source_identity_conflict');
    } else {
      for (const ref of attachmentRefs(value.payload)) {
        await client.query('INSERT INTO artifacts(id,event_id,kind,source_ref,metadata) VALUES($1,$2,$3,$4,$5)',
          [digest(`${id}:${ref.ref}`),id,ref.kind,ref.ref,JSON.stringify(ref.metadata)]);
      }
      await client.query('INSERT INTO dispatches(event_id,state) VALUES($1,$2)',
        [id, value.origin === 'live' && value.kind === 'telegram_update' ? 'pending' : 'suppressed']);
    }
    await client.query('COMMIT'); return {id, duplicate: !added.rowCount};
  } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function archiveStatus(pool:pg.Pool) {
  const events = await pool.query<{count:string}>('SELECT count(*) FROM events');
  const artifacts = await pool.query('SELECT state,count(*)::integer AS count FROM artifacts GROUP BY state');
  const dispatches = await pool.query('SELECT state,count(*)::integer AS count FROM dispatches GROUP BY state');
  const failures = await pool.query('SELECT file_name, attempts, error_code, seen_at FROM spool_failures ORDER BY seen_at DESC LIMIT 100');
  return {events:Number(events.rows[0]?.count),artifacts:artifacts.rows,dispatches:dispatches.rows,spool_failures:failures.rows};
}

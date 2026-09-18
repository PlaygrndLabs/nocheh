/** Immutable imported history also retains caches that cannot be reused as
 * runtime authority in the receiving installation. */
export const portableHistorySchema=`
CREATE TABLE IF NOT EXISTS portable_records (
 id text PRIMARY KEY,record_type text NOT NULL,record_key text NOT NULL,
 content bytea NOT NULL,content_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS portable_record_kind ON portable_records(record_type,record_key,id);
`;

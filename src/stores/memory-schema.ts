export const controlMemorySchema=`
CREATE TABLE IF NOT EXISTS memory_engine_connection (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 attached boolean NOT NULL DEFAULT false,verified boolean NOT NULL DEFAULT false,
 include_history boolean NOT NULL DEFAULT false,attached_at timestamptz,acceptance jsonb
);
INSERT INTO memory_engine_connection(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS memory_generations (
 id text PRIMARY KEY,installation_generation uuid NOT NULL,guard_epoch bigint NOT NULL,
 audience text NOT NULL,state text NOT NULL DEFAULT 'building' CHECK(state IN ('building','ready','retired')),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(installation_generation,guard_epoch,audience)
);
CREATE TABLE IF NOT EXISTS memory_ingestion_receipts (
 id text PRIMARY KEY,generation text NOT NULL REFERENCES memory_generations(id),
 source_reference jsonb NOT NULL,guard_source_id text NOT NULL,guarded_revision integer,
 prepared_id text NOT NULL,content_hash text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','uncertain','done','failed')),
 remote_id text,attempts integer NOT NULL DEFAULT 0,error_code text,
 next_attempt timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_receipts_remote ON memory_ingestion_receipts(generation,remote_id);
`;

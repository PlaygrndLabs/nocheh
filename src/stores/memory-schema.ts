export const controlMemorySchema=`
CREATE TABLE IF NOT EXISTS memory_engine_connection (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 attached boolean NOT NULL DEFAULT false,verified boolean NOT NULL DEFAULT false,
 include_history boolean NOT NULL DEFAULT false,attached_at timestamptz,acceptance jsonb
);
INSERT INTO memory_engine_connection(singleton) VALUES(true) ON CONFLICT DO NOTHING;
ALTER TABLE memory_engine_connection ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
ALTER TABLE memory_engine_connection ADD COLUMN IF NOT EXISTS workspace_revision integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS memory_generations (
 id text PRIMARY KEY,installation_generation uuid NOT NULL,guard_epoch bigint NOT NULL,
 audience text NOT NULL,state text NOT NULL DEFAULT 'building' CHECK(state IN ('building','ready','retired')),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(installation_generation,guard_epoch,audience)
);
ALTER TABLE memory_generations ADD COLUMN IF NOT EXISTS root_reference jsonb;
ALTER TABLE memory_generations ADD COLUMN IF NOT EXISTS root_space text;
ALTER TABLE memory_generations ADD COLUMN IF NOT EXISTS last_ready_at timestamptz;
ALTER TABLE memory_generations ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE memory_generations ADD COLUMN IF NOT EXISTS work_revision integer NOT NULL DEFAULT 1;
ALTER TABLE memory_generations ADD COLUMN IF NOT EXISTS representation_version text NOT NULL DEFAULT 'legacy-source-v1';
ALTER TABLE memory_generations DROP CONSTRAINT IF EXISTS memory_generations_installation_generation_guard_epoch_audience_key;
DROP INDEX IF EXISTS memory_generations_versioned_audience;
-- One current workspace per installation; a fresh start retires it and opens the next.
CREATE UNIQUE INDEX IF NOT EXISTS memory_generations_current ON memory_generations(installation_generation) WHERE audience='installation' AND state<>'retired';
DROP TABLE IF EXISTS memory_entity_peer_mappings;
CREATE TABLE IF NOT EXISTS memory_ingestion_receipts (
 id text PRIMARY KEY,generation text NOT NULL REFERENCES memory_generations(id),
 source_reference jsonb NOT NULL,guard_source_id text NOT NULL,guarded_revision integer,
 prepared_id text NOT NULL,content_hash text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','uncertain','done','failed')),
 remote_id text,attempts integer NOT NULL DEFAULT 0,error_code text,
 next_attempt timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE memory_ingestion_receipts ADD COLUMN IF NOT EXISTS peer_id text NOT NULL DEFAULT 'source';
ALTER TABLE memory_ingestion_receipts ADD COLUMN IF NOT EXISTS peer_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE memory_ingestion_receipts ADD COLUMN IF NOT EXISTS session_id text;
ALTER TABLE memory_ingestion_receipts ADD COLUMN IF NOT EXISTS subject_entity_id text;
ALTER TABLE memory_ingestion_receipts ADD COLUMN IF NOT EXISTS speaker_entity_id text;
ALTER TABLE memory_ingestion_receipts ADD COLUMN IF NOT EXISTS record_kind text NOT NULL DEFAULT 'legacy_source';
CREATE INDEX IF NOT EXISTS memory_receipts_remote ON memory_ingestion_receipts(generation,remote_id);
ALTER TABLE memory_ingestion_receipts ADD COLUMN IF NOT EXISTS source_references jsonb NOT NULL DEFAULT '[]';
ALTER TABLE memory_ingestion_receipts ADD COLUMN IF NOT EXISTS dependencies jsonb NOT NULL DEFAULT '[]';
ALTER TABLE memory_ingestion_receipts ADD COLUMN IF NOT EXISTS projection_reference jsonb;
CREATE INDEX IF NOT EXISTS memory_receipts_due ON memory_ingestion_receipts(generation,state,next_attempt);
ALTER TABLE memory_ingestion_receipts ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'owner';
ALTER TABLE memory_ingestion_receipts ADD COLUMN IF NOT EXISTS session_key text;
ALTER TABLE memory_ingestion_receipts ADD COLUMN IF NOT EXISTS logical_id text;
ALTER TABLE memory_ingestion_receipts ADD COLUMN IF NOT EXISTS guard_mode text;
ALTER TABLE memory_ingestion_receipts ADD COLUMN IF NOT EXISTS retired_at timestamptz;
CREATE INDEX IF NOT EXISTS memory_receipts_live_session ON memory_ingestion_receipts(session_id,state) WHERE retired_at IS NULL;
CREATE INDEX IF NOT EXISTS memory_receipts_live_source ON memory_ingestion_receipts((source_reference->>'id')) WHERE retired_at IS NULL;
CREATE TABLE IF NOT EXISTS memory_sessions (
 workspace text NOT NULL REFERENCES memory_generations(id),key text NOT NULL,audience text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('conversation','entity_evidence','projection')),
 revision integer NOT NULL DEFAULT 1,session_id text NOT NULL UNIQUE,
 work_revision integer NOT NULL DEFAULT 0,prefetched_revision integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace,key)
);
CREATE INDEX IF NOT EXISTS memory_sessions_audience ON memory_sessions(workspace,audience,updated_at);
CREATE TABLE IF NOT EXISTS memory_session_deletions (
 session_id text PRIMARY KEY,workspace text NOT NULL REFERENCES memory_generations(id),session_key text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done')),deleted_conclusions integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz
);
CREATE SEQUENCE IF NOT EXISTS memory_ingest_requests;
CREATE TABLE IF NOT EXISTS memory_workspace_deletions (
 workspace text PRIMARY KEY,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done')),
 deleted_sessions integer NOT NULL DEFAULT 0,
 requested_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz
);
DROP TABLE IF EXISTS memory_context_snapshots;
CREATE TABLE IF NOT EXISTS interpretation_jobs (
 id text PRIMARY KEY,source_reference jsonb NOT NULL,workspace text NOT NULL,audience text NOT NULL,
 input_reference jsonb NOT NULL,binding jsonb NOT NULL,context_hash text NOT NULL,output_id text,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','publishing','done','failed')),
 attempts integer NOT NULL DEFAULT 0,result_ids jsonb NOT NULL DEFAULT '[]',publication_ids jsonb NOT NULL DEFAULT '[]',error_code text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS interpretation_inputs ON interpretation_jobs(context_hash,state);
`;

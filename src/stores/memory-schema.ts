export const controlMemorySchema=`
CREATE TABLE IF NOT EXISTS memory_engine_connection (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 attached boolean NOT NULL DEFAULT false,verified boolean NOT NULL DEFAULT false,
 include_history boolean NOT NULL DEFAULT false,attached_at timestamptz,acceptance jsonb
);
INSERT INTO memory_engine_connection(singleton) VALUES(true) ON CONFLICT DO NOTHING;
ALTER TABLE memory_engine_connection ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
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
CREATE UNIQUE INDEX IF NOT EXISTS memory_generations_versioned_audience ON memory_generations(installation_generation,guard_epoch,audience,representation_version);
CREATE TABLE IF NOT EXISTS memory_entity_peer_mappings (
 id text PRIMARY KEY,entity_id text NOT NULL REFERENCES memory_entities(id),generation text NOT NULL REFERENCES memory_generations(id),
 audience text NOT NULL,representation_version text NOT NULL,peer_id text NOT NULL,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','retired')),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(generation,entity_id,representation_version),UNIQUE(generation,peer_id)
);
CREATE INDEX IF NOT EXISTS memory_entity_peer_mappings_entity ON memory_entity_peer_mappings(entity_id,audience,state);
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
CREATE TABLE IF NOT EXISTS memory_context_snapshots (
 generation text PRIMARY KEY REFERENCES memory_generations(id),derived_id text NOT NULL,
 content_hash text NOT NULL,refreshed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS interpretation_jobs (
 id text PRIMARY KEY,source_reference jsonb NOT NULL,workspace text NOT NULL,audience text NOT NULL,
 input_reference jsonb NOT NULL,binding jsonb NOT NULL,context_hash text NOT NULL,output_id text,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','publishing','done','failed')),
 attempts integer NOT NULL DEFAULT 0,result_ids jsonb NOT NULL DEFAULT '[]',publication_ids jsonb NOT NULL DEFAULT '[]',error_code text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS interpretation_inputs ON interpretation_jobs(context_hash,state);
`;

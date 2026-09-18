import {sourceModelSchema} from '../source-model.js';
import {workflowSchema} from '../workflows/store.js';
import {derivedGuardSchema,controlGuardSchema} from './guard-schema.js';
import {derivativeSelectionSchema} from './selection-schema.js';
import {controlPolicySchema} from './policy-schema.js';
import {controlMemorySchema} from './memory-schema.js';
import {derivedLearnedSchema} from './learned-schema.js';
import {controlOperationSchema} from './operations.js';
import {runtimeContextSchema} from './prepared-context.js';
import {runtimeTurnSchema} from './turns.js';
import {securityCoreSchema} from '../security/store.js';
import {nativeReviewSchema} from './native-review.js';
import {sharingContentSchema} from './sharing-schema.js';
import {portableHistorySchema} from './portable-schema.js';
import {storageWorkflowSchema} from './workflow-schema.js';
import {runtimeConfigurationSchema} from './runtime-configuration.js';
import {telegramActionSchema} from './telegram-action-schema.js';
import {telegramDispatchSchema} from './telegram-dispatch.js';

// These fresh-install schemas deliberately contain no foreign database links.
// Cross-store references are checked by repositories and recoverable operations.
export const originalArchiveSchema=`
CREATE TABLE IF NOT EXISTS events (
 id text PRIMARY KEY, capture_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 source_key text UNIQUE NOT NULL, channel text NOT NULL CHECK(channel<>'scheduler'),
 bot_id text NOT NULL, scope text NOT NULL, source_id text NOT NULL, revision text NOT NULL,
 origin text NOT NULL CHECK(origin IN ('live','import')),
 kind text NOT NULL CHECK(kind NOT IN ('runtime_context','transcript','extracted_text',
   'shared_knowledge','outbound_intent','outbound_result','schedule_definition','schedule_fire')),
 occurred_at text, received_at timestamptz NOT NULL DEFAULT now(),
 payload bytea NOT NULL, payload_hash text NOT NULL, original_text bytea,
 search_text text NOT NULL DEFAULT '', wire bytea
);
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_kind_check;
ALTER TABLE events ADD CONSTRAINT events_kind_check CHECK(kind NOT IN ('runtime_context','transcript','extracted_text',
 'shared_knowledge','outbound_intent','outbound_result','schedule_definition','schedule_fire','guard_result','learning_result','learned_memory','extraction_status',
 'memory_input','memory_result','memory_context','runtime_result','action_request','action_result','action_decision','owner_action_decision','action_control_reply'));
CREATE INDEX IF NOT EXISTS events_scope_time ON events(scope,received_at,id);
CREATE INDEX IF NOT EXISTS events_lexical ON events USING gin(to_tsvector('simple',search_text));
CREATE TABLE IF NOT EXISTS artifacts (
 id text PRIMARY KEY, event_id text NOT NULL REFERENCES events(id), kind text NOT NULL,
 source_ref text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
 file_hash text, byte_size bigint CHECK(byte_size>=0),
 CHECK((file_hash IS NULL)=(byte_size IS NULL)),
 CHECK(file_hash IS NULL OR file_hash ~ '^[a-f0-9]{64}$'), UNIQUE(event_id,source_ref)
);
CREATE OR REPLACE FUNCTION preserve_original_file() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.file_hash IS NOT NULL AND (NEW.file_hash IS DISTINCT FROM OLD.file_hash OR NEW.byte_size IS DISTINCT FROM OLD.byte_size)
 THEN RAISE EXCEPTION 'original_file_is_immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS preserve_original_file ON artifacts;
CREATE TRIGGER preserve_original_file BEFORE UPDATE ON artifacts FOR EACH ROW EXECUTE FUNCTION preserve_original_file();
${sourceModelSchema}
`;

export const initialDerivedSchema=`
CREATE TABLE IF NOT EXISTS derived_artifacts (
 id text PRIMARY KEY,event_id text,artifact_id text,kind text NOT NULL,
 content bytea NOT NULL,content_hash text NOT NULL,provenance jsonb NOT NULL,
 source_revision text NOT NULL,input_hash text NOT NULL,producer text NOT NULL,
 producer_version text NOT NULL,configuration_hash text NOT NULL,
 operation_id text UNIQUE NOT NULL,search_text text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS derived_event ON derived_artifacts(event_id,created_at,id);
ALTER TABLE derived_artifacts ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE derived_artifacts ADD COLUMN IF NOT EXISTS operation_reference jsonb;
ALTER TABLE derived_artifacts DROP CONSTRAINT IF EXISTS derived_anchor;
ALTER TABLE derived_artifacts ADD CONSTRAINT derived_anchor CHECK(
 (event_id IS NOT NULL AND operation_reference IS NULL) OR
 (event_id IS NULL AND artifact_id IS NULL AND operation_reference IS NOT NULL AND
  coalesce(operation_reference->>'store'='control' AND operation_reference->>'kind'='operation'
    AND operation_reference ?& ARRAY['id','generation','input_hash'],false)));
CREATE INDEX IF NOT EXISTS derived_artifact ON derived_artifacts(artifact_id,kind,created_at,id);
CREATE INDEX IF NOT EXISTS derived_lexical ON derived_artifacts USING gin(to_tsvector('simple',search_text));
${derivedGuardSchema}
${runtimeContextSchema}
${derivativeSelectionSchema}
${derivedLearnedSchema}
${portableHistorySchema}
`;

export const initialControlSchema=`
CREATE TABLE IF NOT EXISTS service_heartbeats (
 service text PRIMARY KEY,seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS installation (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 generation uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS capture_handoffs (
 event_id text PRIMARY KEY,source_revision text NOT NULL,payload_hash text NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS source_intakes (
 event_id text PRIMARY KEY,source_revision text NOT NULL,input_hash text NOT NULL,
 transport text NOT NULL CHECK(transport IN ('capture','import')),
 state text NOT NULL CHECK(state IN ('pending','ready')),created_at timestamptz NOT NULL DEFAULT now()
);
${workflowSchema}
${storageWorkflowSchema}
${runtimeConfigurationSchema}
${telegramActionSchema}
${telegramDispatchSchema}
${controlGuardSchema}
${controlPolicySchema}
${controlMemorySchema}
${controlOperationSchema}
${runtimeTurnSchema}
${securityCoreSchema}
${nativeReviewSchema}
${sharingContentSchema}
CREATE TABLE IF NOT EXISTS attachment_retrievals (
 artifact_id text PRIMARY KEY,event_id text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','failed')),
 attempts integer NOT NULL DEFAULT 0,next_attempt timestamptz NOT NULL DEFAULT now(),error_code text
);
CREATE TABLE IF NOT EXISTS reprocess_jobs (
 id text PRIMARY KEY,request_hash text NOT NULL,file_reference jsonb NOT NULL,
 producer text NOT NULL,producer_version text NOT NULL,configuration jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','failed')),
 derived_id text,attempts integer NOT NULL DEFAULT 0,error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS capture_reconciliation (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 after_sequence bigint NOT NULL DEFAULT 0 CHECK(after_sequence>=0)
);
INSERT INTO capture_reconciliation(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS spool_failures (
 file_name text PRIMARY KEY,attempts integer NOT NULL DEFAULT 1,error_code text NOT NULL,
 seen_at timestamptz NOT NULL DEFAULT now()
);
`;

export const storeSchemas={archive:originalArchiveSchema,derived:initialDerivedSchema,control:initialControlSchema} as const;

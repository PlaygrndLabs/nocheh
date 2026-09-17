export const derivedLearnedSchema=`
CREATE TABLE IF NOT EXISTS learned_entries (
 id text PRIMARY KEY,scope_kind text NOT NULL CHECK(scope_kind IN ('conversation','project')),
 scope_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('meaning','state','convention')),
 subject text NOT NULL,active_revision integer,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS learned_scope ON learned_entries(scope_kind,scope_id,id);
CREATE TABLE IF NOT EXISTS learned_versions (
 operation_id text PRIMARY KEY,entry_id text NOT NULL REFERENCES learned_entries(id),revision integer NOT NULL,
 expected_revision integer,derived_id text NOT NULL REFERENCES derived_artifacts(id),request_hash text NOT NULL,
 author text NOT NULL CHECK(author IN ('honcho','participant','owner')),retired boolean NOT NULL DEFAULT false,
 evidence jsonb NOT NULL,dependencies jsonb NOT NULL,input_binding jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(entry_id,revision)
);
CREATE TABLE IF NOT EXISTS learned_activations (
 operation_id text PRIMARY KEY REFERENCES learned_versions(operation_id),activated_at timestamptz NOT NULL DEFAULT now()
);
`;

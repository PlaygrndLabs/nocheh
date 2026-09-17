export const derivedGuardSchema=`
CREATE TABLE IF NOT EXISTS guard_sources (
 id text PRIMARY KEY,event_id text NOT NULL,kind text NOT NULL,source_id text NOT NULL,
 reference jsonb NOT NULL,input_hash text NOT NULL,input bytea NOT NULL,
 active_revision integer,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready')),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(kind,source_id)
);
CREATE TABLE IF NOT EXISTS guard_revisions (
 id text PRIMARY KEY,source_id text NOT NULL REFERENCES guard_sources(id),revision integer NOT NULL,
 content bytea NOT NULL,search_text text NOT NULL,input_hash text NOT NULL,
 author text NOT NULL CHECK(author IN ('automatic','owner')),preparation_version text NOT NULL,
 operation_id text NOT NULL UNIQUE,expected_revision integer,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(source_id,revision)
);
CREATE INDEX IF NOT EXISTS guard_lexical ON guard_revisions USING gin(to_tsvector('simple',search_text));
CREATE TABLE IF NOT EXISTS guard_activations (
 operation_id text PRIMARY KEY REFERENCES guard_revisions(operation_id),
 source_id text NOT NULL REFERENCES guard_sources(id),revision integer NOT NULL,
 activated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guard_fragments (
 id text PRIMARY KEY,source_id text NOT NULL REFERENCES guard_sources(id),input_hash text NOT NULL,
 preparation_version text NOT NULL,content bytea NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
`;

export const controlGuardSchema=`
CREATE TABLE IF NOT EXISTS guard_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),epoch bigint NOT NULL DEFAULT 1,
 mode text NOT NULL DEFAULT 'on' CHECK(mode IN ('on','off'))
);
INSERT INTO guard_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS guard_publications (
 id text PRIMARY KEY,source_id text NOT NULL,revision integer NOT NULL,expected_revision integer,
 epoch bigint NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','conflict')),
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz
);
ALTER TABLE guard_publications ADD COLUMN IF NOT EXISTS operation_kind text NOT NULL DEFAULT 'guard'
 CHECK(operation_kind IN ('guard','selection'));
ALTER TABLE guard_publications DROP CONSTRAINT IF EXISTS guard_publications_operation_kind_check;
ALTER TABLE guard_publications ADD CONSTRAINT guard_publications_operation_kind_check CHECK(operation_kind IN ('guard','selection','memory'));
CREATE TABLE IF NOT EXISTS guard_invalidations (
 id bigserial PRIMARY KEY,source_id text NOT NULL,epoch bigint NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done')),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(source_id,epoch)
);
`;

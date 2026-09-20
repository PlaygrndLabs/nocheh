export const controlEntitySchema=`
CREATE TABLE IF NOT EXISTS memory_entities (
 id text PRIMARY KEY,kind text NOT NULL CHECK(kind IN ('person','project')),
 name text NOT NULL,state text NOT NULL CHECK(state IN ('active','merged','rejected')),
 project_id text REFERENCES projects(id),merged_into text REFERENCES memory_entities(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='project')=(project_id IS NOT NULL)),CHECK(id<>merged_into)
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_entities_project ON memory_entities(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_entities_name ON memory_entities(lower(name),id) WHERE state='active';
CREATE TABLE IF NOT EXISTS memory_entity_bindings (
 id text PRIMARY KEY,entity_id text NOT NULL REFERENCES memory_entities(id),
 binding_kind text NOT NULL CHECK(binding_kind IN ('source_identity','mention','project')),
 source_object_id text,mention_key text,label text NOT NULL DEFAULT '',
 state text NOT NULL CHECK(state IN ('exact','confirmed','suggested','rejected')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((binding_kind='source_identity')=(source_object_id IS NOT NULL)),
 CHECK((binding_kind='mention')=(mention_key IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_entity_source_binding ON memory_entity_bindings(source_object_id) WHERE source_object_id IS NOT NULL AND state IN ('exact','confirmed');
CREATE INDEX IF NOT EXISTS memory_entity_bindings_entity ON memory_entity_bindings(entity_id,state,id);
CREATE TABLE IF NOT EXISTS memory_entity_binding_moves (
 id text PRIMARY KEY,binding_id text NOT NULL REFERENCES memory_entity_bindings(id),from_entity_id text NOT NULL REFERENCES memory_entities(id),
 to_entity_id text NOT NULL REFERENCES memory_entities(id),merge_revision integer NOT NULL,undone boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(binding_id,from_entity_id,merge_revision)
);
CREATE TABLE IF NOT EXISTS memory_entity_suggestions (
 id text PRIMARY KEY,kind text NOT NULL CHECK(kind IN ('person','project','binding')),
 name text NOT NULL,candidate_entity_id text REFERENCES memory_entities(id),source_reference jsonb NOT NULL,
 reason text NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_entity_suggestions_status ON memory_entity_suggestions(status,id);
`;

export const derivedEntitySchema=`
CREATE TABLE IF NOT EXISTS entity_claims (
 id text PRIMARY KEY,subject_entity_id text NOT NULL,predicate text NOT NULL,
 object_entity_id text,active_revision integer,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entity_claims_subject ON entity_claims(subject_entity_id,id);
CREATE INDEX IF NOT EXISTS entity_claims_object ON entity_claims(object_entity_id,id) WHERE object_entity_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS entity_claim_versions (
 operation_id text PRIMARY KEY,claim_id text NOT NULL REFERENCES entity_claims(id),revision integer NOT NULL,
 expected_revision integer,content text NOT NULL,
 relationship_kind text CHECK(relationship_kind IN ('contextual','participates','responsible','depends_on','associated')),
 attribution text NOT NULL CHECK(attribution IN ('direct','reported','inferred')),
 speaker_entity_id text,uncertainty text NOT NULL CHECK(uncertainty IN ('uncertain','supported','explicit')),
 author text NOT NULL CHECK(author IN ('honcho','owner')),retired boolean NOT NULL DEFAULT false,
 evidence jsonb NOT NULL,dependencies jsonb NOT NULL,input_binding jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(claim_id,revision)
);
CREATE INDEX IF NOT EXISTS entity_claim_versions_active ON entity_claim_versions(claim_id,revision);
`;

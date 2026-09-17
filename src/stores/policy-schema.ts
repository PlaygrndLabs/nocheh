export const controlPolicySchema=`
CREATE TABLE IF NOT EXISTS owner_commands (
 id text PRIMARY KEY,request_hash text NOT NULL,result jsonb NOT NULL,
 epoch bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS projects (
 id text PRIMARY KEY,name text NOT NULL,description text NOT NULL DEFAULT '',
 state text NOT NULL CHECK(state IN ('active','archived')),revision integer NOT NULL CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_assignments (
 space_id text PRIMARY KEY,project_id text REFERENCES projects(id),
 mode text NOT NULL CHECK(mode IN ('assigned','none','inherit')),
 revision integer NOT NULL CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((mode='assigned')=(project_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS project_assignments_project ON project_assignments(project_id,space_id);
CREATE TABLE IF NOT EXISTS sharing_rules (
 id text PRIMARY KEY,name text NOT NULL,sources jsonb NOT NULL,destination text NOT NULL,
 enabled boolean NOT NULL,mode text NOT NULL CHECK(mode IN ('approved','filtered')),
 instructions text NOT NULL DEFAULT '',revision integer NOT NULL CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sharing_rules_destination ON sharing_rules(destination) WHERE enabled;
CREATE TABLE IF NOT EXISTS learning_consent (
 event_id text PRIMARY KEY,enabled boolean NOT NULL,reason text NOT NULL,
 revision integer NOT NULL CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT now()
);
`;

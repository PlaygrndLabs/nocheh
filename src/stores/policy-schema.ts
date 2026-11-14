export const controlPolicySchema=`
CREATE TABLE IF NOT EXISTS owner_commands (
 id text PRIMARY KEY,request_hash text NOT NULL,result jsonb NOT NULL,
 epoch bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE owner_commands ADD COLUMN IF NOT EXISTS holds_memory boolean NOT NULL DEFAULT true;
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
-- Dev mode: a project never shares between its groups (ADR-0247). The share box's columns go; the project rules they
-- wrote are deleted with their texts by the sharing schema, which runs after the tables those texts live in exist.
ALTER TABLE projects DROP COLUMN IF EXISTS sharing_enabled,DROP COLUMN IF EXISTS sharing_mode;
ALTER TABLE project_assignments DROP COLUMN IF EXISTS share_into;
-- A topic always follows its group's project (ADR-0247): a topic's own choice saved earlier becomes "follows its group".
UPDATE project_assignments SET mode='inherit',project_id=NULL,revision=revision+1,updated_at=now() WHERE space_id LIKE '%/topic/%' AND mode<>'inherit';
CREATE TABLE IF NOT EXISTS learning_consent (
 event_id text PRIMARY KEY,enabled boolean NOT NULL,reason text NOT NULL,
 revision integer NOT NULL CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT now()
);
`;

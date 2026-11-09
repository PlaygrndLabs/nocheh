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
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sharing_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sharing_mode text NOT NULL DEFAULT 'filtered' CHECK(sharing_mode IN ('approved','filtered'));
ALTER TABLE project_assignments ADD COLUMN IF NOT EXISTS share_into boolean NOT NULL DEFAULT true;
ALTER TABLE sharing_rules ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id);
CREATE INDEX IF NOT EXISTS sharing_rules_project ON sharing_rules(project_id,destination) WHERE project_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS learning_consent (
 event_id text PRIMARY KEY,enabled boolean NOT NULL,reason text NOT NULL,
 revision integer NOT NULL CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT now()
);
`;

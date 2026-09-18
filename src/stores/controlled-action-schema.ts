export const controlledActionSchema=`
CREATE TABLE IF NOT EXISTS controlled_actions (
 id text PRIMARY KEY,event_id text NOT NULL,source_reference jsonb NOT NULL,proposal_reference jsonb NOT NULL,
 binding jsonb NOT NULL,guard_revision integer,scope text NOT NULL,space_id text NOT NULL,
 profile text NOT NULL,logical_profile text NOT NULL,kind text NOT NULL CHECK(kind IN ('shell','browser','mcp')),
 fingerprint text NOT NULL,arguments_hash text NOT NULL,job_id text,
 state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','approved','rejected','running','done','failed','ambiguous')),
 revision integer NOT NULL DEFAULT 1,decision_reference jsonb,permission_id text,actor text,lease_until timestamptz,
 result_id text,result_reference jsonb,error_code text,security_decision jsonb,started_at timestamptz,execution_owner text,owner_epoch integer,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS controlled_action_queue ON controlled_actions(state,created_at);
CREATE TABLE IF NOT EXISTS action_permissions (
 id text PRIMARY KEY,action_id text NOT NULL REFERENCES controlled_actions(id),fingerprint text NOT NULL,
 proposal_reference jsonb NOT NULL,binding jsonb NOT NULL,scope text NOT NULL,profile text NOT NULL,
 kind text NOT NULL,job_id text,expires_at timestamptz NOT NULL,remaining integer NOT NULL CHECK(remaining>=0),
 revision integer NOT NULL DEFAULT 1,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS action_owner_commands (
 id text PRIMARY KEY,request_hash text NOT NULL,result jsonb NOT NULL,source_reference jsonb,created_at timestamptz NOT NULL DEFAULT now()
);
`;

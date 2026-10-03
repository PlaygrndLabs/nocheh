/** Authority and receipts only; generated proposal wording stays in derived storage. */
export const knowledgeManagementSchema=`
CREATE TABLE IF NOT EXISTS organization_delegations (
 id text PRIMARY KEY,name text NOT NULL,enabled boolean NOT NULL DEFAULT false,
 scopes jsonb NOT NULL,project_ids jsonb NOT NULL,allow_create boolean NOT NULL DEFAULT false,
 expires_at timestamptz,capture_watermark bigint NOT NULL,baselines jsonb NOT NULL,
 revision integer NOT NULL CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS organization_delegation_history (
 operation_id text PRIMARY KEY,delegation_id text NOT NULL REFERENCES organization_delegations(id),
 request_hash text NOT NULL,record jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS knowledge_proposals (
 id text PRIMARY KEY,request_hash text NOT NULL,kind text NOT NULL,origin text NOT NULL CHECK(origin IN ('turn','learning')),
 source_reference jsonb NOT NULL,source_scope text NOT NULL,logical_profile text,source_job_id text,
 proposal_reference jsonb NOT NULL,binding jsonb NOT NULL,dependencies jsonb NOT NULL,
 delegation_id text REFERENCES organization_delegations(id),delegation_revision integer,
 state text NOT NULL CHECK(state IN ('review','queued','waiting','applied','stale','cancelled','failed','undone')),
 revision integer NOT NULL DEFAULT 1,approved boolean NOT NULL DEFAULT false,result jsonb,error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_proposals_state ON knowledge_proposals(state,created_at,id);
CREATE TABLE IF NOT EXISTS knowledge_decisions (
 operation_id text PRIMARY KEY,proposal_id text NOT NULL REFERENCES knowledge_proposals(id),
 request_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS organization_project_origins (
 project_id text PRIMARY KEY REFERENCES projects(id),delegation_id text REFERENCES organization_delegations(id),
 proposal_id text NOT NULL REFERENCES knowledge_proposals(id),draft_key text NOT NULL
);
`;

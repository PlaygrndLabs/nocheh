export const memoryAccessSchema=`
CREATE TABLE IF NOT EXISTS memory_access_settings (
 destination text PRIMARY KEY, suggestions text CHECK(suggestions IN ('related','off')),
 notify_owner boolean,auto_followup boolean,request_ttl_seconds integer CHECK(request_ttl_seconds BETWEEN 60 AND 2592000),
 default_grant_mode text CHECK(default_grant_mode IN ('one_time','persistent')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(destination<>'*' OR (suggestions IS NOT NULL AND notify_owner IS NOT NULL AND auto_followup IS NOT NULL AND request_ttl_seconds IS NOT NULL AND default_grant_mode IS NOT NULL))
);
INSERT INTO memory_access_settings(destination,suggestions,notify_owner,auto_followup,request_ttl_seconds,default_grant_mode)
 VALUES('*','related',true,true,86400,'one_time') ON CONFLICT(destination) DO NOTHING;

CREATE TABLE IF NOT EXISTS memory_access_requests (
 id text PRIMARY KEY,request_hash text UNIQUE NOT NULL,source_reference jsonb NOT NULL,destination text NOT NULL,source_scope text NOT NULL,logical_profile text NOT NULL,
 query_hash text NOT NULL,fact_id text NOT NULL,fact_revision integer NOT NULL CHECK(fact_revision>0),
 proposal_reference jsonb NOT NULL,binding jsonb NOT NULL,relationship_path jsonb NOT NULL,evidence jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected','expired','delivered','suspended','cancelled')),
 decision text CHECK(decision IN ('one_time','persistent','reject')),grant_id text,
 notification_action_id text,followup_action_id text,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_access_requests_destination ON memory_access_requests(destination,state,created_at DESC,id);
CREATE INDEX IF NOT EXISTS memory_access_requests_fact ON memory_access_requests(fact_id,fact_revision,state);

CREATE TABLE IF NOT EXISTS memory_fact_grants (
 id text PRIMARY KEY,request_id text REFERENCES memory_access_requests(id),destination text NOT NULL,
 fact_id text NOT NULL,fact_revision integer NOT NULL CHECK(fact_revision>0),representation_reference jsonb NOT NULL,
 binding jsonb NOT NULL,guard_revision integer,text_hash text NOT NULL,mode text NOT NULL CHECK(mode IN ('one_time','persistent')),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','suspended','consumed','revoked','expired')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),expires_at timestamptz,delivery_action_id text,
 suspended_reason text,consumed_at timestamptz,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(mode='persistent' OR request_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS memory_fact_grants_destination ON memory_fact_grants(destination,state,created_at DESC,id);
CREATE INDEX IF NOT EXISTS memory_fact_grants_fact ON memory_fact_grants(fact_id,fact_revision,state);

CREATE TABLE IF NOT EXISTS memory_access_decisions (
 operation_id text PRIMARY KEY,request_hash text NOT NULL,request_id text REFERENCES memory_access_requests(id),
 grant_id text REFERENCES memory_fact_grants(id),decision text NOT NULL CHECK(decision IN ('one_time','persistent','reject','revoke')),
 revision integer NOT NULL CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now()
);
`;

export const telegramActionSchema=`
CREATE TABLE IF NOT EXISTS telegram_action_requests (
 id text PRIMARY KEY,source_reference jsonb NOT NULL,proposal_reference jsonb NOT NULL,
 binding jsonb NOT NULL,scope text NOT NULL,space_id text NOT NULL,profile text NOT NULL,
 destination text NOT NULL,fingerprint text NOT NULL,text_hash text NOT NULL,guard_revision integer,
 state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','approved','rejected','running','done','ambiguous','cancelled')),
 revision integer NOT NULL DEFAULT 1,decision_reference jsonb,security_decision jsonb,result_reference jsonb,
 error_code text,next_attempt timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS telegram_action_decisions (
 operation_id text PRIMARY KEY,request_hash text NOT NULL,action_id text NOT NULL REFERENCES telegram_action_requests(id),
 decision text NOT NULL CHECK(decision IN ('approve','deny')),revision integer NOT NULL,source_reference jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
`;

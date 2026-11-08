export const telegramActionSchema=`
CREATE TABLE IF NOT EXISTS telegram_action_requests (
 id text PRIMARY KEY,source_reference jsonb NOT NULL,proposal_reference jsonb NOT NULL,
 binding jsonb NOT NULL,scope text NOT NULL,space_id text NOT NULL,profile text NOT NULL,
 destination text NOT NULL,fingerprint text NOT NULL,text_hash text NOT NULL,guard_revision integer,
 authority text NOT NULL DEFAULT 'exact_owner_approval',
 state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','approved','rejected','running','done','ambiguous','cancelled')),
 revision integer NOT NULL DEFAULT 1,decision_reference jsonb,security_decision jsonb,result_reference jsonb,
 error_code text,next_attempt timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE telegram_action_requests ADD COLUMN IF NOT EXISTS authority text NOT NULL DEFAULT 'exact_owner_approval';
-- The owner's word on an unclear send (ADR-0218). The state stays as observed; it is never sent again.
ALTER TABLE telegram_action_requests ADD COLUMN IF NOT EXISTS resolution text CHECK(resolution IN ('ran','not_run','dismissed'));
ALTER TABLE telegram_action_requests ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
CREATE TABLE IF NOT EXISTS telegram_action_decisions (
 operation_id text PRIMARY KEY,request_hash text NOT NULL,action_id text NOT NULL REFERENCES telegram_action_requests(id),
 decision text NOT NULL CHECK(decision IN ('approve','deny')),revision integer NOT NULL,source_reference jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE telegram_action_decisions DROP CONSTRAINT IF EXISTS telegram_action_decisions_decision_check;
ALTER TABLE telegram_action_decisions ADD CONSTRAINT telegram_action_decisions_decision_check CHECK(decision IN ('approve','deny','ran','not_run','dismissed'));
`;

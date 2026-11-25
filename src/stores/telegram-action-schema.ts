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
-- The chat or topic (a chat id) its card was posted in, kept before posting, so its decision settles there (ADR-0254).
ALTER TABLE telegram_action_requests ADD COLUMN IF NOT EXISTS card_space text;
-- The member whose turn asked for the send (a chat_accounts id); null when the owner asked. A send a member asked for is
-- checked against that member again just before it is sent (step 3).
ALTER TABLE telegram_action_requests ADD COLUMN IF NOT EXISTS asker_account text CHECK(asker_account IS NULL OR asker_account ~ '^[a-f0-9]{64}$');
-- What kind of message the send is (ADR-0256): an approved post, a job's report, a scheduled result, or a notice, which
-- memory keeps but does not learn. Older rows have none and are approved posts.
ALTER TABLE telegram_action_requests ADD COLUMN IF NOT EXISTS send_class text CHECK(send_class IN ('approved_post','job_report','scheduled_run','notice'));
-- Who asked for the send through which agent, from the asking turn's one-time key (ADR-0305); null on Nocheh's own sends.
ALTER TABLE telegram_action_requests ADD COLUMN IF NOT EXISTS person text CHECK(person IS NULL OR person='owner' OR person ~ '^[a-f0-9]{64}$');
ALTER TABLE telegram_action_requests ADD COLUMN IF NOT EXISTS agent text CHECK(agent IS NULL OR agent ~ '^[a-z][a-z0-9-]{0,31}$');
CREATE TABLE IF NOT EXISTS telegram_action_decisions (
 operation_id text PRIMARY KEY,request_hash text NOT NULL,action_id text NOT NULL REFERENCES telegram_action_requests(id),
 decision text NOT NULL CHECK(decision IN ('approve','deny')),revision integer NOT NULL,source_reference jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE telegram_action_decisions DROP CONSTRAINT IF EXISTS telegram_action_decisions_decision_check;
ALTER TABLE telegram_action_decisions ADD CONSTRAINT telegram_action_decisions_decision_check CHECK(decision IN ('approve','deny','ran','not_run','dismissed'));
`;

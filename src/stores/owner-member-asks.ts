/*
 * The owner asks about a member (step 4b, ADR-0262). When the owner's own, not forwarded, message in the owner's private
 * chat names a member and asks what they said to Nocheh, the owner's turn records one row here and answers only that it
 * is queued. After that turn ends, a worker runs one read-only turn whose pass carries the row's id (the memberRead
 * claim, src/access.ts) and reads only that member's own private chat. Its answer goes to the owner's private chat as
 * a separate message of the never learned, never consentable send class member_read, and is then dropped: it is never
 * carried into the owner's ongoing conversation.
 *
 * In the control store after the member tables (member-schema.ts). Created only if missing, so the control bootstrap
 * runs again as a no-op. Removing a member removes their asks.
 * - id: the ask's id, 32 hex, also the memberRead claim.
 * - owner_event: the owner's message that asked (an event id).
 * - member_id: the member asked about.
 * - question: the owner's question as the owner's turn put it.
 * - state: queued, running, answered, failed or expired; error_code says why it failed.
 * - created_at, started_at, answered_at, expires_at: when it was asked, its turn started, its answer went out, and the
 *   time after which it no longer runs.
 * - send_key: the dispatch key its answer was sent under, to find the member_read send.
 *
 * Schema only; the repository, the route and the worker are part F's.
 */
export const ownerMemberAskStates=['queued','running','answered','failed','expired'] as const;
export type OwnerMemberAskState=typeof ownerMemberAskStates[number];
/** The longest question a row keeps. */
export const OWNER_MEMBER_ASK_QUESTION_LIMIT=4000;

export const ownerMemberAskSchema=`
CREATE TABLE IF NOT EXISTS owner_member_asks (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{32}$'),
 owner_event text NOT NULL CHECK(owner_event ~ '^[a-f0-9]{64}$'),
 member_id text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 question text NOT NULL CHECK(length(btrim(question))>0 AND length(question)<=${OWNER_MEMBER_ASK_QUESTION_LIMIT}),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN (${ownerMemberAskStates.map(state=>`'${state}'`).join(',')})),
 error_code text CHECK(error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,
 answered_at timestamptz,
 expires_at timestamptz NOT NULL,
 send_key text CHECK(send_key IS NULL OR length(send_key) BETWEEN 1 AND 256),
 UNIQUE(owner_event,member_id),
 CHECK(state<>'answered' OR answered_at IS NOT NULL),
 CHECK(state<>'failed' OR error_code IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS owner_member_asks_open ON owner_member_asks(state,created_at) WHERE state IN ('queued','running');
CREATE INDEX IF NOT EXISTS owner_member_asks_member ON owner_member_asks(member_id);
`;

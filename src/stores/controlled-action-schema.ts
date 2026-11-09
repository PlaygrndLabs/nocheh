/** What the owner can say about an operation or message whose outcome is unclear (ADR-0218). */
export const ownerResolutions=['ran','not_run','dismissed'] as const;
/** How an unclear outcome was closed. Only an unclear one carries it: a later receipt's state replaces it (ADR-0218). */
export const closedAs=(row:{state:string;resolution?:string|null;resolved_at?:Date|string|null})=>row.state==='ambiguous'&&row.resolution?
  {resolution:row.resolution as string,resolved_at:row.resolved_at??null}:{resolution:null,resolved_at:null};
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
-- A chat rule covers one site or exact command in one chat or topic (ADR-0214); an exact grant, one fingerprint and epoch.
ALTER TABLE controlled_actions ADD COLUMN IF NOT EXISTS match_key text;
-- The state the asking turn read whole while it waited, so no follow-up repeats that answer (ADR-0215).
ALTER TABLE controlled_actions ADD COLUMN IF NOT EXISTS observed_in_turn text;
ALTER TABLE action_permissions ADD COLUMN IF NOT EXISTS grain text NOT NULL DEFAULT 'exact' CHECK(grain IN ('exact','chat'));
ALTER TABLE action_permissions ADD COLUMN IF NOT EXISTS match_key text;
ALTER TABLE action_permissions ADD COLUMN IF NOT EXISTS space_id text;
ALTER TABLE action_permissions ADD COLUMN IF NOT EXISTS logical_profile text;
CREATE INDEX IF NOT EXISTS action_permission_rules ON action_permissions(match_key,space_id) WHERE grain='chat';
-- How an unclear outcome was closed: the owner's word, or a page read that closed itself (ADR-0218).
-- State and receipt stay as observed, so a later receipt still settles the action.
ALTER TABLE controlled_actions ADD COLUMN IF NOT EXISTS resolution text CHECK(resolution IN ('ran','not_run','dismissed','read_closed'));
ALTER TABLE controlled_actions ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
-- What the asker says an operation does, as content beside its proposal, for its card only (ADR-0220).
ALTER TABLE controlled_actions ADD COLUMN IF NOT EXISTS summary_reference jsonb;
-- Page reads that ended unclear before reads closed themselves.
UPDATE controlled_actions SET resolution='read_closed',resolved_at=updated_at WHERE state='ambiguous' AND kind='browser' AND resolution IS NULL;
CREATE TABLE IF NOT EXISTS action_owner_commands (
 id text PRIMARY KEY,request_hash text NOT NULL,result jsonb NOT NULL,source_reference jsonb,created_at timestamptz NOT NULL DEFAULT now()
);
`;

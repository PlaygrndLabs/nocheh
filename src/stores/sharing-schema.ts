/** Policy and publication receipts only. Text, candidates and provenance belong to derived. */
export const sharingContentSchema=`
CREATE TABLE IF NOT EXISTS sharing_previews (
 id text PRIMARY KEY,request_hash text NOT NULL,operation_reference jsonb NOT NULL,
 rule_id text NOT NULL REFERENCES sharing_rules(id),rule_revision integer NOT NULL,
 generation uuid NOT NULL,guard_epoch bigint NOT NULL,guard_mode text NOT NULL,
 input_reference jsonb NOT NULL,output_reference jsonb,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sharing_releases (
 id text PRIMARY KEY,preview_id text NOT NULL REFERENCES sharing_previews(id),
 rule_id text NOT NULL REFERENCES sharing_rules(id),rule_revision integer NOT NULL,
 generation uuid NOT NULL,guard_mode text NOT NULL,guard_revision integer,
 text_hash text NOT NULL,mode text NOT NULL CHECK(mode IN ('approved','filtered')),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
 revision integer NOT NULL DEFAULT 1,expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS sharing_releases_rule ON sharing_releases(rule_id,id) WHERE state='active';
`;

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
-- Dev mode: a project never shares between its groups (ADR-0246). Rules a project wrote are deleted, never turned off or
-- kept as the owner's, with their previews and released texts; the owner's own rules and their texts stay. Texts already
-- said in a group stay in its history. Runs only while the column that marks a project's rule still exists.
DO $$BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='sharing_rules' AND column_name='project_id') THEN
  DELETE FROM sharing_releases WHERE rule_id IN (SELECT id FROM sharing_rules WHERE project_id IS NOT NULL);
  DELETE FROM sharing_previews WHERE rule_id IN (SELECT id FROM sharing_rules WHERE project_id IS NOT NULL);
  DELETE FROM sharing_rules WHERE project_id IS NOT NULL;
  DROP INDEX IF EXISTS sharing_rules_project;
  ALTER TABLE sharing_rules DROP COLUMN project_id;
 END IF;
END$$;
`;

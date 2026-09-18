export const derivativeSelectionSchema=`
CREATE TABLE IF NOT EXISTS derivative_selections (
 id text PRIMARY KEY,event_id text NOT NULL,artifact_id text,kind text NOT NULL,
 active_revision integer,UNIQUE NULLS NOT DISTINCT(event_id,artifact_id,kind)
);
CREATE TABLE IF NOT EXISTS derivative_selection_revisions (
 operation_id text PRIMARY KEY,selection_id text NOT NULL REFERENCES derivative_selections(id),
 revision integer NOT NULL,expected_revision integer,derived_id text NOT NULL REFERENCES derived_artifacts(id),
 author text NOT NULL CHECK(author IN ('automatic','owner')),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(selection_id,revision)
);
ALTER TABLE derivative_selections ADD COLUMN IF NOT EXISTS imported boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS derivative_activations (
 operation_id text PRIMARY KEY REFERENCES derivative_selection_revisions(operation_id),
 activated_at timestamptz NOT NULL DEFAULT now()
);
`;

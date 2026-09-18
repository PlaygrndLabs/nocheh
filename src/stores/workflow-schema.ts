export const storageWorkflowSchema=`
CREATE TABLE IF NOT EXISTS learning_refresh_sweeps (
 installation_generation uuid NOT NULL,guard_epoch bigint NOT NULL,
 family text NOT NULL CHECK(family IN ('honcho','memory_review')),
 source_after_sequence bigint NOT NULL DEFAULT 0,learned_after text NOT NULL DEFAULT '',
 stage text NOT NULL DEFAULT 'sources' CHECK(stage IN ('sources','learned','done')),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(installation_generation,guard_epoch,family)
);
`;

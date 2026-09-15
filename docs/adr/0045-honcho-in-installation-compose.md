# ADR-0045: Run production Honcho in the installation Compose project

<decision>

The owner requested removal of redundant Nocheh groups and completed worktrees.
Production Honcho follows the one-project requirement in SPECS.md and ADR-0036.
The installation Compose file owns its database, Redis, API, deriver, metered
provider boundary, and read-only CLI. The explicit `honcho` profile starts only
for an installation configured to run Honcho; that setting does not attach memory
or grant acceptance, historical learning, or additional spending.

The private Honcho network and metered egress remain separate. Hermes has neither
a direct connection nor credentials. The archive and worker use the existing
`honcho-memory` alias. Database and Redis volumes are external and explicitly
recorded, so routine Compose shutdown and worktree removal cannot delete them.
Host maintenance includes Honcho writers in the common quiescence sequence.
Restores disable its profile and replace saved live storage paths and volume names.

</decision>

<migration>

Pause workflow admission and drain current execution. Stop Honcho writers, save
Redis, and record a private database dump, table fingerprints, volume identities,
credential hashes, and the spending ledger at that recovery point. Stop the old
database and Redis before starting their replacements against those exact volumes.
Compare database fingerprints before starting the new API and deriver. Preserve
attachment, generations, source receipts, spending policy, and the shared login.
Remove old containers and their empty private networks only after verification;
keep the external volumes and recovery evidence.

Rollback stops the new writers and storage containers before restoring the old
project against those same volumes and compatible code. No two database processes
or memory writers may own the same state. The historical experiment remains an
explicit isolated facility; it cannot start alongside production or silently create
a new empty memory database when legacy data exists.

</migration>

<verification>

Check profile and restore isolation, direct-agent network denial, preservation of
external storage, rejection of concurrent legacy writers, and refusal to replace
existing data with an empty database. Verify the local transition and recovery
separately from code integration. Runtime status and evidence belong in TASK.md.

</verification>

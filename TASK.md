# Nocheh implementation status

<current>

Last reconciled 2026-09-28. [SPECS.md](SPECS.md) defines the product;
[AGENTS.md](AGENTS.md) defines working instructions. Prior implementation and
live observations are summarized in [task history](docs/task-history.md).

Nocheh is pre-release. The owner requested a clean setup, deletion of old
containers and application data, preservation of credentials and settings,
and startup in development mode.

The root Compose file now defines the archive, derived, control, and workflow
stores directly. The separate storage overlay, legacy executable entrypoints,
retired sidecar imports, and old preview path are removed. Development source
comes from the session worktree. Fresh volumes are created with Compose ownership;
normal stops retain them. [Decision](docs/adr/0075-clean-development-setup.md),
[commands](docs/deploy.md), [layout](docs/repository-layout.md).

Fresh local setup now enables and prepares the Honcho service by default; an
explicit saved disable remains effective. The current installation already has
the Honcho service running, but its memory connection is detached and unverified.
Service startup does not bypass live memory acceptance. [Decision](docs/adr/0076-honcho-enabled-local-default.md),
[procedure](docs/release-acceptance.md).

The active installation's 17 containers and six mounted volumes were removed.
Six verified obsolete preview volumes and retired local runtime/output directories
were also removed. Current credentials, bot settings, dashboard settings, bounded
native preferences, and spending accounting were preserved. All captured control settings were
verified equal after reset; the temporary private preservation copy was removed. Fresh archive events
and learned entries both counted zero before capture. Pending Telegram updates
were discarded once. Source worktree archives and separate synthetic fixture
projects were not deleted.

</current>

<verification>

- TypeScript/dashboard build and focused storage-role configuration tests passed.
- Launcher safety (13), installation configuration (8), database browser (5),
  Honcho setup (3), deployment CLI (5), and admin CLI (9) tests passed.
- Operating/development Compose render and source/volume identity checks passed.
- PostgreSQL/TypeScript suite: 147 passed, 49 fixture-gated skips; the database
  disconnect check passed. The final exact-source native suite passed 371 tests
  with two fixture-gated skips in the revision-checked pinned runtime. The
  all-in-one test command's redundant native image rebuild was interrupted;
  its database/TypeScript stages passed and native tests completed separately.
- All 17 development services are healthy. App and dashboard endpoints respond.
  One configured Telegram poller and one provider service are running. Source
  reload passed: a source touch produced a new asset revision, restarted Node,
  and returned healthy without recreating the app container. The concurrent
  native image rebuild slowed this check; it was stopped after the isolated
  PostgreSQL/TypeScript and disconnect gates had passed.
- Reset initialization and failure-path tests (5) passed.
- Documentation links, obsolete file references, and credential-pattern scans passed.
- AST-only graph refreshed: 558 files, zero model calls.
- Honcho-default configuration, runtime-profile, and workflow-key tests passed
  (18); a synthetic fresh-install Compose render includes all five Honcho
  services. The AST-only graph refreshed again after this code change (558 files,
  zero model calls). The broader host native suite cannot pass outside its pinned
  runtime and restricted socket environment; its prior exact-source run is not
  evidence for this increment.

</verification>

<pending>

- Fresh live release acceptance is required after this reset: owner text, voice,
  intentional group silence, corrections, reaction interpretation, active recall,
  restart/recovery, and linked replies. Prior live observations are historical.
  Subscription transcription remains a release requirement.
- Honcho activation and current recall must be verified against the fresh stores.
  Preserved pilot reservations reached the accepted cap. A clarified owner
  decision on separately billed API embedding spend is pending before paid live
  acceptance. Historical ingestion remains unapproved.
- Investigate prior slow owner replies and transient runtime/tool registration
  failures when fresh live traffic supplies evidence.
- Run populated backup/recovery acceptance when fresh data exists. The prior
  incomplete backups were deleted with the authorized application-data reset.
- Remote Git synchronization remains blocked by private material in reachable
  history. Sanitize and verify history before pushing; do not upload those blobs.
  The earlier HTTPS authentication failure also needs verification at push time.

</pending>

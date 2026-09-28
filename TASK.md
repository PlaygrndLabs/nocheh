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
explicit saved disable remains effective. The operating installation has passed
the six-check synthetic Honcho acceptance and is verified and attached with
Honcho as primary memory. Historical ingestion is off. A fresh owner source has
now produced a ready generation, so memory availability is no longer limited;
owner-visible Honcho recall passed in a follow-up Telegram turn. Service startup does
not bypass live memory acceptance. [Decision](docs/adr/0076-honcho-enabled-local-default.md),
[procedure](docs/release-acceptance.md).

The Honcho dashboard exposes the accepted monthly embedding cap for owner edits
and shows reservations, remaining admission headroom, request counts, reported
tokens, and a separate usage-based cost estimate. The pilot cap stays fixed;
the accepted monthly cap starts at $5 and permits $0–$15 in cent increments.
Budget changes retain reservations and use revision-checked, retry-safe writes.
[Decision](docs/adr/0078-owner-honcho-budget-control.md).

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
- A fresh synthetic Honcho acceptance workspace completed one guarded
  subscription reasoning call with the expected answer and usage report, then
  closed. Its ledger reservation was zero and the preserved $5 pilot total did
  not change. This is one live preflight check, not embedding, ingestion, recall,
  restart, provider-failure, or production attachment acceptance. The metadata
  report is retained only in ignored local acceptance state.
- The owner selected the $5 UTC-monthly embedding cap for live testing after
  clarification that API embeddings are billed separately from ChatGPT. A narrow
  exhausted-pilot preattachment cutover passed focused allowance, rejection, and
  idempotence checks (20 focused tests total). The AST-only graph refreshed with
  559 files and zero model calls. The operating ledger entered monthly mode.
- A new, closed synthetic acceptance workspace passed subscription reasoning,
  guarded embedding, ingestion, retrieval, restart persistence, and provider
  failure/recovery. The gateway returned the expected failure while isolated and
  recovered after its egress network was restored. The monthly ledger reserved
  $0.07 of $5 at verification; reservations are conservative rather than an API
  invoice. The local acceptance record is in ignored state. Verification was
  accepted and Honcho attached without historical ingestion. The operating admin
  status reported verified, attached, and primary Honcho before owner capture.
- An ordinary owner Telegram message was captured after attachment. Its guarded
  source was ingested with a completed Honcho receipt, and the owner generation
  reached ready. Subsequent synchronization retained that ready snapshot;
  operating status now reports limited memory false. Event and receipt IDs are
  retained only in ignored local acceptance state.
- An ordinary owner follow-up asked for the remembered phrase. A Honcho memory
  result containing that phrase preceded the delivered Telegram answer, which
  contained the phrase. The Telegram workflow completed after a transient
  runtime-unavailable retry. The operating status remained limited memory false;
  the monthly ledger reserved $0.31 of $5 after this check. Private identifiers
  and the metadata report remain in ignored local acceptance state.
- Honcho budget ledger, mutation gate, and management route focused tests passed
  (10 native, 2 TypeScript management tests). The TypeScript/dashboard build
  passed in the pinned local development image. The source-watched dashboard
  preview loaded the operating monthly ledger: $5 cap, $0.31 reserved,
  $4.69 headroom, 31 embedding and 18 reasoning requests, and 9,280 reported
  embedding tokens. At the configured model price, the displayed usage estimate
  was $0.0001856. This estimate is not a provider invoice; one embedding call
  lacked a token report. The edit control enabled for a draft change, then
  reload restored the saved $5 cap; the live cap was not changed during preview.
  The AST-only graph refreshed with 561 files and zero model calls.
- A fresh owner voice note on this installation passed the release voice check.
  The 11,998 stored original audio bytes matched their saved size and SHA-256;
  a separate `nocheh-subscription` transcript exactly matched the expected
  sentence, and one delivered Telegram reply had a saved source link to the
  voice event. The content-free event, artifact, transcript, reply, workflow,
  and retry evidence is retained only in ignored local acceptance state.
  Delivery completed on the fifth attempt. Four earlier native dispatch
  receipts failed closed with `unexpected_profile_tool` for `tool_call`,
  `tool_describe`, and `tool_search`; the profile configuration had tool search
  disabled. A process-level policy now pins tool search off before native agent
  construction, so a native config-loader fallback cannot expose its bridge.
  Focused scope tests and a credential-free isolated-image check passed with a
  synthetic profile that enabled tool search. The exact cause of the earlier
  intermittent config reads is unproven. The operating isolated-turn image has
  not been replaced, so the live retry and latency outcome remains unverified.

</verification>

<pending>

- Fresh live release acceptance is still required after this reset: owner text,
  intentional group silence, corrections, reaction interpretation, active recall,
  restart/recovery, and linked replies. Prior live observations are historical;
  the current-installation voice and subscription transcription check has passed.
- Complete the other fresh owner-facing release checks in
  [release acceptance](docs/release-acceptance.md); Honcho attachment, owner
  recall, and voice now pass. Historical ingestion remains unapproved.
- Activate the verified tool-search policy in the operating isolated-turn image
  through a controlled image refresh, then confirm on the next naturally sent
  owner turn that tool registration passes on its first attempt. Keep the saved
  attempt receipts for latency comparison; do not widen the profile tool
  allowlist.
- Run populated backup/recovery acceptance when fresh data exists. The prior
  incomplete backups were deleted with the authorized application-data reset.
- Remote Git synchronization remains blocked by private material in reachable
  history. Sanitize and verify history before pushing; do not upload those blobs.
  The earlier HTTPS authentication failure also needs verification at push time.

</pending>

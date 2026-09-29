# Nocheh implementation status

<current>

Last reconciled 2026-09-29. [SPECS.md](SPECS.md) defines the product;
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

The Honcho dashboard separates the paid API embedding dollar cap from
subscription reasoning's request safety limit. Confirmed embedding calls with
reported usage now settle their pre-egress hold to token-priced admission
accounting; failed and unreported calls retain the full model-specific hold.
The pilot cap stays fixed; the accepted monthly cap starts at $5 and permits
$0–$15 in cent increments. Budget changes retain call accounting and use
revision-checked, retry-safe writes. [Decision](docs/adr/0079-separated-honcho-budgets-and-settlement.md).

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
  intermittent config reads is unproven. Later activation and a live result are
  recorded below.
- Honcho budget settlement, embedding-model, and independent reasoning-limit
  checks passed (14 focused tests) in a disposable pinned runtime. The dashboard
  bundle built offline with pinned app dependencies, and the AST-only graph
  refreshed from 561 files with zero model calls.
  The live Memory preview showed separate API embedding and subscription panels:
  140 embedding requests, 83 subscription reasoning requests, $0.011248 counted
  toward the $5 embedding cap, and $0.001178 reported-token cost estimate.
  One embedding request lacked a usage report and retains its full hold. The
  screenshot of OpenAI usage shows less than $0.01 for the day; the local estimate
  is neither that day-only provider total nor an invoice. No paid call or cap
  edit was made for this UI check. A source-watched asset rebuild failed with
  `EROFS` on the generated dashboard volume; the verified bundle was copied
  into that preview volume without recreating it.
- Fresh owner text received one linked Telegram reply on the first attempt;
  the owner confirmed one sensible visible reply. A networkless one-file Hermes
  image overlay for the tool-search policy passed eight focused native checks.
  With no isolated turn active, only the launcher restarted and pinned that
  image. All 17 services remained healthy. Its next owner turn used the exact
  candidate image and delivered one owner-confirmed reply on the first attempt.
  The old image retains a rollback tag. The earlier config-read cause remains
  unproven; text replies still took about two minutes.
- A fresh private synthetic phrase received one linked, owner-confirmed reply
  and a completed Honcho receipt. The group question used a different scope;
  its one linked reply omitted the private phrase. Its saved dispatch binding
  used the group scope, and 336 event-bound runtime contexts had zero matches
  for the phrase or private source ID. The owner requested admin-CLI inspection
  of that reply. A later private recall returned the exact phrase in one linked
  first-attempt reply. Content-free evidence is in ignored local acceptance state.
- Fresh intentional silence in that same group ended `suppressed` with
  `intentional_silence`. Its Telegram workflow was skipped and there was no
  linked reply. The captured event and checks are saved only in ignored local
  acceptance state.
- Fresh exact owner approval proposed one Telegram message with the requested
  text and the original private-chat destination. The owner approved that
  action via Telegram. One exact delivered message was captured in that scope;
  the native action receipt was `done`. Replaying the completed action returned
  its saved result, and the exact delivered-message count remained one. The
  content-free action and receipt evidence is in ignored local acceptance state.
- Fresh owner retirement passed across two sources. The first source was
  retired after its reply had already been delivered; a later first-attempt
  answer and four event-bound contexts excluded its content, and owner Undo
  restored it at revision 2 while preserving the original and reply. A second
  ordinary private message was captured with zero replies and retired at
  revision 1 before delivery. Archive kept its original inspectable; its
  Telegram workflow closed `cancelled` at admission with no delivery receipt,
  and the source still had zero linked replies after closure. Content-free
  event, revision, and workflow evidence is in ignored local acceptance state.
- A populated format-6 backup completed after two earlier snapshots exposed
  unsafe development-stack resume paths. The final backup saved 427 state files
  and 88 table fingerprints, resumed the same existing service and executor
  containers, and passed checksum validation. An inactive restore of that
  exact snapshot verified all three stores and 427 files. Telegram, executors,
  scheduling, controlled tools, and provider login remained held; the restored
  services were stopped afterward. The operating 17 services returned healthy
  with one Telegram poller and one provider owner. The generated dashboard
  volume was repaired to the app UID after a restart exposed root ownership;
  the app rebuilt and recovered health. The development app build now receives
  the operating UID/GID; the Compose render and focused recovery tests passed.
  The AST graph was refreshed with 561 files and zero model calls. Content-free
  evidence and both private snapshots remain in ignored local state.
- After those controlled restarts, the previously owner-confirmed private
  acknowledgment still had one linked reply and a completed Telegram workflow.
  The exact-approval request still had one linked reply, and the newly retired
  source still had zero replies with a cancelled workflow. These are
  post-completion durability checks; no in-flight owner turn was restarted.
- A new ordinary owner acknowledgment was captured with zero replies, then the
  supervised Hermes container restarted. It became healthy before the event's
  first Telegram execution attempt. One nonempty acknowledgment arrived after
  the restart; the linked source retained exactly one reply, and its workflow
  completed delivery on the first execution attempt with one durable receipt.
  The dashboard health endpoint had independently stopped listening after a
  development source reload; restarting only that container restored health.
  The 17 operating services were healthy afterward. Event, receipt, and restart
  timestamps are saved in ignored local acceptance state.
- The owner correction portion of fresh acceptance passed on test-only learned
  memory: one duplicate interpretation was retired by an owner-authored
  revision-checked action at revision 2. A separate interpretation of the same
  synthetic private fact received an owner-authored active revision 2, and its
  post-correction Honcho projection receipt completed. The owner then sent a
  new ordinary private recall question. It was captured after both corrections
  and the completed projection; the one linked answer contained the correct
  synthetic phrase, its Telegram workflow completed delivery on the first
  execution attempt with one receipt, and the owner confirmed seeing exactly
  one correct reply. This completes the learned-recall gate. Operation IDs and
  content remain in ignored local acceptance state.
- Read-only Telegram checks found the selected configured group is now a forum,
  with Nocheh holding administrator and topic-management rights. An older
  captured synthetic note in a known forum topic was selected for the
  non-owner reaction sequence; it had zero linked replies before the check.
  The human add/change/remove updates and topic-isolation evidence remain
  pending. Group identity, message ID, and topic ID remain in ignored local
  acceptance state.

</verification>

<pending>

- Complete the remaining fresh live checks in
  [release acceptance](docs/release-acceptance.md): non-owner reaction
  change/removal and derived meaning, including forum-topic isolation. The
  selected group and bot admin rights are verified; the non-owner human's
  reaction updates are still required. Owner text, group silence and isolation,
  private recall,
  exact owner approval, owner retirement, owner correction and active learned
  recall, in-flight restart/recovery, populated backup/restore, Honcho
  attachment, and subscription voice transcription have current-installation
  evidence.
  Historical ingestion remains unapproved.
- Investigate the roughly two-to-five-minute owner text replies and confirm continued
  first-attempt tool registration on later turns. The earlier intermittent
  native config-read cause is not established; do not widen the profile tool
  allowlist. One owner-text workflow began its native receipt about 46 seconds
  after capture; the saved native turn then reported 62.9 seconds total,
  including 52.4 seconds of conversation and 26.0 seconds of model guarding
  (overlapping timings). This narrows the delay but does not explain its cause.
- Remote Git synchronization remains blocked by private material in reachable
  history. Sanitize and verify history before pushing; do not upload those blobs.
  The earlier HTTPS authentication failure also needs verification at push time.

</pending>

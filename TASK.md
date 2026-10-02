# Nocheh implementation status

<current>

Last reconciled 2026-10-02. [SPECS.md](SPECS.md) defines the product;
[AGENTS.md](AGENTS.md) defines working instructions. Prior implementation and
live observations are summarized in [task history](docs/task-history.md).
The [MVP live acceptance register](docs/mvp-acceptance-status.md) records passed
checks, caveats, remaining gates, and reasons to repeat only affected checks.

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
Honcho as primary memory. Historical ingestion is off. A fresh owner source produced a ready generation and owner-visible Honcho
recall passed in a follow-up Telegram turn. At the latest recorded inspection,
all four rebuilt guard-epoch generations were ready with snapshots. Service
startup does not bypass live memory acceptance. [Decision](docs/adr/0076-honcho-enabled-local-default.md),
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

- The September 28–29 installation has retained passing evidence for owner text,
  group silence and isolation, subscription voice transcription (with its original
  retry caveat), exact approval, retirement and Undo, learned recall and owner
  correction, captured-turn restart recovery, populated backup/inactive restore,
  Honcho attachment, and non-owner reactions with named-topic isolation. The
  [acceptance register](docs/mvp-acceptance-status.md) retains the scope and limits;
  [task history](docs/task-history.md) retains the chronological summaries. These
  are carried observations, not newly repeated tests.
- The empty-completion candidate passed 16 focused native checks in its pinned,
  networkless runtime. Operating activation and affected live evidence remain
  pending.
- The release audit verified hashes for every report supporting the 11 completed
  acceptance areas. One later-updated topic report is referenced by two open
  rows; its index hashes and readiness status require reconciliation.
- Event-bound provider timing now separates broker preparation, upstream headers,
  upstream byte waits, and downstream forwarding. The TypeScript/dashboard build,
  seven focused broker/security/storage checks, and eleven admin CLI checks pass.
  One storage check initially lost its database connection during the operating
  backup failure; that affected check passed on its isolated rerun. The AST graph
  refreshed from 564 files with no model calls. This is candidate evidence;
  timing telemetry has not yet been activated or measured in a live owner turn.
- The operating source checkout's three local edits exactly match integrated
  main. A private patch preserves them; the original checkout remains intact.
  All 17 services were healthy at initial inspection, then exited with code 255.
  Only the existing database and workflow-cache services were restarted for a
  quiesced backup. The backup failed while fingerprinting workflow storage after
  PostgreSQL reported temporary disk exhaustion; no complete snapshot or release
  pass is claimed. Partial dumps remain private and are not recovery evidence.
- Remote fetch succeeded. Private historical report paths are already reachable
  from origin/main, so ordinary fast-forward publication cannot remove them.
  History cleanup is being prepared separately; no remote rewrite has occurred.

</verification>

<pending>

- Empty-completion rejection is implemented and verified in the candidate;
  operating Hermes activation and affected live evidence remain pending.
- Dependable answers take priority over speed. Next, assess the existing General
  answer and the same-topic recall limitation from retained evidence, and
  diagnose the first native timeout as a completion/recovery issue. A healthy
  stack or ready snapshot does not establish answer quality.
- Event-bound LLM timing is implemented and verified in the candidate. Activate
  it with the reconciled runtime, collect affected live evidence, and assess
  local waiting separately from provider transport waits. The
  [CLI guide](docs/admin-cli.md) defines the boundaries and overlap limits.
- Repair the workflow backup fingerprint sort, verify backward-compatible restore,
  and complete a new populated backup before runtime activation. Preserve data;
  do not remove workflow history to make the backup fit.
- Finish release-candidate evidence and runtime-pin reconciliation against
  [release acceptance](docs/release-acceptance.md), using the
  [acceptance register](docs/mvp-acceptance-status.md). Audit retained provider
  refresh, quota/failure, and literal-detection evidence before deciding whether
  any specific check needs repeating. Owner text,
  group silence and isolation, private recall, exact owner approval, owner
  retirement, owner correction and active learned recall, in-flight
  restart/recovery, populated backup/restore, Honcho attachment, subscription
  voice transcription, and the full non-owner reaction and named-topic isolation
  sequence have current-installation evidence. Historical ingestion remains
  unapproved. The deliberate-reset journal validator does not apply to this
  clean development setup, which has no reset coordinator journal.
- The existing General turn recovered on its second Telegram execution attempt
  and has one linked reply. Its first native attempt timed out before delivery
  after about 233 seconds; the successful native turn took 136.6 seconds,
  including 110.6 seconds of conversation and 27.0 seconds of model guarding.
  Scope/archive preservation and exclusion of named-topic sources were checked
  earlier. Reply content and owner-visible quality have not been confirmed.
- The same-topic reaction question had one first-attempt reply after 424.4
  seconds, but it could not identify the old reaction and truthfully reported
  limited memory. Its topic generation had no ready snapshot at question time;
  it became ready roughly an hour later. The current guard epoch has completed
  Nocheh ingestion and, after focused deriver activation, its topic generation
  reached ready with one snapshot and 24 of 24 Honcho work units complete. All
  four current generations are now ready with snapshots.
  This does not retroactively correct the earlier answer or establish fresh
  same-topic recall. Do not infer a new reaction state from removed observations.
- Reply latency has separate observed stages. The same-topic turn spent about
  116 seconds in preparation, roughly 190 seconds before native receipt start,
  and 109.6 seconds in the native turn, including 97.5 seconds of conversation
  and 58.4 seconds of model guarding (overlapping timings). A locally verified
  scheduling change reserves one storage workflow slot for foreground work and
  new setup uses two Honcho deriver workers. The owner authorized focused live
  activation. The verified source is compiled in the operating watcher, and
  only the Honcho deriver was recreated with two workers. All 17 services are
  healthy; the app, Hermes, Honcho API, and provider gateway kept their container
  identities. The topic queue completed and its generation became ready, but
  no new reply has measured admission latency. The two
  existing General-topic edits remain intact.
  The native 230-second timeout and earlier intermittent config read still
  need separate diagnosis. Do not widen the profile tool allowlist.
- Remote Git synchronization remains blocked by private material in reachable
  history. Sanitize and verify history before pushing; do not upload those blobs.
  The earlier HTTPS authentication failure also needs verification at push time.

</pending>

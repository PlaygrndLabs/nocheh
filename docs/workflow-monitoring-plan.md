<execution_plan>

# Local Inngest workflow migration

<authority>

Accepted by the owner's implementation request on 2026-09-12. Product requirements
live in [SPECS.md](../SPECS.md), the architectural decision in
[ADR-0041](adr/0041-local-inngest-workflows.md), and actual progress and activation
in [TASK.md](../TASK.md). This plan does not claim any runtime gate has passed.

</authority>

<sequence>

## Verified increments

| Phase | Work | Acceptance before completion |
| --- | --- | --- |
| I1 — Foundation and recovery | Pin SDK 4.20.0/server 1.44.0 and image digests; dedicated PostgreSQL database/role, persistent Redis, separate Connect apps, credentials and health; quiesced backups and inactive restore; isolated Compose fixture | Real server/SDK registration and checkpoint recovery, PostgreSQL/Redis restart, isolated ports/images/state, backup/restore integrity and inactive workers |
| I2 — Outbox and execution safety | Transactional publication, registry, permanent deduplication, receipts and family ownership fencing; job-ID operations and single retry authority | Rollback, lost acknowledgment, concurrent/delayed duplicates beyond 24h, publisher restart, crash/effect/receipt gaps, stale authority rejection |
| I3 — Telegram pipeline | Attachment/transcription/preparation steps and receipt-protected native dispatch; independent capture/poller; asynchronous runtime contracts and observed delivery progress | Text/media fixtures, quota and guard waits, stored-result reuse, silence, uncertain delivery, runtime/worker restart without duplicate execution |
| I4 — Imports and memory | Bounded import batches/checkpoints, native review, Honcho reconciliation/rebuild; source/edit/consent/generation triggers | Cancellation/resume, stable identities, zero historical replies, consent separation, stale revisions/generations, detached Honcho and uncertain writes |
| I5 — Browser, schedules, approvals | Durable browser submission with native streaming/resume; Inngest schedule waits and native definition helpers; exact approved actions | Browser reconnect/cancel, profile exclusion, schedule revision/cadence/missed/overlap/repeat/catch-up, revocation and uncertain effects |
| I6 — Monitoring | Owner API/CLI list/detail/retry/cancel; dashboard summaries and read-only authenticated Inngest inspection | Pagination, status distinctions, data boundary, session/CSRF checks, unavailable/stale services, UI interaction/accessibility |
| I7 — Local cutover | Per-family pause/drain/reconcile/fenced switch/backfill of eligible unfinished work; compatible rollback | Isolated fault suite, quiesced recovery, actual local family checks, real Telegram text/voice/group/isolation/approval/restart acceptance |

Each phase may contain smaller independently verified commits. Follow the shared
Git lock/integration workflow in AGENTS.md. Continue independent work when a live
dependency is unavailable; record dependent gates as pending.

</sequence>

<implementation>

## Execution boundaries

Keep the Compose and host workers as separate Connect applications with stable
function/step IDs and build versions. Bind requests to existing source/job
identities and resolve protected data only inside steps. Domain receipts remain
authoritative when runtime responses or Inngest checkpoints are lost. Family
ownership fences apply to old and new runners before any effect.

Capture/spool draining and outbox delivery are supervised outside Inngest. Host
maintenance is independent so it can stop or recover Inngest. Native reasoning
and synchronous security enforcement are not rewritten. Workflow migrations do
not activate provider routes or attach Honcho.

Use additive schema changes and preserve native/browser/CLI compatibility. Extend
runtime run.start, run.events, run.resume and run.cancel instead of exposing
Hermes identifiers or credential transport through the owner interface. Inngest
permits inspection; Nocheh endpoints validate retry/cancel requests.

<monitoring_implementation>

I6 exposes `/api/nocheh/workflows` list/detail and revision-validated retry/cancel,
with `./scripts/nocheh workflows list|show|status|retry|cancel` equivalents. Closed
outcomes and active effects reject generic controls. Native schedule definitions
and source/consent policies retain their existing controls. An explicitly resumed
cancelled memory review creates a new generation while preserving its closed
receipt. Domain state reconciles observations; stored errors and protected source
content never enter the owner metadata projection.

The pinned native Inngest UI is served under `/inngest` with an existing owner
session. Only parsed, allowlisted GraphQL queries reach its backend; mutations,
event ingestion and debugger paths are denied. Its pinned route/client adapters
and local read-only value renderer are covered by fixture and browser checks.
See [ADR-0043](adr/0043-owner-workflow-inspection.md) and
[monitoring evidence](../compatibility/results/2026-09-14-inngest-monitoring.json).

The synthetic Monitoring preview uses an explicit fixture-only network, generated
credentials, no runtime/executor, and dedicated loopback ports. This does not
implement general installation preview isolation or `make dev`.

</monitoring_implementation>

<cutover_implementation>

The first I7 increment provides durable migration records and host commands:
`workflows pause-family FAMILY --owner inngest --epoch EPOCH`,
`workflows migration ID`, `workflows reconcile ID`, `workflows switch ID`, and
`workflows abort ID`. Use the family epoch from `workflows status`. Reuse the
returned migration ID after a lost response. `--migration-id` supplies a known ID
when retrying a pause whose response was lost.

Pause closes admission independently of Inngest. Reconciliation reads existing
native identities with `observe_only`; it never launches a queued or replacement
effect. A missing receipt stays unresolved. Switching requires drained family
locks, no live step leases, reconciled domain records and a recently registered
worker. Existing eligible archive identities are backfilled; completed, denied,
cancelled, suppressed and ambiguous outcomes stay closed. Ownership, new dispatch
IDs, outbox entries and the migration receipt commit together. Failure leaves the
family paused at its previous epoch.

Rollback uses the same commands with `--owner legacy`. It refuses to expose a
closed registry outcome to an eligible old scanner. Abort reopens the existing
owner without changing its epoch. Both operations preserve source data and native
receipts; neither restores an old database snapshot over new evidence.

Imports and tools additionally require `workflows host-handoff ID` before
switching. The host worker is drained independently of Inngest. For imports,
stop the owner dashboard first; handoff reserves its port without serving traffic
and locks each existing job while reading its protected record. Only confirmed,
unfinished jobs are adopted, with the same upload hash, scope mapping, explicit
learning choice and checkpoint. Closed jobs remain closed. A legacy import
interrupted by admission pause becomes resumable instead of a terminal failure.

Tool handoff drains both host executors and publishes retained receipts through
the existing actor-validated finish endpoint. It never claims another action.
A lost acknowledgment retains the receipt for replay. Previously running
supervisors resume after handoff while the family admission fence remains closed.

Rollback preserves import checkpoints and exposes the existing explicit Resume
import action. Its learning choice cannot change. A resumed cancelled import gets
a new generation; the original closed receipt remains permanent. Legacy import
completion is mirrored to the registry's domain record, with a protected host
receipt retained until acknowledged. Host-ready status is durable and required
for both directions of imports/tools ownership changes.

The fresh candidate fault rehearsal passed with separate synthetic Compose
projects. It covers Inngest, Redis, PostgreSQL, worker, publisher and runtime
outages; durable capture; crash after a runtime effect but before acknowledgment;
worker kill; legacy scanner rollback; and quiesced inactive restore. Real local
activation remains pending. Fixture evidence does not establish that the active
installation has passed its cutover gates.

<fault_rehearsal>

Combine `compatibility/inngest-compose.yml` with
`compatibility/inngest-fault-compose.yml`. Supply a fresh synthetic dotenv file
with a unique `NOCHEH_FIXTURE_PROJECT` matching `nocheh-inngest-fault-HEX`,
`NOCHEH_FAULT_SCHEMA=fault_HEX`, an absolute `NOCHEH_FAULT_STATE` under this
worktree's `data/`, a separately tagged `NOCHEH_FIXTURE_IMAGE`, and independently
generated 64-hex PostgreSQL, Inngest and service credentials. No ports are
published and the network is internal. Services use production restart policies.

The `fault-check` command `node dist/test/workflow-fault-probe.js` accepts `init`,
`capture LABEL`, `migrate inngest|legacy`, `status`, `verify SOURCE_COUNT`,
`crash-receipt`, and `legacy-drain SOURCE_COUNT`. Start `fault-runtime`,
`fault-worker`, and `fault-publisher` only inside that project. Stop/restart each
dependency separately and wait for its expected source count before the next
fault. `crash-receipt` arms an exit after the next synthetic runtime receipt is
fsynced, before its HTTP response. Runtime requests never reach a provider.

`python3 -m scripts.workflow_fixture_recovery FIXTURE_ENV FRESH_DESTINATION`
stops the fixture's execution authorities and Inngest, then uses the production
workflow snapshot/restore functions. A fresh restore project verifies archive and
Inngest table fingerprints, protected file hashes, Redis AOF conversion and a
database restart. Only restored PostgreSQL and Redis are started. Pending capture
and inactive markers remain available for inspection; restored workers and event
publication are not enabled. See
[fault and recovery evidence](../compatibility/results/2026-09-14-inngest-fault-recovery.json).

</fault_rehearsal>

</cutover_implementation>

</implementation>

<acceptance>

## Acceptance procedure

Use an explicit fixture Compose project with unique images, networks, ports,
storage and synthetic credentials. Never copy the installation's login into a
fixture. Run existing service, pinned Hermes, and recovery suites plus focused
workflow failures. Inspect captured Inngest event/step/error payloads with
synthetic secret canaries to verify the data boundary.

Before each local family switch, back up, pause admission, drain its old runner,
reconcile outstanding receipts and change authority transactionally. Queue only
eligible unfinished identities. Never reopen completed, cancelled, suppressed,
denied or ambiguous work. Test rollback using compatible schema/receipts; never
restore stale snapshots over later source evidence.

Repeat real Telegram owner text/voice, selected-group silence, isolation, exact
approval and reconnect/restart checks from [release acceptance](release-acceptance.md)
before Telegram cutover completes. Missing inputs or credentials remain pending.
Subscription transcription failure blocks dependent release/cutover work.
Refresh the AST-only Graphify graph after code changes. Retain safe evidence in
compatibility/results without source conversations or credentials.

</acceptance>

</execution_plan>

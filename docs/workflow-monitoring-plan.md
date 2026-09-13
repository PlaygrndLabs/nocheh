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

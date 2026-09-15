# Nocheh implementation status

[SPECS.md](SPECS.md) defines the intended product. [AGENTS.md](AGENTS.md) defines
how agents work. Plans below provide execution order and acceptance procedures;
this file records actual status. Historical counts are evidence from their recorded
runs, not tests repeated by the documentation migration.

## Current recorded state — 2026-09-15

| Area | Actual implementation and activation | Evidence / execution plan |
| --- | --- | --- |
| Main integration | Refactor consolidated on main; legacy preserved. Release acceptance is incomplete. | [Integration evidence](compatibility/results/2026-09-11-main-consolidation.json), [rebuild plan](docs/rebuild-plan.md) |
| Runtime and owner dashboard | P1–P6 and dashboard D1–D4 implemented; P7 compatibility/recovery tooling verified, real Telegram gates pending. | [Runtime plan](docs/runtime-platform-plan.md), [operations evidence](compatibility/results/2026-09-08-runtime-platform-operations.json) |
| Guarded projections | G1–G3 and G5–G6 implemented; on/off guarding and owner edits active locally. G7 guarded recall/restart acceptance passed; Honcho/history acceptance remains separate. | [Guarded-memory plan](docs/guarded-memory-plan.md), [guarded acceptance](compatibility/results/2026-09-09-guarded-memory-acceptance.json) |
| Security service | SEC1–SEC5 verified; isolated execution and evidence memory active locally. | [Security plan](docs/security-service-plan.md), [activation](compatibility/results/security-service-activation.json) |
| Telegram monitoring | Recovery supervision, observed polling health, workflow monitoring, and local OAuth callback implemented. | [Recovery evidence](compatibility/results/2026-09-11-telegram-monitoring-oauth.json) |
| Shared provider | S1–S5 pass locally. Hermes uses the shared CPA route; exactly one CPA login is configured and the native login is retired. Text, privacy detection, voice, monitoring outage and full restart acceptance pass. | [Cutover evidence](compatibility/results/2026-09-14-shared-provider-cutover.json), [provider plan](docs/shared-provider-plan.md) |
| Honcho | Attached and verified locally without history backfill. Scoped recall, the native Hermes tool, group isolation, outage fallback and persistence pass with one ingestion receipt and one attempt. Embeddings retain the $5 pilot cap. | [Production acceptance](compatibility/results/2026-09-15-honcho-production-acceptance.json), [recall regression](compatibility/results/2026-09-15-honcho-recall-regression.json), [prior live acceptance](compatibility/results/2026-09-14-honcho-live-acceptance.json) |
| Space memory | M1–M5 implemented/fixture-tested within the recorded scope; filtered archive text supported. Filtering extensions and live checks below remain pending. | [Space-memory plan](docs/space-memory-plan.md), [fixture evidence](compatibility/results/2026-09-08-space-memory.json) |
| Specification workflow | AGENTS.md, SPECS.md, and plan/status consolidation implemented. XML structure, document links, requirement coverage, and supersession checks pass; runtime files and accepted ADRs are unchanged. | [ADR-0040](docs/adr/0040-specifications-and-agent-workflow.md) |
| Inngest workflows | I1–I6 implemented and verified; I7 local cutover is **7 of 9 families**. Imports, controlled tools, approved messages, native memory review, Honcho synchronization, browser turns and schedules use Inngest at epoch 2. Live import, sandbox approval/receipt, denial, consent, native browser streaming/replay/cancel, native memory review and one scheduled occurrence pass. Preparation and Telegram retain legacy ownership. Shared-provider cutover and transcription/restart checks pass; real owner Telegram acceptance remains pending. | [Execution plan](docs/workflow-monitoring-plan.md), [fresh fault/recovery evidence](compatibility/results/2026-09-14-inngest-fault-recovery.json), [local cutover evidence](compatibility/results/2026-09-14-inngest-local-cutover.json) |

Latest fresh-image workflow regression: 73 service tests and 152 Hermes tests passed;
one optional Docker security fixture was skipped. Real local Connect outages,
crash-after-effect recovery, legacy rollback, privacy and inactive restore passed. These synthetic
checks do not replace the live acceptance below. No legacy persisted-data migration is required;
VPS work remains deferred.

<local_inngest_cutover>

The active local installation has both Connect apps and nine connected family
registrations. Seven ownership switches used separate validated format-4 snapshots
and the pause/drain/reconcile protocol. The final snapshot before schedules contains
44 archive tables, 14 Inngest tables and 430 protected files. The live history scan
checked 2,521 rows for five internal credentials and synthetic source/tool markers;
none appeared. Owner-only Inngest history loads with its inspection-only banner.

- [Infrastructure](compatibility/results/2026-09-14-inngest-local-infrastructure.json)
  and [imports](compatibility/results/2026-09-14-inngest-local-imports.json).
- [Controlled tools](compatibility/results/2026-09-14-inngest-local-tools.json)
  and [approved-message denial](compatibility/results/2026-09-14-inngest-local-actions.json).
  The first tool canary encountered a missing sandbox image and stays closed as
  uncertain. After building the pinned image, a distinct approved canary passed.
- [Memory consent/retry preservation](compatibility/results/2026-09-14-inngest-local-memory.json)
  and [detached Honcho ownership](compatibility/results/2026-09-14-inngest-local-honcho.json).
  Four existing failed memory reviews retain their retry deadlines. A new browser
  review subsequently completed on its first attempt. Honcho was unattached at that
  cutover; production activation is recorded below.
- [Browser streaming/replay/cancellation](compatibility/results/2026-09-14-inngest-local-browser.json)
  and [native schedule wait/edit/pause/occurrence](compatibility/results/2026-09-14-inngest-local-schedules.json).
  The guard masked the browser's identifier-like test marker; its response matched
  the guarded input. Schedule output stayed local and created no delivery proposal.

Earlier implementation evidence covers the
[foundation](compatibility/results/2026-09-12-inngest-foundation.json),
[outbox](compatibility/results/2026-09-12-inngest-outbox.json),
[job operations](compatibility/results/2026-09-12-inngest-job-operations.json),
[Telegram](compatibility/results/2026-09-12-inngest-telegram.json),
[memory](compatibility/results/2026-09-12-inngest-memory.json),
[imports](compatibility/results/2026-09-12-inngest-host-imports.json),
[approvals](compatibility/results/2026-09-12-inngest-approved-actions.json),
[tools](compatibility/results/2026-09-12-inngest-host-tools.json),
[browser](compatibility/results/2026-09-12-inngest-browser.json),
[schedules](compatibility/results/2026-09-12-inngest-schedules.json),
[Monitoring](compatibility/results/2026-09-14-inngest-monitoring.json),
[atomic migration](compatibility/results/2026-09-14-inngest-cutover-core.json) and
[host handoff](compatibility/results/2026-09-14-inngest-host-handoff.json).

</local_inngest_cutover>

<shared_provider_login_acceptance>

[Fresh login evidence](compatibility/results/2026-09-14-shared-provider-login.json)
records the active installation's synthetic provider and speech checks, owner-session
and cross-site rejection, connected Telegram polling and nine workflow registrations.
No external owner messages or controlled actions were sent. The single embedding
attempt failed with HTTP 429, and the temporary meter was stopped afterwards.

Honcho status now reads CPA's single-login state instead of its retired bridge-auth
folder. Its dashboard label is **Shared ChatGPT login**. The internal key aliases
identify Hermes assistant replies, Honcho long-term memory and content privacy
preparation. This display fix does not activate provider routing or memory.

The offline Hermes suite ran 153 tests (151 passed, two optional skips), ten focused
host tests pass, and six targeted owner/OAuth/workflow checks pass (one live fixture
check skipped). The build passes and Graphify was refreshed without model calls.
The new label was inspected in the existing isolated preview; its unrelated primary
memory panel lacks fixture support and is not claimed as a full live-memory pass.

The owner subsequently approved [S5 local cutover](compatibility/results/2026-09-14-shared-provider-cutover.json).
A validated format-4 backup contains 44 archive tables, 14 Inngest tables and 494
protected files. Text, literal detection and transcription pass through Hermes;
chat continues during monitor shutdown; text and transcription pass again after
restarting CPA, speech, Hermes and monitoring. The native login is retired and the
saved/runtime route is `shared`, with CPA as refresh owner. Fifteen containers are
healthy, nine workflow registrations are connected, and Telegram polling is observed.
Honcho was detached during that cutover, which made no additional paid embedding request.

</shared_provider_login_acceptance>

<honcho_live_acceptance>

After the owner replaced the dedicated embedding key, the metered request returned
HTTP 200. [Fresh live acceptance](compatibility/results/2026-09-14-honcho-live-acceptance.json)
passes shared subscription reasoning, ingestion, retrieval, guarded embedding
evidence, persistence and recall after Honcho restart, and failure/recovery across
a brief CPA outage. The archive accepted the report: `verified=true`, `attached=false`.
The isolated Honcho services are stopped with their database and ledger preserved.
Pilot reservations total $0.07, including earlier failed requests; this is a
conservative reservation total, not an invoice.

Fresh live Hermes text, privacy detection, transcription and refresh-ownership
checks pass. All 73 service regressions and 19 Honcho tests pass. The offline Hermes
suite ran 153 tests: 151 passed, with the optional Docker security fixture and the
deployment-source check skipped. Missing host test dependencies and a read-only
test build-output mount were corrected before those suites passed. Fifteen active
containers are healthy, Telegram polling is connected, and all nine workflow
registrations are connected. The service test fixture was stopped after verification.

Production Honcho attachment and scoped ingestion/recall were pending at this
stage and subsequently passed as recorded below. Opted-in history and monthly-cap
activation remain pending. This earlier run did not repeat
backup/restore or real owner Telegram acceptance. Only documentation and safe
evidence changed, so the AST graph does not require rebuilding.

</honcho_live_acceptance>

<honcho_production_activation>

The owner authorized production activation and a graceful OrbStack restart on
2026-09-15 local time. The validated pre-activation format-4 snapshot preserves
44 archive tables, 14 Inngest tables and 524 protected files. Honcho is attached
and verified; history backfill and catch-up are disabled.

The first scoped production recall returned limited memory. The verified and
installed correction gives Honcho recall an eight-minute upstream deadline, ten
minutes through the scoped broker and 615 seconds in the native tool. Ordinary
archive reads retain their shorter deadlines, and broker cancellation still
aborts its upstream request. Both candidate images build; all 74 service tests and 152 Hermes
tests pass, with two optional Hermes checks skipped. The earlier 23 focused
Python checks passed; Graphify was refreshed using AST extraction only.

[Production acceptance](compatibility/results/2026-09-15-honcho-production-acceptance.json)
passes consented ingestion, derivation, scoped owner recall, actual Hermes memory
tool use through the security broker, group isolation, and exclusion of the
unconsented source. Synthetic imports produced no replies. All five Honcho
services were stopped and restarted: outage fallback reported limited memory,
then recall passed again with the same event, generation and receipt identities
and exactly one ingestion attempt. The native tool also passed with the other
project running again after the shared engine restart.

Fresh shared-login text, privacy detection, transcription and refresh-authority
checks pass. One CPA login is present, Telegram polling is connected, and all nine
workflow registrations are connected. The 15 main containers are healthy; four
Honcho services have passing healthchecks and the deriver is running without a
standalone healthcheck. All five Honcho services use unless-stopped. The isolated
test fixture is stopped with its state preserved.

Embeddings use text-embedding-3-small with 1536 dimensions and the existing $5
pilot cap. Reservations are conservative, not a provider invoice; the final
amount is recorded in the acceptance evidence. Monthly activation and historical
learning remain separate. Real owner Telegram acceptance remains pending, so
preparation and Telegram ownership are still legacy. The full release is not
accepted by these synthetic checks.

</honcho_production_activation>

<telegram_live_latency>

The first real owner text turn after Honcho activation completed once, but took
128.1 seconds from archive capture to its runtime receipt. The source was prepared
in 4.9 seconds, Honcho recall took 26.0 seconds, and two actual reply-model calls
combined took 9.5 seconds. Context preparation, native memory/tool processing,
startup and waits account for the remainder; exact attribution still needs more
instrumentation. Twelve provider calls were observed in the turn window, all
successful. Later shared-engine load cannot establish its contribution to that
specific turn.

The owner's follow-up was captured 270.4 seconds after its Telegram timestamp
and then closed as ambiguous with dispatch_interrupted on its first attempt,
with no recorded model request. Background native memory review overlapped it;
profile contention is a hypothesis because the persisted exception is generic.
No replacement execution or send was started. Real Telegram acceptance is failed,
so preparation/Telegram cutover and release remain blocked on diagnosis, fixes,
and a repeated owner test. The earlier isolated Honcho checks are historical
passes and do not establish full-chat latency or follow-up reliability.

[Content-free timing evidence](compatibility/results/2026-09-15-telegram-latency-diagnosis.json).

Profile admission now shares the native review/conversation lock. Foreground turns
wait before child execution and recheck cancellation and current policy; a busy
review returns to prerequisite waiting without consuming an attempt. Legacy
Telegram ownership uses the asynchronous runtime receipt contract and reconciles
running identities before any repeated start. All 74 service checks pass in the
isolated Compose fixture with serial test-file execution; six focused admission
checks pass. The initial parallel service run hit database timeouts. The broader
Hermes run passed 151 checks with two existing skips, but three native startup
checks timed out under host load. The final candidate subsequently passed all 155 non-optional Hermes checks across the full
run and a solitary repeat of its one timing-sensitive TUI check; two existing
optional checks are skipped. The code is installed locally; real Telegram acceptance still needs a new owner
message and the remaining live gates.

Guard context persistence now batches the cache reads, prepared-value inserts,
and one atomic write per bounded detector batch. A 100-fragment regression proves
exact originals/guarded outputs, cached reuse, fewer than 30 database statements,
and rollback without partial trust. All 21 affected privacy, recovery, broker,
policy and memory checks pass. Native phase timings use fixed names and numeric
counts/durations only; Telegram health separates network and spool-write timing.
Profile preparation, session cursor writes and dispatch/action receipt writes run
off the polling event loop while retaining their fsync-before-delivery ordering.

Current host pressure was measured at about 92% CPU use, 15 GB RAM used and 6.6 GB
compressed. This is current evidence, not proof of the original capture delay.
The separate project was left running; the synthetic fixture is stopped again.
Both verified images are installed after pausing admission and observing no
active reply, review, browser turn or action. Admission is restored with all owner
and epoch values unchanged; rollback tags and compatible receipts are preserved.
The eight replaced services passed health checks. Fresh shared-login text, guard,
transcription and refresh-authority probes pass, and native polling is connected.
The first text probe took 58.079 seconds, versus 4.285 seconds for its repeat;
cold startup remains slow. These are synthetic runtime probes, not full Telegram
latency measurements. No old ambiguous turn was replayed. Graphify was refreshed
with 253 files and no model calls.

[Installed response-fix evidence](compatibility/results/2026-09-15-telegram-response-fixes.json).
The owner should send one fresh private follow-up so the new runtime receipt and
phase timings can establish real delivery and remaining latency.

The next two real owner messages were captured within 1.497 and 2.581 seconds,
and each completed once on attempt one, but capture-to-receipt still took 143.043
and 141.018 seconds. Both replies carried a limited-memory notice. Profiling found
that the pinned native OpenAI client imports the optional Bedrock adapter, which
tries to install missing dependencies and spends 30.842 seconds on blocked
installation. Sealing managed-turn dependencies reduces synthetic native agent
construction from 41.088 to 4.378 seconds. Native reasoning, memory, tools and the
external guard remain enabled.

Honcho had four completed source receipts and no pending or running derivation,
but its generation remained building: the first readiness observer had completed
before later uploads. Transactional receipt creation and acknowledgment now request
fresh read-only observations without reopening an ingestion receipt. Background
native review overlapped the second turn and held its profile; reviews now wait
for a 60-second quiet interval after foreground activity, without consuming an
attempt or replacing a native receipt. All 75 service checks passed. All 157
non-optional Hermes checks passed across the full run and an isolated repeat of
three startup checks that timed out under shared-engine load; two optional checks
were skipped. Both tested images are installed locally; all eight replaced
services are healthy, native Telegram polling is connected, and admission is
restored with ownership unchanged. A new Inngest readiness observation completed
without changing the four ingestion receipts or their single attempts. Fresh
scoped owner recall returned the expected answer with limited_memory=false in
34.544 seconds. Paid embedding reservations total $0.24 of the existing $5 pilot
cap. This verifies recall, not the final Telegram response time: a new owner
question and immediate follow-up were requested; their later results follow below. Local main
contains code commit 9ea9fc2; GitHub HTTPS authentication still blocks remote push. [Follow-up evidence](compatibility/results/2026-09-15-telegram-followup-fixes.json).

The owner's next question and immediate follow-up both completed on attempt one.
Capture lag was 0.731 and 1.461 seconds; capture-to-receipt was 89.028 and 82.829
seconds. Native agent initialization fell to 2.332 and 1.589 seconds, while
Honcho recall still took 27.340 and 47.481 seconds. The second reply incorrectly
reported limited memory during an incremental synchronization that completed six
seconds after recall returned. Six source receipts were done; prior usable memory
had not been retired. The adapter now records whether the current authorized
generation has ever reached readiness and reports synchronization separately.
Initial builds, retired generations and failed recall still disclose limited
memory. All 75 service checks and ten focused checks passed; the final three Honcho
and workflow-memory checks passed after adding explicit retired-state coverage.
All 157 non-optional Hermes checks passed across the full run and a repeat of
one TUI startup check that missed its deadline; two optional checks were skipped.
Both code increments are merged locally (f3ba380, 0931255); GitHub HTTPS
authentication still blocks remote push. Candidate installation awaits explicit
approval: automatic approval review rejected pausing admission across all nine
families as broad service-disruption risk. That command did not execute and
active images/admission were not changed.

The memory query omits the per-execution archive footer while the full native
agent prompt retains its source reference. A candidate image also precompiles
the pinned Python modules. Its startup benchmark was stopped during severe host
load (load average 104.50), without a valid timing result. A later bounded
offline comparison measured 44.621 seconds for the previous image and 17.656
seconds for the candidate; changing shared host load limits attribution. These
are synthetic startup timings, not Telegram delivery acceptance. The isolated service
test stack was stopped; unrelated services were left running. Three active
Nocheh services had restarted, with Docker reporting no OOM kill at inspection.

The owner asked how relevance should be detected and for Hermes/Honcho setup
best practice. Native Hermes supports hybrid cached context, asynchronous writes,
background retrieval and agent-selected recall tools. Nocheh currently uses a
guarded blocking recall adapter and manages memory.provider itself; editing a
native Honcho setting alone does not change that adapter. Hybrid retrieval with
bounded context and fresh audience/guard checks is a recommendation, not an
implemented or activated mode. The blanket reasoning call remains a latency
limitation. [Native provider reference](https://github.com/NousResearch/hermes-agent/blob/main/plugins/memory/honcho/README.md).

The standard services rebuild stalled resolving the pinned Node base metadata
and was cancelled. An offline candidate copies only the tested compiled Honcho
module onto the verified installed services image, with unchanged dependencies;
its module hash matches the test artifact exactly. The Hermes candidate built
from its normal pinned recipe. Both candidate image digests are recorded.

[Memory availability and startup evidence](compatibility/results/2026-09-15-memory-availability.json).

</telegram_live_latency>

## Outstanding acceptance and blockers

- **Subscription transcription:** shared-login Ogg/Opus transcription and full provider restart acceptance passed on 2026-09-14. Actual owner Telegram voice persistence remains pending; preparation and Telegram ownership remain legacy.
- **Telegram / release:** later real owner questions and follow-ups completed once, but latency and the latest fixes still need acceptance. The original ambiguous failed turn remains closed. Intentional group silence, private/group isolation, voice-byte/transcript persistence, exact owner-approved delivery, and reconnect/restart without duplicate effects remain unrun. Follow [release acceptance](docs/release-acceptance.md); container health and synthetic inputs do not substitute for these checks.
- **Shared provider:** the owner explicitly approved the switch after the earlier testing-only rejection. S5 passed and the shared route is active; the old native login is privately retired. No provider cutover blocker remains. The refresh check verifies authority delegation, not a newly forced token-expiration event.
- **Honcho:** attached and verified; scoped production ingestion/recall, native-tool access, isolation, outage and restart acceptance pass. The opted-in history pilot and monthly budget cutover remain pending. Preserve the durable pilot ledger and explicit learning consent. See the production acceptance evidence above.
- **Space memory:** native-note/transcript filtering is not implemented; its provider-payload/destination extension was blocked by an earlier automatic approval review. Live native-review/filter quality and the browser policy-save check also remain pending. See [recorded boundaries](docs/space-memory-plan.md).
- **Optional comparison:** the isolated Honcho comparison remains pending and does not block release; production Honcho activation has separate gates.
- **Remote synchronization:** each verified increment was merged locally under the shared Git lock; fetch and push repeatedly confirmed that local GitHub HTTPS authentication is unavailable. Local integration and remote push outcomes must be reported separately; do not infer synchronization from a local merge.

## Development follow-ups and proposals

- **Per-session previews — not implemented:** add explicit isolation of Compose projects, networks, image tags, ports, state, and credentials before concurrent worktree previews. No duplicate Telegram poller, scheduler, or OAuth refresh owner may use the active installation.
- **Makefile — not implemented:** `dev` is declared phony but has no recipe. Existing `./scripts/nocheh dev` runs the installation's Compose Watch workflow; it is not an isolated-session setup command. Wiring `make dev`, fresh-worktree setup, and visible persistent preview startup are follow-up tooling work.
- **Inngest — accepted implementation:** [workflow execution plan](docs/workflow-monitoring-plan.md), I1–I7. Local orchestration infrastructure and seven families are active; preparation and Telegram cutover remain pending. Independent host recovery and existing provider/Honcho/release gates apply.

## Historical implementation records

The following entries are retained snapshots. Their old phase statuses, topology,
provider routes, and instructions describe their recording time. Use the current
sections above for status and SPECS.md/AGENTS.md for requirements and workflow.

<details>
<summary>Earlier phase reports and evidence</summary>

#### Main consolidation — 2026-09-11

The owner requested that all refactor work move to `main`.
[ADR-0039](docs/adr/0039-main-refactor-consolidation.md) separates that integration
from release acceptance. The memory branches are already ancestors of the rebuild;
their controlled-tools draft is superseded by the completed P5 implementation.
Legacy history remains preserved on `codex/legacy-nocheh`.

Final verification: 57 service tests and 125 Hermes tests pass; one optional Docker
security fixture is skipped. The service rerun exposed a database-wide memory
review lock shared with the live worker; it now follows the schema-scoped locking
used by the other preparation workers, with isolation and exclusion assertions.
[Integration evidence](compatibility/results/2026-09-11-main-consolidation.json).
Both temporary memory worktrees are retired. The superseded draft remains in stash
`f4e3bcee`; complete worktree archives, including ignored test backups, are preserved
under the ignored `data/worktree-archives/2026-09-11/` directory.

At integration, shared-provider login count is zero and the native subscription route
remains active. Provider cutover, Honcho activation and the remaining live Telegram
gates below stay pending. Inngest remains a proposal. Remote synchronization could
not be checked because GitHub HTTPS authentication is unavailable locally.

#### Telegram recovery and owner monitoring — 2026-09-11

Fixed a fatal native polling recovery that remained reported as connected.
The supervisor now exits on retryable fatal adapter failure for Compose recovery,
retains a safe incident and reports actual polling progress. The waiting real
Telegram update completed on its first attempt after recovery.

Monitoring is active in the owner dashboard: recent Telegram workflows, retries,
blockers, successes/skips, provider route/login and services. OAuth now uses a
temporary state-validated host callback at port 1455. A real login start reached
the OpenAI sign-in page; owner completion and shared-provider cutover remain pending.
57 service checks pass; 124 Hermes checks pass with two optional checks skipped.
[Evidence](compatibility/results/2026-09-11-telegram-monitoring-oauth.json).
Inngest was evaluated; [migration is proposed](docs/workflow-monitoring-plan.md),
not activated. This repair does not complete the remaining release gates.

Security service: [SEC1–SEC5 complete; active locally](docs/security-service-plan.md).
Phased implementation and automatic per-phase commits authorized under ADR-0037.
Existing provider and Honcho activation gates remain separate.

### Shared CLIProxyAPI provider and monitoring (ADR-0035)

Owner-approved implementation plan: [shared-provider-plan.md](docs/shared-provider-plan.md).

| Phase | Actual status |
| --- | --- |
| S1 — Contract | Complete in the ADR/plan increment; implementation follows in separate commits |
| S2 — Shared provider service | Complete: pinned image builds, private per-client credentials and locked no-retry/no-fallback configuration; container health and 8 focused tests pass. Fresh proxy login remains a cutover gate |
| S3 — Hermes, voice and Honcho routes | Complete: all reasoning clients use scoped shared-provider keys; speech alone has read-only OAuth access; 47 service, 101 Hermes and 13 Honcho checks pass. Fresh provider login remains a live cutover gate |
| S4 — CPA Manager Plus dashboard integration | Complete: pinned Full Mode image, isolated SQLite state, owner-session/CSRF proxy and browser UI pass; real service rejects unauthenticated access and exposes no provider secrets |
| S5 — Local acceptance and cutover | Acceptance command and recovery-safe backup/restore implemented; fresh provider device login and live cutover currently pending |

The native Hermes subscription route remains active until the candidate shared route
passes its live checks. Honcho attachment remains gated by its separate embedding and
memory acceptance; the recorded HTTP 429 is still pending.

#### Unified local Compose project — 2026-09-10

ADR-0036 places the native dashboard service in the main `nocheh` Compose project.
Complete: lifecycle tests, 47 service tests, 107 Hermes tests and a no-cache rebuild
pass. Docker reports one `nocheh` project with 10 healthy services, including the
native dashboard and optional database viewer. The old `nocheh-dashboard` project
is removed. The owner management server remains host-managed and healthy.

### Guarded projections and primary Honcho memory (ADR-0033)

Owner-approved replacement plan: [guarded-memory-plan.md](docs/guarded-memory-plan.md).
These phases are distinct from the earlier runtime-platform phases below.
Commits: G1 `7d474a1`, G2 `c99d324`, G3 `c22c50e`, G4 infrastructure `9194ed7`,
G5 `c84369a`, G6 `3e671e1`, G7 local acceptance `96bf60d`.

| Phase | Actual status |
| --- | --- |
| G1 — Durable guarded versions | Complete; 42 JS/TS checks and 91 pinned Hermes Python checks passed at this increment |
| G2 — Owner dashboard editor | Complete; owner API, conflict/race tests and synthetic browser edit/history/restore pass |
| G3 — On/off throughout | Complete; 45 JS/TS and 94 pinned Hermes checks passed at this increment; activated locally in G7 |
| G4 — Live Honcho connection | Pinned images build and isolated Compose startup pass. Shared subscription reasoning is implemented under ADR-0035. One synthetic request to the dedicated paid embedding route returned HTTP 429, so memory attachment remains pending |
| G5 — Primary Honcho memory | Implemented; 46 JS/TS and 94 Hermes checks pass. Attachment remains gated by G4 live acceptance |
| G6 — Edits, switching and recovery | Implemented; 47 JS/TS and 94 native checks pass. Portable owner revisions, inactive recovery, generation invalidation and optional catch-up verified with fixtures |
| G7 — Local acceptance and final graph | Guarded workflow passes live subscription recall, dashboard editing and restart. Backfill: 439 ready, zero pending/failed. Final 47 JS/TS, 94 Hermes and 12 Honcho fixture checks pass. Real Honcho activation and opted-in history pilot remain pending G4 credentials/gates |

G7 [local acceptance](compatibility/results/2026-09-09-guarded-memory-acceptance.json)
and [live guarded recall](compatibility/results/2026-09-09-guarded-copies.json).
The [current system graph and instructions](docs/guarded-memory-system.md) distinguish
the shared reasoning implementation from the pending Honcho memory activation.
Hermes retains its tested native route until the ADR-0035 live cutover passes.
Under [ADR-0034](docs/adr/0034-explicit-embedding-environment.md), `.env`
now has an owner-supplied `OPENAI_API_KEY`, provider `openai`, and model
`text-embedding-3-small`. Configuration, redaction and spending checks pass: 15 pinned
Honcho and 94 Hermes tests. The [live embedding attempt](compatibility/results/2026-09-09-openai-embeddings.json)
returned HTTP 429 and retained a $0.01 reservation. The former separate bridge login
has been replaced by the one shared provider login; memory attachment remains disabled
until both shared reasoning and the dedicated embedding gate pass. Original G7 evidence
above is a historical snapshot from before the embedding credential was supplied.

G1 evidence: isolated PostgreSQL covers byte preservation, duplicate/concurrent capture,
restart, partial detector failure recovery, derived text and consent separation. Host
suite setup failures were resolved using explicit fixture DB credentials and the pinned
Hermes image. AST graph refreshed without model calls.

### Rebuild progress

Memory/privacy work is tracked separately in [space-memory-plan.md](docs/space-memory-plan.md)
and ADR-0030, on the isolated `codex/memory-space-policies` worktree.

#### Owner dashboard extension — 2026-09-07

Accepted [dashboard/CLI plan](docs/dashboard-cli-plan.md), ADR-0025. Each increment
is committed separately; these do not replace the production release gates below.

| Increment | Actual status |
| --- | --- |
| D1 — Compatibility and configuration | Complete: native preferences persist, validated config show/set/apply with redaction/conflict/recovery; 12 configuration/scope tests plus one pinned dashboard auth/extension test pass |
| D2 — Dashboard and import jobs | Complete: local native dashboard extension, shared owner API, settings, archive search and durable manual imports; 16 TypeScript tests and 39 pinned Python tests pass |
| D3 — Native memory and isolated Honcho CLI | Pending |
| D4 — Source graph and operations | Pending |

D1 also built the pinned upstream dashboard frontend successfully from its npm
lockfile in a temporary directory. Packaging and serving it are D2 work. No live
provider requests or production setting changes were required for D1 verification.

D2 [dashboard instructions](docs/dashboard.md). The local browser renders live
archive status, redacted settings and upload controls. HTTP acceptance verifies
unauthorized/cross-site rejection and cancellation/restart/resume using isolated
fixtures. ZIP traversal/symlink and changed-export failures pass. Existing real
PostgreSQL import/export tests verify exact originals and silent replay. Native
agent/mutation routes are denied at the dashboard ASGI boundary. Production
Telegram/provider configuration was not changed by these dashboard checks.

After the requested reset on 2026-09-07, a fresh Compose runtime was started with
the supplied Telegram bot token and owner/group IDs in the ignored `.env`.
All five services are healthy. Fresh Hermes sign-in and live subscription checks
pass. Telegram is enabled: the owner's real `/start` was captured, dispatched and
answered with confirmed Telegram delivery. Four real text messages in the selected
group were also captured and answered; no batch of older history arrived.
An optional read-only pgweb browser is available with `./scripts/nocheh db`.
The rebuild is **not released**: remaining Telegram acceptance and cutover are
pending. Main consolidation was authorized separately on 2026-09-11 under ADR-0039.

Accepted plan: [docs/rebuild-plan.md](docs/rebuild-plan.md).
Baseline: `9dd0b58` on `codex/legacy-nocheh`. The refactor from
`codex/hermes-rebuild` is consolidated into `main` under ADR-0039.
No legacy data migration is required. VPS work is deferred by ADR-0019.

| Phase | Actual status |
| --- | --- |
| 0 — Preserve baseline and architecture | Complete: `add2341` |
| 1 — Subscription compatibility | Complete locally: `8fd69cc` |
| 2 — Compose runtime | Complete: `9d72c32` |
| 3 — Durable capture and archive | Complete: `d29dbab` |
| 4 — Import, search, export, replay | Complete: `aa39e60` |
| 5 — Optional outgoing guard | Complete: `eb6d319` |
| 6 — Scoped assistant and voice | Implemented at `43eea5e`; real owner DM and four group replies pass; full group isolation/silence, voice, approval and reconnect checks pending |
| 7 — Honcho comparison, maximum $5 | Runnable harness at `2d27262`; live comparison pending separate credentials; optional |
| 8 — Operations, cutover, merge | Backup/restore implemented at `4efe7c3`; real Telegram gate and cutover pending; main integration authorized separately by ADR-0039 |

#### Last validation before the reset — 2026-09-07

- 14 TypeScript tests pass against real Compose PostgreSQL where required;
  30 Python native integration/operations tests pass. No main-suite skips.
- 21 subscription contracts pass with simulated transport failures. Five Honcho
  budget/scoring tests pass; no paid requests or live comparison occurred.
- Live subscription refresh, native chat, literal detection and Ogg/Opus
  transcription pass again after configuration and worker cleanup.
  [Latest report](compatibility/results/2026-09-07-cleanup-subscription.json).
- Native memory store, recall across process restarts and another-group isolation
  passed the [synthetic live rehearsal](compatibility/results/2026-09-07-assistant-memory.json).
  Recall reached 152 seconds in that run; it is not a latency guarantee.
- Required guard failure/retry/redirect tests pass. Native guarded chat passed
  again after cleanup with one required boundary attempt and no guard failures;
  the saved `auto` policy is restored. Earlier transient failures remain in the
  [historical guard report](compatibility/results/2026-09-07-guard.json).
- `.env` configuration checkpoint `4f3fade` preserves archive credentials and keeps
  Hermes OAuth in its native file. Format-2 backup/restore matched eight table
  fingerprints and 38 state files; five restored services were healthy and inactive.
  The rehearsal is stopped. [Report](compatibility/results/2026-09-07-environment.json).

#### Cleanup and behavior fixes

The retired application is recoverable on the legacy branch. Its remaining local
`web/` build output and dependencies were removed. Active documentation describes
this runtime; historical research and accepted ADRs remain available.

Edit only the ignored root `.env` for local configuration. The requested fresh
reset removed the entire `data/` directory, including previous configuration,
archive files, backups, experiment state and the dedicated Hermes login.
Committed synthetic evidence and historical decisions remain in Git.

Archive capture, attachments, assistant work and approved actions progress in
independent non-overlapping loops. Slow inference cannot block capture/downloads.
Committed media avoids native duplicate downloads and unscoped sticker vision;
round video notes use the transcript path. Malformed source messages remain
archived with a visible suppressed dispatch and do not starve subsequent work.

#### Remaining release gates

The first real owner-DM capture and reply passed after enabling the gateway.
Fresh subscription refresh, chat, detector and Ogg/Opus checks also passed.
[Content-free live evidence](compatibility/results/2026-09-07-telegram-dm.json).
Selected-group membership and send permissions now pass; membership events are
archived. [Access evidence](compatibility/results/2026-09-07-telegram-group-access.json).
After the earlier privacy-mode check, four ordinary owner-authored group messages
were delivered and answered. This proves those messages' capture/replies, not
visibility of every group member's messages. Credentials and IDs are already saved
locally. Follow [Telegram setup and acceptance](docs/telegram.md).
Intentional group silence, private/group isolation, voice persistence,
owner-approved delivery and reconnect/restart checks remain **unrun**.
Container health does not prove these.
The original restriction on merging was superseded by ADR-0039; these release checks remain separate from Git integration.

#### Local inspection and latency — 2026-09-07

The [pgweb browser](docs/database-viewer.md) is running on loopback port 8782.
UI queries and PostgreSQL read-only privileges were verified, including a denied
zero-row update after disabling transaction read-only mode.
[Viewer evidence](compatibility/results/2026-09-07-database-viewer.json).

Four observed group replies took 16.55–35.17 seconds after archive receipt.
Capture was about one second after Telegram's source timestamp. The slowest turn
spent about 1 second queued, 4 seconds preparing Hermes, 28 seconds in the agent
phase (two model rounds, two archive searches), and 2 seconds completing delivery.
Archive searches themselves took about 0.1 seconds. Per-turn process startup,
serial assistant dispatch, and non-streamed responses remain latency limitations.
The trusted ChatGPT route bypasses guard detection under `auto`.
This diagnosis does not claim a performance fix or a completed release gate.

The optional [Honcho experiment](experiments/honcho/README.md) uses the shared
reasoning login and an explicitly supplied dedicated embedding key. Live embedding,
derivation and recall comparison remain pending. Its $5 budget has one $0.01
conservative reservation from the rejected embedding canary.

##### Owner dashboard D3 — native memory and isolated Honcho CLI

- [x] Owner-only profile enumeration, bounded native notes and paginated SQLite
  session inspection; selected profiles cannot open another profile's session.
- [x] Native preference forms use the shared revision-checked resolver.
- [x] Official Honcho CLI 0.1.4 and SDK 2.4.0 pinned in a separate internal-only
  runner; stored data commands, JSON output, pagination, lifecycle aliases and
  honest unavailable dashboard state. Read lookups cannot create records.
- [x] Compose regression: 16 TypeScript tests and 41 Hermes integration tests;
  two CLI boundary tests and one real upstream CLI/SDK fixture test pass.
- [ ] Optional live Honcho compatibility remains pending separate credentials.

##### Owner dashboard D4 — evidence graph and operations

The owner's 3D graph revision replaces fixed SVG columns with a local Three.js
space, deterministic spatial layout, orbit/pan/zoom, node search, direct-connection
highlighting and source inspection. See ADR-0026 and the dashboard instructions.
This presentation change does not advance the pending production release gates.
Verification: nine graph/layout/failure tests, two owner HTTP tests and two pinned
dashboard compatibility tests pass. Live desktop and 375px browser checks cover
node picking, original sources, orbit/zoom, search, scope pagination and full screen.

- [x] Deterministic graph over one archive scope, with cursor pagination, original
  chat identities, author/reply/revision links, files, derived provenance and
  explicit native-note citations. No model calls or graph database.
- [x] Interactive keyboard-accessible graph, source detail, original file download,
  graph JSON and portable archive ZIP export.
- [x] Durable jobs for diagnosis, backup, restart and inactive restore; generated
  destinations, operation exclusion, and no preference writes during inspection.
- [x] Regression: 17 TypeScript and 43 pinned Hermes integration tests pass,
  including graph scope/provenance and operation failure/concurrency paths.
- [x] Local dashboard acceptance: graph node opens original source; diagnostics
  healthy; backup/restore verified all 8 tables and 89 state files with credentials
  inactive; portable ZIP exported 65 records with manifest/count/integrity checks.
- [x] Browser-native authenticated ZIP download verified; download-only HttpOnly
  cookie cannot access settings, and cross-origin downloads are denied.

##### Owner dashboard clarity — 2026-09-07

- [x] Navigation grouped into Explore, Manage and Experiments, with purpose text
  and an overview explaining Nocheh's controls and native Hermes responsibilities.
- [x] Separate Nocheh settings and per-profile Hermes preferences; clear save/apply
  timing, masked credential review, and empty secret edits preserve the saved value.
- [x] Three-step import guidance, read-only memory explanations, readable Honcho
  status and maintenance results, with technical details collapsed by default.
- [x] Browser acceptance covers navigation, unchanged native preference save,
  masked credential review/discard, diagnostics and responsive layout. Build and
  owner-management HTTP regression pass; AST-only code graph refreshed.

##### Nocheh runtime platform (ADR-0027)

Accepted [seven-phase plan](docs/runtime-platform-plan.md). Complete and verify each
phase, commit separately, then continue automatically. Existing release gates above
remain active. This direction supersedes the earlier Hermes-hosted presentation.

| Phase | Actual status |
| --- | --- |
| P1 — Ownership and runtime adapters | Complete: cbe3022; 30 JS/TS and 44 Python tests pass |
| P2 — Independent Nocheh dashboard | Complete: 1438674; independent root, native return page, desktop/mobile and 3D graph pass; 32 JS/TS and 44 Python tests pass |
| P3 — Configuration and native administration | Complete: 67d6a05; actual native state, shared config revisions, preference inheritance, scoped sessions/files and private profile management; 32 JS/TS and 52 Python tests pass |
| P4 — Native browser chat | Complete: 4effeac; isolated managed turns, original/file capture, native resume/cancel, scoped reconnect, durable receipts and Activity; 33 JS/TS and 64 Python tests plus live owner-private browser chat pass |
| P5 — Controlled broader tools and approvals | Complete: 75f7c39; exact approvals, bounded/revoked permissions, isolated shell and offline browser, public HTTPS MCP; 39 JS/TS + 78 Python full-suite and 16 targeted follow-up tests; live UI/CLI/worker acceptance passes |
| P6 — Native cron | Complete: 725983b; native editor and CLI, one supervised scheduler, durable fires/results, explicit catch-up, cancellation and local delivery; 40 JS/TS + 86 Python tests and live native scheduled subscription turn pass |
| P7 — Compatibility and release acceptance | Tooling verified and committed in the P7 increment: candidate runtime/native/UI builds, portable archive + memory export, inactive recovery with all 18 tables and 175 state files preserved across restart; 41 JS/TS + 91 Python tests and 2 host management checks pass. Real Telegram gates remain pending |


##### P7 operations evidence — 2026-09-08

[Content-free report](compatibility/results/2026-09-08-runtime-platform-operations.json).
The native candidate builds and tests with no live state, credentials or test
network. UI/CLI export verified 135 sources and two native SQLite databases. The
current archive had no attachment or native note files; synthetic tests verify
those byte-preservation paths. Full backup and inactive restore preserve all 18
tables and 175 state files. Restored workers, tools, scheduler and copied OAuth
remain held; table fingerprints survive restart unchanged. The rehearsal is stopped.

The first cache-link backup and closed-SQLite export failures are retained in the
report; both were fixed and successfully repeated. No Telegram test messages were
sent. P7 **release acceptance remains incomplete** until the owner supplies the
[remaining Telegram test inputs](docs/release-acceptance.md). Cutover remains
pending. ADR-0039 subsequently authorizes main integration without waiving those
release gates.

</details>

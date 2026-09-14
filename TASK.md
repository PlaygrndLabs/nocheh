# Nocheh implementation status

[SPECS.md](SPECS.md) defines the intended product. [AGENTS.md](AGENTS.md) defines
how agents work. Plans below provide execution order and acceptance procedures;
this file records actual status. Historical counts are evidence from their recorded
runs, not tests repeated by the documentation migration.

## Current recorded state — 2026-09-14

| Area | Actual implementation and activation | Evidence / execution plan |
| --- | --- | --- |
| Main integration | Refactor consolidated on main; legacy preserved. Release acceptance is incomplete. | [Integration evidence](compatibility/results/2026-09-11-main-consolidation.json), [rebuild plan](docs/rebuild-plan.md) |
| Runtime and owner dashboard | P1–P6 and dashboard D1–D4 implemented; P7 compatibility/recovery tooling verified, real Telegram gates pending. | [Runtime plan](docs/runtime-platform-plan.md), [operations evidence](compatibility/results/2026-09-08-runtime-platform-operations.json) |
| Guarded projections | G1–G3 and G5–G6 implemented; on/off guarding and owner edits active locally. G7 guarded recall/restart acceptance passed; Honcho/history acceptance remains separate. | [Guarded-memory plan](docs/guarded-memory-plan.md), [guarded acceptance](compatibility/results/2026-09-09-guarded-memory-acceptance.json) |
| Security service | SEC1–SEC5 verified; isolated execution and evidence memory active locally. | [Security plan](docs/security-service-plan.md), [activation](compatibility/results/security-service-activation.json) |
| Telegram monitoring | Recovery supervision, observed polling health, workflow monitoring, and local OAuth callback implemented. | [Recovery evidence](compatibility/results/2026-09-11-telegram-monitoring-oauth.json) |
| Shared provider | S1–S5 pass locally. Hermes uses the shared CPA route; exactly one CPA login is configured and the native login is retired. Text, privacy detection, voice, monitoring outage and full restart acceptance pass. | [Cutover evidence](compatibility/results/2026-09-14-shared-provider-cutover.json), [provider plan](docs/shared-provider-plan.md) |
| Honcho | Shared reasoning passes; attachment remains disabled. The fresh dedicated embedding request returned HTTP 429; total pilot reservations are $0.02. Ingestion, recall and recovery gates remain pending. | [Fresh embedding evidence](compatibility/results/2026-09-14-shared-provider-login.json), [memory instructions](docs/guarded-memory-system.md) |
| Space memory | M1–M5 implemented/fixture-tested within the recorded scope; filtered archive text supported. Filtering extensions and live checks below remain pending. | [Space-memory plan](docs/space-memory-plan.md), [fixture evidence](compatibility/results/2026-09-08-space-memory.json) |
| Specification workflow | AGENTS.md, SPECS.md, and plan/status consolidation implemented. XML structure, document links, requirement coverage, and supersession checks pass; runtime files and accepted ADRs are unchanged. | [ADR-0040](docs/adr/0040-specifications-and-agent-workflow.md) |
| Inngest workflows | I1–I6 implemented and verified; I7 local cutover is **7 of 9 families**. Imports, controlled tools, approved messages, native memory review, detached Honcho orchestration, browser turns and schedules use Inngest at epoch 2. Live import, sandbox approval/receipt, denial, consent, native browser streaming/replay/cancel, native memory review and one scheduled occurrence pass. Preparation and Telegram retain legacy ownership. Shared-provider cutover and transcription/restart checks pass; real owner Telegram acceptance remains pending. | [Execution plan](docs/workflow-monitoring-plan.md), [fresh fault/recovery evidence](compatibility/results/2026-09-14-inngest-fault-recovery.json), [local cutover evidence](compatibility/results/2026-09-14-inngest-local-cutover.json) |

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
  review subsequently completed on its first attempt. Honcho remains unattached.
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
Honcho remains detached; this cutover made no additional paid embedding request.

</shared_provider_login_acceptance>

## Outstanding acceptance and blockers

- **Subscription transcription:** shared-login Ogg/Opus transcription and full provider restart acceptance passed on 2026-09-14. Actual owner Telegram voice persistence remains pending; preparation and Telegram ownership remain legacy.
- **Telegram / release:** intentional group silence, private/group isolation, voice-byte/transcript persistence, exact owner-approved delivery, and reconnect/restart without duplicate effects remain unrun. Follow [release acceptance](docs/release-acceptance.md); container health and synthetic inputs do not substitute for these checks.
- **Shared provider:** the owner explicitly approved the switch after the earlier testing-only rejection. S5 passed and the shared route is active; the old native login is privately retired. No provider cutover blocker remains. The refresh check verifies authority delegation, not a newly forced token-expiration event.
- **Honcho:** shared reasoning through both the client key and capped meter passes. A fresh embedding attempt again returned HTTP 429; resolve provider capacity/credentials and complete ingestion, retrieval, restart and failure checks before attachment. Pilot reservations total $0.02. The opted-in history pilot and monthly budget cutover remain pending; do not reset reservations or infer learning consent.
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

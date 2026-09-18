# Nocheh implementation status

[SPECS.md](SPECS.md) defines the intended product. [AGENTS.md](AGENTS.md) defines
how agents work. Plans below provide execution order and acceptance procedures;
this file records actual status. Historical counts are evidence from their recorded
runs, not tests repeated by the documentation migration.

<original_only_archive>

## Original-only archive and clean restart — 2026-09-18

The owner authorized implementation of the [complete execution plan](docs/original-only-archive-plan.md).
[ADR-0053](docs/adr/0053-original-only-archive.md) supersedes guarded placement in
ADR-0052. Requirements now classify original audio/video/files as sources, all
guarded versions and generated output as derivatives, and policy/workflows as
control. Three databases, automatic inspectable contextual learning, corrections,
projects, and explicitly managed sharing are accepted requirements.

| Increment | Status |
| --- | --- |
| Requirements, decision, and reset procedure | Complete; structure, local links, consistency, coverage, and diff hygiene checked |
| Three stores, repositories, capture handoff, role isolation | Foundation verified in isolated Compose; production wiring and remaining repository migrations pending |
| Guard/control separation and recovery | Guard repository and publication recovery verified; production callers and remaining control-state migrations pending |
| Derivative versioning, reprocessing, portability, backup | Reprocessing and guarded selection repositories verified; owner routes/UI, portability, and backup pending |
| Replies/reactions, Honcho provenance, learning, projects, owner interfaces | Relationships, policies, provenance, learned versions and automatic worker verified as candidate repositories; production wiring and interfaces pending |
| Complete isolated Compose and UI acceptance | Pending |
| Installation-scoped reset and empty baseline | Authorized after isolated acceptance; not performed |
| Fresh live acceptance and saved-setup resumption | Pending; dedicated test group and human participation required |

Preserve configuration, external logins, and spending accounting during the
authorized reset; erase installation-owned content, history, backups, and exports.
No live services or data have changed in this documentation increment. Earlier
storage/classification and convention-design questions below are resolved by the
accepted plan; those entries are historical observations, not remaining decisions.

The storage foundation adds separate database/owner/runtime roles, append-only
source and derivative repositories, immutable original file manifests, typed
provenance, and recoverable handoff into the existing Inngest registry/outbox.
The spool commits its bounded archive batch before attempting control writes;
reconciliation cycles through all capture sequences to handle commit reordering.
Concurrent reconciliation uses one control transaction without borrowing a
second connection while holding the cursor lock. No cross-database joins,
foreign tables, or mixed-store query router are introduced.

Node 24 compilation and the initial clean development image build pass. Both
storage tests pass against three actual databases, including wrong-role access,
original/derivative rewrite denial, control outage, duplicate capture, interrupted
handoff, concurrent reconciliation, version provenance, and repeat bootstrap.
The existing suite initially reports 92 passes, two missing-native-dependency
failures, and one container-only skip. After starting synthetic Inngest/Redis and
configuring loopback aliases, all eight affected/storage/container checks pass;
this covers all 95 distinct checks without treating the initial failures as passes.
The unsupported host-only run is not acceptance evidence. Graphify was refreshed
with ASTs only: 306 files, 1,873 nodes, 6,743 edges, zero model calls.

The fixture project is `nocheh-stores-20260918`, with its own internal network,
database volume, synthetic credentials, and no published ports, live poller,
scheduler, OAuth authority, or live data. Production still uses the legacy
single-database path: this increment is a tested foundation, not a completed
storage cutover. Reset, guard migration, reprocessing activation, learning/UI,
portability, and fresh live acceptance remain pending.

Generated capture now uses installation-bound control operation references and
durable derivative content, so prompts and schedules require no invented archive
event. The spool classifies outbound results before touching control: confirmed
Telegram Message responses become original evidence, while intents, responses,
uncertain effects, and generated inputs remain outside the archive. Boolean or
message-ID-only responses cannot turn a draft into observed speech. Control
receipts retain references and effect state; replay reuses the immutable output.
Guarding accepts operation-rooted derivatives, while source-version activation
rejects them. No new delivery or retry of an external effect occurs in this path.

Four affected real-PostgreSQL checks pass; the final generated-capture pair also
passes after adding the activation rejection. Compilation and AST-only Graphify
pass (337 files, 2,051 nodes, 7,572 edges, zero model calls).
[Generated capture evidence](compatibility/results/2026-09-18-generated-capture.json).
Production service routing, attachment preparation, and the remaining owner and
runtime interfaces still require integration before the isolated full rehearsal.

Attachment and preparation repositories now separate immutable manifests from
download attempts/backoff. Original bytes are fsynced before manifest commit and
control completion; interrupted completion repairs from the existing bytes without
downloading again. Imported files wait for owner uploads. The preparation step
uses the existing workflow family fence and versioned reprocessing/selection for
subscription transcripts, UTF-8 extraction, and explicit unsupported-file results.
Automatic preparation cannot replace an existing selection or an owner's guard edit.
Four affected synthetic PostgreSQL checks pass, including wrong-epoch admission,
file mutation denial, interrupted receipt recovery, backoff, text/binary handling,
and repeated preparation. Production workflow handlers still await the common
service composition; no live transcription or full rehearsal is claimed.
[Preparation evidence](compatibility/results/2026-09-18-store-preparation.json).

The source retrieval repository now searches original evidence only, reads active
authorized file derivatives separately, and links source details to version history.
Its owner graph contains originals, attachments, actors, and observed relationships;
old reply/reaction targets resolve independently of the page. Scoped reads strip
embedded reply snapshots and check target access independently, including unknown
topic denial. Capability claims carry installation generation as well as epoch;
the new repository rejects legacy or stale claims even with guarding off. The old
runtime routes are not switched by this increment.
Six affected synthetic/retrieval/HTTP checks pass; the final targeted rerun also
passes after adding final source-access rechecks and repeatable fixture identities.
AST-only Graphify: 343 files, 2,083 nodes, 7,773 edges, zero model calls.
[Source retrieval evidence](compatibility/results/2026-09-18-source-only-retrieval.json).

The shared storage-service composition now exposes a tested owner HTTP controller
and CLI commands for source versions, exact provenance, idempotent reprocessing,
guarded activation/history/restore, learned correction/retirement/history, project
management and membership, sharing-rule management, and bounded Honcho provenance.
The existing dashboard owner proxy recognizes these routes, preserves its session
and cross-site checks, and reports revision conflicts. Source/learned mutations
reject scoped tokens before reading their bodies. Six affected HTTP/PostgreSQL
and management checks plus five Python CLI checks pass. Production API mounting,
sharing content previews/releases, and visible UI remain pending.
[Owner operation contracts](docs/storage-owner-api.md) and
[owner API evidence](compatibility/results/2026-09-18-storage-owner-api.json).

The guard repository now stores immutable inputs, fragments, automatic/owner
revision history, and activation evidence in derived storage. Control owns mode,
epoch, invalidations, and publication receipts. Publication first revokes prior
contexts, then changes the derived active pointer, then confirms completion;
pending publications fail closed. Durable activation evidence reconciles a lost
completion response even after a newer owner edit has superseded that revision.
Owner edits survive delayed automatic detection, explicit restores create new
revisions, and repeat initialization/new connections preserve history.

Guard/storage verification: Node 24 compilation and all three affected real-DB
tests pass (no skips), with AST refresh at 309 files, 1,895 nodes, and 6,824 edges.
A preceding storage rerun exceeded its 60-second test timeout while PostgreSQL
was waiting on WALWrite; it is recorded as cancelled, not passed. The repeated
run used a five-minute integration bound and retained durability settings.
Automatic approval review rejected an unguarded test-reset patch before it ran.
The guard test reuses its synthetic database; destructive fixture cleanup now
requires the dedicated `nocheh-stores-fixture` PostgreSQL cluster marker as well
as the explicit fixture opt-in. The task-owned fixture alone was restarted to
set that marker. Its optional Inngest/Redis services are stopped after acceptance.
[Guard evidence](compatibility/results/2026-09-18-guard-store-recovery.json).
Production callers still use their existing guarded path; this is not activation
or evidence that the full data-store migration is complete.

The reprocessing repository adds idempotent owner requests to the existing
preparation outbox, validates original file references and bytes, and persists
output before guarded preparation or completion. Its execution step holds the
existing preparation authority fence and a per-job lock. The subscription engine
uses the pinned native `perception.transcribe` contract; deterministic fixture
engines verify two versions without adding a provider integration.

Selections preserve immutable revision and activation history, require prepared
guards, allow automatic selection only for the first result, and use the same
revocation-before-publication protocol as guard edits. Old contexts fail closed
after activation and Honcho/native review refreshes are requested. Reprocessing
does not silently activate its output or copy an old owner's edit to new text.

Node 24 compilation and four affected real-PostgreSQL tests pass without skips,
including guard-failure retry without another transcription, two engine versions
over exact original bytes, explicit switching/backtracking with retained owner
edits, unprepared activation denial, and interrupted selection reconciliation.
AST-only Graphify: 314 files, 1,918 nodes, 6,932 edges, zero model calls.
[Reprocessing evidence](compatibility/results/2026-09-18-derivative-reprocessing.json).
These interfaces are still candidate repositories; production/API/CLI/dashboard
callers and the remaining migration have not been switched.

The new source projection normalizes reply targets and individual/anonymous
reaction observations, including source timing, actors when supplied, exact
reaction types, additions/removals, and anonymous counts. Unknown future fields
stay in original payloads. The frozen legacy projection is unchanged. Incoming
wire batches are classified as observed originals, and capture records reaction
timestamps even when no message body is available.

The archive relationship repository resolves old targets independently of graph
pagination. Scoped readers cannot use unknown or contradictory topic membership,
and external reply targets require their own matching audience. The owner can
inspect unresolved references. This is scope filtering, not a control-policy grant;
production retrieval must also apply consent and action authorization.

Node 24 compilation, nine affected TypeScript/PostgreSQL checks, and six Python
capture checks pass. No fresh human reactions, subscription checks, or live gates
are claimed. [Relationship evidence](compatibility/results/2026-09-18-source-relationships.json).
Learning and production store routing remain pending.

Owner project and sharing policy repositories now live in control storage. They
provide revision-checked, idempotent create/edit/archive, chat/topic assignments,
explicit exclusions, inherited topic membership, and selected sharing rules.
Every mutation checks owner authority, advances the guard/access epoch in the
same transaction, and requests memory refresh. Project membership does not
create a sharing rule or authorize reading another conversation. Sharing rules
only select inputs for a separately prepared release; raw access is not granted.

Node 24 compilation and all four affected real-PostgreSQL checks pass, including
owner-only changes, idempotence, inheritance/exclusion, stale revisions, archived
project handling, exact sharing destinations, and revocation of old contexts.
AST-only Graphify: 321 files, 1,969 nodes, 7,114 edges, zero model calls.
[Project policy evidence](compatibility/results/2026-09-18-project-sharing-policy.json).
Sharing content preparation/approval, production routing and owner interfaces
remain pending; this is not a claim that project UI or sharing delivery is done.

The bounded Honcho provenance reader follows conclusion ancestry to native
message IDs and maps those IDs through confirmed Nocheh ingestion receipts.
Every native query is workspace-scoped; Nocheh checks the current installation,
guard epoch, audience, and attached/verified state before and after the read.
Missing conclusions, truncated ancestry, absent message metadata, and unverified
ingestion links are explicit limitations. Ancestry is not labeled an exact quote
citation. The adapter reads no conclusion text or embeddings and calls no model.

Two affected real-PostgreSQL checks and three Python ancestry checks pass. The
new route registers successfully against the pinned Honcho image in a disposable
container with networking disabled and no credential/state mounts. AST-only
Graphify reports 326 files, 1,986 nodes and 7,168 edges. Native database traversal,
full inference integration and fresh live acceptance remain pending.
[Provenance evidence](compatibility/results/2026-09-18-honcho-provenance.json).

Learned-memory projections now retain immutable derivative versions, provenance,
guarded outputs, evidence dependencies, owner corrections, and retirement history.
Publication uses the same recoverable control-revocation/derived-activation protocol.
Owner corrections cannot be replaced by automatic proposals; changed guarded input
or selected derivative revisions block reuse of dependent inferred projections.
Model-facing reads require scope and evidence authorization in addition to guards.
Owner inspection/history are separate administrative operations.

Interpretations support meanings, subject states, and quoted participant conventions.
Project-wide conventions require a quoted unambiguous project reference. Explicit
rules outrank inferred meanings, owner corrections outrank affected interpretations,
and conflicting explicit rules remain visible without arrival-order resolution.
The result schema cannot set administrative, guard, provider or privacy policy.

First guarded preparations/new projections now preserve the current epoch because
no earlier authorized representation exists. Pending publication still blocks reads;
changing existing content or selecting an engine revokes the epoch before publication.
This prevents initial preparation from causing endless unrelated memory rebuilds.

Node 24 compilation and all four learned/guard/reprocessing checks pass. A preceding
run found an ambiguous history join; that run failed and the fixed query passed the
rerun. AST-only Graphify: 330 files, 2,012 nodes and 7,297 edges, zero model calls.
[Learned version evidence](compatibility/results/2026-09-18-learned-memory-versions.json).
Automatic Honcho learning execution, native memory refresh integration, production
routing, owner interfaces and live acceptance remain pending.

The candidate automatic-learning worker prepares permitted source and relationship
evidence independently of reply dispatch. It uses the guarded Honcho reasoning
endpoint, preserves completed results before preparation/publication, and records
inspectable meaning/state/convention versions without any delivery or acknowledgment
operation. Imports require explicit learning consent; live sources follow selected
conversation access. Unknown reaction topic context waits for its target.

Context includes bounded old-target observations and related activity. Embedded
reply/external-reply text is removed from the model projection until the target is
independently authorized. Only selected derivatives and applicable permitted rules
enter the request. Exact source/guard/selection dependencies and existing corrections
are checked on use. Identical authorized inputs reuse completed work across unrelated
generation changes, preventing recursive learning from its own output.

Prepared projection batches record all pending activations and workflow recovery in
one control transaction before exposing changed versions. A crash after one derived
activation leaves the batch unavailable; resumption reconciles the remainder using
the saved reasoning result. Existing owner corrections are not overwritten.

Node 24 compilation and five affected synthetic/PostgreSQL checks pass; a targeted
rerun additionally proves update-batch revocation and partial-publication recovery.
No external provider or Telegram calls ran: Honcho reasoning is a deterministic
fixture. AST-only Graphify: 334 files, 2,035 nodes, 7,488 edges, zero model calls.
[Automatic learning evidence](compatibility/results/2026-09-18-contextual-learning-worker.json).
The production workflow handler, native ingestion/context integration, owner UI,
portability, full rehearsal and fresh live gates remain pending.

</original_only_archive>

<conversation_state_inference>

## Conversation state and conventions — 2026-09-17

The owner's requirement is recorded under "Conversation state and conventions"
in [SPECS.md](SPECS.md). Implementation and live acceptance are pending.

Source inspection confirms that `src/source-model.ts` projects authorship,
containment, replies, and threads. `integrations/hermes/capture.py` preserves
delivered reaction and reaction-count updates, but the legacy source projection
does not normalize their message/actor relationships. `src/graph.ts` renders
recorded relationships; that does not establish interpretation of task state.
The generic source contract can represent additional relations and operations,
but this is not evidence of an implemented reaction-driven state-inference flow.

Implementation planning needs normalized reaction/change capture, retrieval of
the affected older source context, and a durable path to refresh derived state.
Define how group/project rules are supplied, attributed, scoped, updated, and
combined with learned conventions. Rule precedence and maintenance controls need
a concrete design; no new database layout or prompt-management mechanism is
selected by this documentation increment. Coordinate derived-state placement
with the pending [archive separation](docs/adr/0052-pure-source-archive.md).

Pending acceptance covers a check reaction on an old task under an explicit
completion convention; a different meaning in another group/project; learned
and ambiguous meanings; reaction removal/replacement and later corrections;
duplicate, delayed, and out-of-order observations; missing actor/context; and
audience/consent enforcement without treating reactions as action approvals.
Verify source preservation and the state-to-evidence trail across restart.

This increment changes specifications and status only. Documentation structure,
links, consistency, and requirement coverage are checked. No runtime changes,
reaction subscription checks, inference tests, or live acceptance are claimed.

</conversation_state_inference>

<archive_storage_boundary>

## Pure source archive boundary — 2026-09-17

The owner clarified the archive's storage boundary after inspecting the database
schema. The durable requirement is in [SPECS.md](SPECS.md), with the boundary
decision and supersession in [ADR-0052](docs/adr/0052-pure-source-archive.md).

Source inspection confirms that `src/database.ts` initializes archive, guarded,
memory, execution, security, and workflow tables through one PostgreSQL client.
Native Hermes notes remain profile files and its sessions remain native SQLite;
Honcho has a separate PostgreSQL store. However, the Nocheh database stores memory
review content, filtered memory, Honcho receipts/context caches, and operational
state. `integrations/hermes/prepared_context.py` also submits native memory text
and tool results for preparation; `src/prepared-context.ts` persists new fragments
as `derived_artifacts.kind = 'runtime_context'`, alongside guarded revisions.
The archive therefore does not yet satisfy the clarified boundary.

Implementation and migration are pending. Define the table/content split and
durable handoff before moving data; preserve original bytes, source IDs,
provenance, owner revisions, consent, audience enforcement, and effect receipts.
Backup/restore and failure-path acceptance must cover the separated stores.
Clarification pending: whether transcripts and extracted file text belong in
the source archive or a separate derived-data store. Their existing preservation
and guarding requirements remain in force. The target database/role layout and
cross-store consistency mechanism have not been selected.

This increment changes documentation only. Structure, local links, diff hygiene,
and related-spec consistency are checked; no data migration, runtime activation,
or live database inspection is claimed.

</archive_storage_boundary>

<dashboard_refactor>

## Dashboard UI/UX refactor — 2026-09-17

The accepted whole-dashboard design and metrics requirements are in SPECS.md and
[ADR-0050](docs/adr/0050-dashboard-components-and-workflow-metrics.md).
The component foundation adds pinned Radix/shadcn-style primitives, Tailwind,
Lucide, browser TypeScript, persisted adaptive themes, grouped responsive
navigation, bounded lazy asset serving, and shared cancellable data subscriptions.
Refresh retains the mounted page and unsaved edits.

Foundation verification: Node 24 production build, two dashboard authentication
and asset/native-boundary tests, and nine graph tests pass. AST-only Graphify
refresh: 276 files, 1,701 nodes, 6,002 edges, zero model calls. Shared-browser
checks on the synthetic Compose fixture confirm dark/system and light themes,
375px navigation drawer, Escape and focus restoration, no main-content horizontal
overflow, and a settings edit surviving manual refresh. The following increments record full route acceptance
and historical metrics verification.

The fixture uses project `nocheh-dashboard-ui-20260916`, its own database/volume,
a private database network, a separate localhost HTTP bridge, and port 18848.
The persistent preview terminal is `49234`. No provider credentials, poller,
scheduler, or external-effect executor is attached. Initial database startup
exceeded the health window; the healthy database was retained and preview
startup retried. Registry-backed `npm ci` in Docker stalled and was cancelled;
compiled assets run on the locally cached pinned runtime image. A clean container
build remains pending. [Evidence](compatibility/results/2026-09-17-dashboard-foundation.json).
Foundation commit `699edf9` is integrated into local main. GitHub fetch/push
failed with `could not read Username; terminal prompts disabled`.

The metrics increment adds bounded PostgreSQL registry aggregates and query
indexes, authenticated owner/legacy proxy routes, lazy Recharts activity/outcome/
duration/current-workload charts, chart data tables, and paginated workflow
history with an accessible receipt drawer. Two database tests and two owner
management tests pass, including aggregate boundaries, both ranges, filters,
deduplication, retry-inclusive duration, invalid samples, domain-vs-registry
completion, terminal failures, empty data, metadata privacy, authentication,
aliases, and import consent/resume regressions. The Node 24 production build passes.
Browser checks confirm independent chart filters, table pagination, drawer focus
restoration, in-place retry receipts, and retained stale status/charts after an
injected outage. The graph refresh reports 1,701 nodes and 6,017 edges with zero
model calls. Monitoring commit `0e1e81c` was reconciled with concurrent source-model main
`b1a4a3d`: production build, eight affected PostgreSQL tests and eleven dashboard
tests pass. Final remaining-page acceptance is recorded below.
[Metrics evidence](compatibility/results/2026-09-17-dashboard-metrics.json).
The final page refactor replaces the legacy monolith with page components,
shared controls, subscriptions and revision-bound drafts. Overview, archive,
memory, Honcho, integrations, imports, activity, memory access, settings,
maintenance and graph now use the shared presentation. A route-handoff race in
shared subscriptions has a focused regression test. Refresh retains selection,
unsaved edits and the original compare-and-swap revision; stale saves reject.
Import consent and group mappings remain bound to the selected job and resume.

Final checks: 92 tests pass in the clean image; its one container-boundary test
runs separately with synthetic loopback service aliases and passes. That covers
all 93 tests, including the three new subscription regressions, existing graph,
owner-session, privacy, workflow, native Inngest inspection, database startup,
source preservation and import consent/resume checks. Host Node 24 and the clean
locked-dependency Docker development build pass; npm reports zero vulnerabilities.
The initial network build blocker is resolved. The production runtime image also builds successfully; its digest
is recorded in the final acceptance file.

Browser acceptance covers all twelve routes in light/dark at 375, 768, 1024 and
1440 pixels, with no page-level horizontal overflow. Additional checks cover
chart filters/data/keyboard tooltips, zero/unavailable/stale observations,
pagination, receipt drawers, exact approvals and bounded permission revocation,
guarded editing and stale-save rejection, settings conflicts, import consent and
resume, audience previews, memory history, and backup/restart/restore reviews.
Escape restores focus. Graph sources remain inspectable under injected graphics
failure. Loaded reduced-motion CSS disables transitions/animation; chart
animations are disabled. Checked text/status token pairs exceed 4.5:1 in both
themes. Recharts and Three.js are absent from the main entry bundle and load
through separate dynamic imports. The final AST graph includes TSX/JSX:
300 files, 1,832 nodes, 6,634 edges, zero model calls.

The final fixture adds optional pinned Inngest/Redis acceptance dependencies on
its private network with no registered runtime workers or published ports.
Cached-image Python allowlist and invalidated host-build-mount failures were
resolved by testing the clean immutable image. Host suspension stopped the
fixture; ownership was checked before restarting it. The final preview uses terminal `5513` and image
`nocheh-dashboard-ui-final:20260917`; the optional native check services are stopped.
[Final acceptance](compatibility/results/2026-09-17-dashboard-acceptance.json)
records build, browser, test, isolation, and setup-retry details.

After the owner's explicit request to build Docker and show the changes at
`http://localhost:8783/#monitoring`, the local installation's `nocheh-app` and
`nocheh-dashboard` images were built from `e0d8666` and recreated with Compose
`--no-deps --no-build --wait`. Both are healthy. Every other installation
container retains its identity; the existing runtime, executor, provider, and
storage services were not recreated. The browser shows the new monitoring UI,
status badges, four charts, period/family controls, and chart-data disclosure.
Owner-session requests for both historical ranges and the legacy alias return
bounded aggregates; unauthenticated metrics return 401. This is a local dashboard
activation, not a broader release or provider cutover. The persistent dashboard
log terminal is `58831`.
[Local activation evidence](compatibility/results/2026-09-17-dashboard-local-activation.json).

The owner reported that the summary data values were still uncolored. Workflow
summary values now use their semantic status colors directly, with matching
Lucide label icons. Missing values remain neutral, while observed zero counts
retain their labeled category. Both light/dark themes pass browser checks at
375 and 1440 pixels with no horizontal overflow; unavailable values are neutral
in both themes. Value contrast on panel surfaces is at least 5.5:1. The pinned
Docker production build and all 12 dashboard checks pass. The AST-only graph
refresh reports 300 files, 1,946 nodes, 6,800 edges, and zero model calls.

The verified management image is installed in the local dashboard at port 8783;
only that container was recreated. All five live metric values and label icons
are visibly colored, and the open Monitoring tabs were refreshed. The initial
live workflow observation was unavailable and recovered on subsequent polling.
The synthetic preview remains on port 18848 in persistent terminal `86398`.
[Value-color evidence](compatibility/results/2026-09-17-dashboard-value-colors.json).

</dashboard_refactor>

<compact_monitoring>

## Compact Monitoring dashboard — 2026-09-16

Owner accepted a compact operational summary in Nocheh with expandable details
and an obvious **Open Inngest** link. Monitoring shows all-family running,
waiting and failed totals, last confirmed workflow completion, and unpublished
backlog. Detail sections retain workflow filters, receipts and authorized controls,
Telegram history, provider observations, background work and service diagnostics.
Uncertain outcomes, stale workers and unhealthy services remain visible.

Verification: pinned Node 24 fixture image and TypeScript/dashboard build pass;
five focused workflow/owner-session/native-inspection tests and nine existing
dashboard tests pass. Shared-browser checks cover collapsed defaults, filtering,
keyboard disclosure, inspector focus, retry/cancel, ten-second refresh,
unavailable/stale observations, authenticated Inngest navigation and 375px layout.
The AST graph was refreshed without model calls. [Evidence](compatibility/results/2026-09-16-compact-monitoring.json)
retains fixture setup failures and their successful retries. The isolated preview
runs on port 18837; deployment to the active installation was not performed.
Feature commit `25982bc` is verified. GitHub HTTPS authentication blocks fetch
(`could not read Username; terminal prompts disabled`); remote synchronization
remains pending.

</compact_monitoring>

<import_extensibility_review>

## Platform-independent import database — 2026-09-16–17

The owner authorized implementation after requesting a long-term database design
for future platforms, including Slack and Discord. [ADR-0051](docs/adr/0051-platform-independent-sources.md)
records the accepted design; the [source-model guide](docs/source-model.md)
defines the adapter contract and isolated acceptance procedure.

Implemented an additive PostgreSQL model for source objects, revisions, immutable
observations, typed relationships, and migration receipts. Identities distinguish
platform, namespace, object kind, and opaque external ID. They are independent of
connector installation and local audience. New platforms use versioned source
descriptors with adapter provenance, completeness, operation, and metadata.
Unknown original fields and exact source/file bytes retain their preservation paths.

Serialized migration backfills existing events in batches without changing event
IDs, hashes, original bytes, owner edits, dispatch receipts, or learning consent.
Telegram Bot API and Desktop identities retain separate namespaces. Graph queries
use the common relationships, resolving only authorized observations. Portable
exports retain explicit descriptors; guarded reads omit unprepared metadata.
New channels cannot trigger Telegram dispatch or attachment downloads. Snapshot
fingerprints include all five new source-model tables.

Validation: the pinned TypeScript compiler/dashboard build passes locally. The
Node 24/PostgreSQL regression run initially recorded 82 passes, four failures,
and three fixture-dependent skips. A scheduler compatibility regression was fixed;
approval and dashboard failures passed on retry; the database-disconnection test
requires its explicit isolated-fixture flag. All 14 affected regression checks
passed on their targeted rerun. All six final source-model/disconnection tests
passed, including a backfill spanning more than 200 records. Across the suite
and targeted follow-ups, 86 distinct checks passed; the three external-fixture
checks remain skipped. The 14 Python archive/import-job/operations tests passed.
The extra Docker compiler check was stopped after prolonged execution; it is
not a pass. Fixture-only dump/restore and restart preserve identical fingerprints
for 11 checked tables, including all five source-model tables.
[Content-free acceptance evidence](compatibility/results/2026-09-17-source-model.json)
records coverage, fixture failures, successful retries, and build limitations.
The synthetic fixture container, network, and database volume were removed.
Integration with the concurrent dashboard foundation passes a full Node 24.13.0
build and 11 dashboard/auth/graph checks; 17 executor/operations Python checks
also pass. Backend dependency pins are unchanged. The AST graph was refreshed
without model calls. The new source decision is ADR-0051 to preserve the
concurrently accepted dashboard ADR-0050.

No Slack/Discord export parser, live connector, active-installation migration,
provider call, or deployment is included. Dedicated adapters can build on this
contract and the existing resumable import workflow. Real Inngest/bootstrap,
Docker-routing, and native UI acceptance remain separate fixture requirements.

</import_extensibility_review>

<application_database_bootstrap>

## Inngest database setup inside the app — 2026-09-16

Owner requested removing `inngest-db-init` and merging it into another service.
[ADR-0049](docs/adr/0049-application-database-bootstrap.md) puts provisioning in
`nocheh-app` before API readiness; Inngest waits for application and Redis health.
The dedicated database and restricted role are preserved. Restore overrides the
application command to run provisioning alone, without execution authorities.

Fresh isolated Compose startup, four Node 24 tests, six Python tests, concurrent
initialization, data preservation, startup during an Inngest outage, and invalid
credential rejection pass. Snapshot/inactive restore preserves 15 workflow tables,
Redis state and synthetic archive data; restart preserves the restored contents.
Only PostgreSQL and Redis run in the restored fixture. Test resources were removed.
[Acceptance evidence](compatibility/results/2026-09-16-application-database-bootstrap.json).
Documentation checks and the AST-only graph refresh pass. The installed image uses
the cached pinned Nocheh runtime and locked build dependencies; a registry-backed
build stalled and was cancelled. Code commit `9bb3d14` is integrated into local
main and installed. At that installation step, the app was healthy with
capture/outbox ready and workflows connected; all 15 running containers were healthy. Both database identities are
preserved, and the completed initialization container is removed without deleting
volumes. GitHub HTTPS authentication blocks fetch/push (`could not read Username;
terminal prompts disabled`), so remote synchronization is pending. This increment
is independent of the pending management migration.

</application_database_bootstrap>

<container_management_migration>

## Dashboard and executor in Docker — 2026-09-16

The owner requested renaming the executor service to `nocheh-executor`. Compose,
lifecycle commands, the monitoring catalog and the system diagram use that name.
Inngest application identities and durable receipts retain their existing identities.
All 28 focused checks pass on the host and in the rebuilt management image.
Synthetic Compose validation and the AST-only graph refresh pass. Code `e9004a9`
is integrated into local main and installed. The old executor drained normally and
was removed; `nocheh-executor` is healthy, all 17 services are healthy, all nine
workflow registrations refreshed, and Monitoring displays the new name. Host and
container lifecycle detection pass. Other container IDs and all volumes are preserved.
[Rename evidence](compatibility/results/2026-09-16-executor-rename.json).
The old dashboard's graceful shutdown stalled without active maintenance; its
process was terminated and the replacement started healthy. Bounded dashboard
shutdown and intermittent unavailable workflow/archive summaries need follow-up;
the service catalog, API/capture readiness and Inngest connectivity were available.
The concurrent compact-monitoring change is retained in Git but is not deployed by
this management-image-only rename. GitHub authentication still blocks remote push.

Owner requested moving the dashboard and executor into Docker, rebuilding services,
and cleaning up obsolete Nocheh resources. The prepared candidate was copied from
`codex/system-diagram-20260916` into `codex/system-map-20260916`, preserving the
original worktree. The owner then requested “fix all” and explicitly approved
Docker-socket access for both trusted management containers.

[ADR-0048](docs/adr/0048-containerized-management.md) records the administration
boundary. The candidate now includes the authorized socket and group, internal
service addresses, installation paths, container lifecycle and executor recovery.
Fresh isolated Compose acceptance passes startup, owner-authorized socket access,
real isolated tool execution, executor restart/reconnection, Inngest outage recovery,
container backup and inactive restore, diagnostics/restart, and dashboard availability
with the app stopped. The backup verifies 45 archive tables, 14 workflow tables and
15 synthetic state files. Owner and native Hermes pages render through the container.
No production credentials were copied into the fixture.

The serialized TypeScript/PostgreSQL suite passes 83 tests; its separately enabled
container-routing test also passes. The 175-test native suite had timing failures
under concurrent fixture load; both affected tests pass in isolated reruns. Its three
container-skipped checks pass separately on the host, including a real agent sandbox
that cannot reach credentials, sibling files, the Docker socket or the internet.
The 25 focused management Python checks pass. Initial timeout and diagnostic failures
are retained in the [fresh evidence](compatibility/results/2026-09-16-container-management.json).
Documentation checks and AST-only graph refresh pass.

Management, application and development images build from pinned inputs. The changed
Hermes integration is rebuilt over the verified pinned runtime layer; full upstream
Rust/Go downloads were cancelled after stalling. Unchanged provider, tool and store
images retain their existing pins. Commit `283ab38` is integrated into local `main`.
Fetch/push remain blocked by GitHub HTTPS authentication (`could not read Username;
terminal prompts disabled`). The installed 15 containers are healthy.

The owner explicitly approved the live local cutover. At that cutover, the host
executor and dashboard stopped and all **17 Docker services were healthy**, including
`nocheh-dashboard` and the then-named `nocheh-host-executor`. All nine workflow families have fresh worker observations.
The format-5 backup preserves 45 archive tables, 14 Inngest tables, 12 Honcho tables
and 919 files. Database identities and archive record counts are preserved; no data
volume was deleted. The 18 containers in other projects retain their original IDs.
The obsolete standalone `nocheh-dashboard:local` image and synthetic test resources
are removed; rollback images and the full snapshot are retained.

Live synthetic refresh ownership, chat, literal detection and required subscription
transcription all pass. The owner dashboard and monitoring run at
<http://localhost:8783/>. [Live evidence](compatibility/results/2026-09-16-container-management-live.json).

The live check exposed a Mac/Linux boundary: the host CLI cannot observe a lock held
inside Docker's VM. Executor lifecycle detection now queries Compose; Docker errors
fail closed rather than declaring the worker stopped. The supervisor retains its
in-VM exclusion lock. All 28 focused tests pass on the host and in the management
image; real host CLI observation, drain and restart also pass. The fix is integrated
and installed as `26febe1`. The first post-start check encountered temporary PostgreSQL
recovery; final identity, record-count, worker and service-health checks pass after
recovery. AST-only graph and documentation checks pass. GitHub HTTPS authentication
still blocks remote push; the verified implementation and evidence are on local main.

</container_management_migration>

<consolidation_implementation>

## Reviewed deployment and Inngest completion — 2026-09-16

Owner approved [ADR-0046](docs/adr/0046-consolidated-inngest-installation.md).
Implementation and local migration acceptance are complete on
`codex/system-diagram-01a0a683`. Code and deployment evidence through `3c282b6`
are integrated into local main; GitHub HTTPS authentication still blocks
fetch/push. The implementation adds supervised application/capture and Connect
composition,
stored-preparation consumption, the merged broker/guard, and native dashboard
presentation through managed Hermes administration.

That deployment used the [tool and purpose names](docs/services.md), two
host processes and 15 continuously running containers with Honcho enabled.
Isolated startup verified all 15 containers healthy and `inngest-db-init` completed.
The complete pinned Hermes/dashboard and Node 24 application images build.
Owner and native Hermes UI inspection passed; owner diagnostics completed with
all application containers stopped. The host executor recovers receipts even when
its Connect child is unavailable. Production credentials were not copied into
these fixtures, and their provider calls were disabled.

Fresh checks: 78/78 TypeScript/PostgreSQL tests; 169 passing native Hermes tests
with two optional checks skipped in that container; 17 focused host tests,
including the resolved Compose check; and the real agent-container isolation
fixture passed separately. Full-stack Inngest outage, application restart during
that outage, duplicate capture, durable outbox and reconnection passed. All nine
family ownership switches passed in the synthetic installation. Real Connect
pipeline validation passed preparation, Telegram, browser and scheduled receipts.
The host import probe preserved three batch receipts after a lost acknowledgement;
103 imported messages produced no replies or unapproved learning. The real-server
privacy probe rejected protected outputs/errors and scanned 1,126 stored rows
without finding the synthetic protected marker.

The format-5 backup now includes Honcho PostgreSQL, protected configuration,
spending ledger and separate native presentation preferences. A complete synthetic
backup/inactive restore passed archive, Inngest and Honcho fingerprints; restored
capture and workflows report inactive. The restore starts no execution authority
or Honcho writers. Existing format-3/4 backups remain readable.

Preparation admission now queues/observes stored requests in the owner API and
shared-memory reads; those callers no longer invoke a legacy detector. Turning
guarding back on admits new preparation generations while preserving closed
identities. Browser/scheduler claims require the current Inngest epoch. Eight
focused PostgreSQL tests pass, including mode changes, stale authority, duplicate
requests and withholding shared text until its saved projection is ready.

The fault rehearsal exposed a dependency delay: a turn could sleep through the
five-minute transcription recovery lease even after preparation completed.
Dependent workflows now recheck readiness through Inngest every two seconds;
preparation retains its provider backoff. Four focused tests pass. The repeated
rehearsal passed capture during PostgreSQL/Redis/Inngest outages, store restart,
crash after effect before acknowledgement, worker kill and duplicate-event
receipt reconciliation, with exactly three effects for three source identities.

The local installation now uses the canonical services and all nine families are
Inngest-owned at epoch 2. Format-5 snapshots
`data/backups/20260916-consolidation-complete` (722 files) and
`data/backups/20260916-pretelegram-complete` (726 files) passed validation before
the preparation-first, Telegram-second switches. Both handoffs had no live step
lease or unresolved receipt. Existing archive, provider login, Honcho stores,
spending ledger and closed effects were preserved; no application reset was used.
The earlier format-4 snapshot is also retained.

Live owner text and voice each completed once; the unmentioned group note was
intentionally suppressed. The original 18,346-byte voice file matches its SHA-256
and the transcript links to that same input hash. The selected group's reply did
not reveal the private synthetic marker; its scoped credential read the group
source (200) and was denied the private source (404). Post-cutover subscription
refresh, chat, detection and Ogg/Opus transcription passed.

Exact owner approval passed with a genuine `/approve` command and a confirmed
Telegram response containing the exact proposed sentence in the original private
chat. There was one send intent and one delivered result. Restarting Hermes
preserved both receipt hashes and that single send. Six earlier live turns also
retained their original receipt hashes and reply counts, including voice and
intentional silence. The earlier identifier-like proposal was masked by guarding;
the owner rejected it and approved the plain-language replacement. Guarding was
not weakened for acceptance.

The retirement increment is installed locally: legacy scanners, standalone
workers, engine-disable flags and rollback execution are removed. Fresh owners
default to Inngest; retained import receipts only reconcile while paused. Fresh
installations select isolated execution, shared providers and evidence memory.
Historical records and inactive restore holds are preserved. A final-image live
subscription check passed refresh, chat, detection and transcription. The last
pre-install format-5 snapshot contains 800 protected files and 45 archive tables.
The new fresh-install/inactive-restore rehearsal verified 45 archive tables,
14 Inngest tables, 23 synthetic files, Honcho state and all execution holds.

A final outage rehearsal exposed HTTP acknowledgement before Inngest's default
in-memory event consumer subscribed. [ADR-0047](docs/adr/0047-receipted-event-handoff.md)
keeps retrying the same event identity every 30 seconds until a fenced workflow
records receipt. All three focused outbox tests pass. Restarting the fixture
publisher recovered the observed lost preparation event; the full store outage,
crash-after-effect, worker-kill and duplicate-capture rehearsal then passed with
three effects for three sources. The fix is installed from local main `57fbab6`.
API, capture and Inngest
connectivity are healthy; all 15 containers are healthy. The pending exact-text
action stayed unapproved across an application/engine restart, all nine family
registrations reconnected, and the proposal-turn receipt stayed unchanged.
Completed-delivery restart acceptance also passed after the genuine owner command.
Across the retirement and handoff increments, 80 distinct service checks passed;
168 native checks passed, including a terminal-timeout rerun under lower load.
Three environment-dependent native checks passed separately in the 11-check
host run; another 28 host recovery/configuration checks passed.

Final cleanup removed the 21 obsolete installation containers, plus 39 stopped
containers and 12 empty networks belonging only to this session's completed
fixtures. No volumes or backups were deleted. The unrelated project was untouched.
The final installation has 15 healthy containers, two healthy host services,
`inngest-db-init` completed successfully, and optional pgweb stopped. Telegram is
connected; managed administration and the shared provider are available, with
CLIProxyAPI the sole login-refresh authority. The approved local migration has no
remaining runtime acceptance gate. Remote Git synchronization is still blocked.

[Consolidation evidence](compatibility/results/2026-09-16-consolidated-services.json).

</consolidation_implementation>

<production_completion>

Historical snapshot before the consolidation above; its topology and pending
gates describe that earlier maintenance checkpoint.

The owner-approved graceful OrbStack restart succeeded without a force-stop or
reset. All 38 previously running containers were restored, including the separate
coopr project. PostgreSQL recorded no further backend exits between its restart
at 19:58 UTC and the final maintenance check. The earlier backend-exit root cause
remains unproven. The checked-out database connection and guard cleanup repairs
are installed; all 76 isolated service tests passed without skips.
[Recovery evidence](compatibility/results/2026-09-16-database-recovery.json).

Production Honcho now runs in the main `nocheh` Compose project under
[ADR-0045](docs/adr/0045-honcho-in-installation-compose.md). The existing PostgreSQL
and Redis volumes were adopted, with a private database dump, Redis snapshot,
spending-ledger snapshot, and protected-configuration hashes retained. All 12
Honcho tables matched before and after adoption. A storage rollback rehearsal
started the old containers, verified those same fingerprints, then returned to
the new containers before starting writers. Nocheh attachment, generations and
receipts, provider credentials and spending policy were preserved. The five old
containers and two empty private networks were removed; no volume was deleted.
Twenty focused host checks passed. The pinned Hermes suite passed 161 tests with
three optional checks skipped; resolved Compose checks ran separately on the host.
[Consolidation evidence](compatibility/results/2026-09-16-honcho-compose.json).

Only `nocheh` and the unrelated `coopr` Compose groups remain. Nocheh has 20 running
services with healthy checks and one completed bootstrap container. Both host
workers run; all nine family admissions are open and all registrations are fresh.
Seven families retain Inngest ownership at epoch 2. Preparation and Telegram retain
legacy ownership at epoch 1. No ownership or closed execution identity was changed.
There is no admitted outbox backlog; legacy-owned pending requests remain visible.

Automatic primary Honcho context under ADR-0044 recovered through its existing
permanent workflow and dispatch. The maintenance-expired cache initially reported
limited memory, then the regular refresh restored current authorized context. A
scoped read returned the expected synthetic garden fact in 97 ms with memory
available. This is a context-read measurement, not end-to-end Telegram latency.
Hermes still uses small native notes, with Honcho as primary long-term memory.

The previous owner text and voice survived capture; the stored voice transcript
contains the expected synthetic phrase. Their one-attempt receipts remain closed:
text is ambiguous (`dispatch_interrupted`), voice suppressed (`unsupported_message`).
A captionless synthetic voice fixture passes, but that does not replace real
Telegram delivery acceptance. A fresh owner text/voice pair has been requested.
Group silence, isolation, approval and restart acceptance, the final two workflow
cutovers, and a new backup/inactive restore with populated context remain pending.
The earlier format-4 backup/inactive restore passed before this maintenance; its
cache table was empty and it is not fresh evidence for the current populated cache.

Stopped restore, fixture and obsolete dashboard containers were removed without
removing their recovery data or volumes. Two completed worktrees were removed;
untracked diagram context and graph artifacts were preserved under
`data/local/reports/worktree-cleanup-20260915`. The session branch is integrated
and has no active container mounts. Final worktree cleanup results are recorded
in the host reports after Git integration. Local commits are merged into main;
remote fetch/push remain blocked by GitHub HTTPS authentication.

</production_completion>

## Current recorded state — 2026-09-16

| Area | Actual implementation and activation | Evidence / execution plan |
| --- | --- | --- |
| Main integration | Refactor and Inngest consolidation integrated locally; historical legacy branch preserved. Local migration acceptance passes; remote push remains blocked. | [Integration evidence](compatibility/results/2026-09-11-main-consolidation.json), [rebuild plan](docs/rebuild-plan.md) |
| Runtime and owner dashboard | P1–P6 and dashboard D1–D4 implemented; P7 recovery tooling and the consolidated real Telegram acceptance gates pass. | [Runtime plan](docs/runtime-platform-plan.md), [operations evidence](compatibility/results/2026-09-08-runtime-platform-operations.json) |
| Guarded projections | G1–G3 and G5–G6 implemented; on/off guarding and owner edits active locally. G7 guarded recall/restart acceptance passed; Honcho/history acceptance remains separate. | [Guarded-memory plan](docs/guarded-memory-plan.md), [guarded acceptance](compatibility/results/2026-09-09-guarded-memory-acceptance.json) |
| Security service | SEC1–SEC5 verified; isolated execution and evidence memory active locally. | [Security plan](docs/security-service-plan.md), [activation](compatibility/results/security-service-activation.json) |
| Telegram monitoring | Recovery supervision, observed polling health, workflow monitoring, and local OAuth callback implemented. | [Recovery evidence](compatibility/results/2026-09-11-telegram-monitoring-oauth.json) |
| Shared provider | S1–S5 pass locally. Hermes uses the shared CPA route; exactly one CPA login is configured and the native login is retired. Text, privacy detection, voice, monitoring outage and full restart acceptance pass. | [Cutover evidence](compatibility/results/2026-09-14-shared-provider-cutover.json), [provider plan](docs/shared-provider-plan.md) |
| Honcho | Attached and verified locally without history backfill. Scoped recall, the native Hermes tool, group isolation, outage fallback and persistence pass with one ingestion receipt and one attempt. Embeddings retain the $5 pilot cap. | [Production acceptance](compatibility/results/2026-09-15-honcho-production-acceptance.json), [recall regression](compatibility/results/2026-09-15-honcho-recall-regression.json), [prior live acceptance](compatibility/results/2026-09-14-honcho-live-acceptance.json) |
| Space memory | M1–M5 implemented/fixture-tested within the recorded scope; filtered archive text supported. Filtering extensions and live checks below remain pending. | [Space-memory plan](docs/space-memory-plan.md), [fixture evidence](compatibility/results/2026-09-08-space-memory.json) |
| Specification workflow | AGENTS.md, SPECS.md, and plan/status consolidation implemented. XML structure, document links, requirement coverage, and supersession checks pass; runtime files and accepted ADRs are unchanged. | [ADR-0040](docs/adr/0040-specifications-and-agent-workflow.md) |
| Inngest workflows | All nine families are active on Inngest at epoch 2; legacy execution is retired. Text, voice, group silence, scoped isolation, fresh install/restore and fault recovery pass. Exact owner approval and final live restart pass. | [Consolidation evidence](compatibility/results/2026-09-16-consolidated-services.json), [execution plan](docs/workflow-monitoring-plan.md) |

Earlier fresh-image workflow regression (historical): 73 service tests and 152 Hermes tests passed;
one optional Docker security fixture was skipped. Real local Connect outages,
crash-after-effect recovery, legacy rollback, privacy and inactive restore passed. These synthetic
checks do not replace the live acceptance below. No legacy persisted-data migration is required;
VPS work remains deferred.

<local_inngest_cutover>

Historical seven-family checkpoint; the consolidation above completes all nine.

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

The owner reaffirmed ADR-0033: Honcho is the primary long-term memory and Hermes
keeps small native notes. The earlier use of "hybrid" referred to native Hermes's
combination of automatic context and recall tools, not a different memory-backend
decision. The latency recommendation is to provide Honcho context automatically,
reuse Honcho-provided context where valid, refresh it in the background, and use
deeper reasoning tools when useful. Small native notes remain complementary;
the recommendation does not make primary memory depend only on the agent choosing
a tool. It must preserve full authorized native context and enforce current
audience, source revisions and memory generations before any cache reuse.
Nocheh currently uses a guarded blocking recall adapter and manages memory.provider
itself; editing a native Honcho setting alone does not change that adapter. This
retrieval optimization is a recommendation, not an implemented or activated mode.
The blanket reasoning call remains a latency limitation.
[Accepted memory decision](docs/adr/0033-guarded-projections-and-honcho-memory.md).
[Native provider reference](https://github.com/NousResearch/hermes-agent/blob/main/plugins/memory/honcho/README.md).

The standard services rebuild stalled resolving the pinned Node base metadata
and was cancelled. An offline candidate copies only the tested compiled Honcho
module onto the verified installed services image, with unchanged dependencies;
its module hash matches the test artifact exactly. The Hermes candidate built
from its normal pinned recipe. Both candidate image digests are recorded.

[Memory availability and startup evidence](compatibility/results/2026-09-15-memory-availability.json).

</telegram_live_latency>

## Outstanding acceptance and blockers

- **Subscription transcription:** final-image shared-login Ogg/Opus transcription passes. Real owner voice bytes, input hash, expected transcript and one completed reply are verified.
- **Telegram / release:** real text, voice, intentional group silence, scoped private-source denial, exact owner-approved delivery, and pending/completed receipt preservation across restart pass. The approved local consolidation is accepted; [release acceptance](docs/release-acceptance.md) remains the repeatable procedure.
- **Shared provider:** the owner explicitly approved the switch after the earlier testing-only rejection. S5 passed and the shared route is active; the old native login is privately retired. No provider cutover blocker remains. The refresh check verifies authority delegation, not a newly forced token-expiration event.
- **Honcho:** attached and verified; scoped production ingestion/recall, native-tool access, isolation, outage and restart acceptance pass. The opted-in history pilot and monthly budget cutover remain pending. Preserve the durable pilot ledger and explicit learning consent. See the production acceptance evidence above.
- **Space memory:** native-note/transcript filtering is not implemented; its provider-payload/destination extension was blocked by an earlier automatic approval review. Live native-review/filter quality and the browser policy-save check also remain pending. See [recorded boundaries](docs/space-memory-plan.md).
- **Optional comparison:** the isolated Honcho comparison remains pending and does not block release; production Honcho activation has separate gates.
- **Remote synchronization:** each verified increment was merged locally under the shared Git lock; fetch and push repeatedly confirmed that local GitHub HTTPS authentication is unavailable. Local integration and remote push outcomes must be reported separately; do not infer synchronization from a local merge.

## Development follow-ups and proposals

- **Per-session previews — not implemented:** add explicit isolation of Compose projects, networks, image tags, ports, state, and credentials before concurrent worktree previews. No duplicate Telegram poller, scheduler, or OAuth refresh owner may use the active installation.
- **Makefile — not implemented:** `dev` is declared phony but has no recipe. Existing `./scripts/nocheh dev` runs the installation's Compose Watch workflow; it is not an isolated-session setup command. Wiring `make dev`, fresh-worktree setup, and visible persistent preview startup are follow-up tooling work.
- **Inngest — accepted implementation:** [workflow execution plan](docs/workflow-monitoring-plan.md), I1–I7. All nine families are active, legacy execution is retired, and the approved migration acceptance passes. Independent host recovery remains available; optional memory follow-ups are separate.

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

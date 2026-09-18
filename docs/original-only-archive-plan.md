<execution_plan>

# Original-only archive implementation and clean restart

<authority>
The owner accepted this plan on 2026-09-18. Product requirements live in
[SPECS.md](../SPECS.md); [ADR-0053](adr/0053-original-only-archive.md) records the
storage decision. [TASK.md](../TASK.md) records actual progress. Implement in the
session worktree and integrate verified increments under the shared Git lock.
</authority>

<increments>

1. Record the accepted boundary, learning/project requirements, supersession,
   reset authorization, and acceptance checklist.
2. Introduce archive/derived/control database provisioning and repository
   interfaces, typed references, archive purity, and recoverable capture handoffs.
   Separate original file manifests from retrieval attempts. Remove cross-domain
   joins/triggers while adapting each dependent service.
3. Move guard data and generated records into derived storage and control state
   into control storage. Test revocation-before-visibility, interrupted changes,
   durable results, retries, and uncertain external effects.
4. Add derivative lineage, owner reprocessing/activation, source-only retrieval
   and graph defaults, complete portable import/export, and coordinated backup.
   Retain subscription transcription; use a second deterministic fixture engine
   to prove version switching without adding a real provider.
5. Normalize replies/reactions and refresh contextual learning independently of
   assistant dispatch. Add bounded Honcho provenance, learned-memory correction,
   project management, and explicit sharing through owner API, CLI, and dashboard.
6. Verify the complete candidate in an isolated Compose project using synthetic
   data without live credentials, pollers, schedulers, or refresh authority.
7. Build the verified installation, prepare an exact scoped reset manifest,
   perform the authorized reset, verify the empty baseline, collect new live
   acceptance evidence, and resume saved setup only after all required gates pass.

</increments>

<storage_setup>

API/capture and workflow services use independent domain pools so native/Honcho
callbacks retain capacity while workers await external work. Ordinary Connect
execution has four slots. Publication retries preserve the same event identity,
prioritize requests not yet accepted, and back off only for consecutive transport
failures; successful receipt probes do not enlarge a later outage's delay.
The combined fixture runner is `compatibility/installation-rehearsal.py`. It uses
explicit immutable images, new synthetic state, internal networks, no live login,
and deterministic provider transports. Its successful report records each gate;
missing live gates remain pending even after this rehearsal passes.

The saved `NOCHEH_STORAGE_LAYOUT` selects the installation layout; existing
configurations default to `legacy` until the controlled cutover. Ordinary settings
Apply cannot change this internal setting. `original-only-v1` selects
`deploy/original-only-compose.yml` through the shared Compose command builder.
Shell overrides cannot silently select another layout.

The setup-only `nocheh-store-bootstrap` service owns the administrator login and
provisions archive, derived, control, and independent Inngest storage. It shares
the installation maintenance lock with backup/reset and refuses an inactive
restore marker. Archive, derived, control, administrator, and Inngest credentials
are distinct. Runtime app/security services receive only the three domain
credentials; Hermes receives none of these database credentials. Settings redact
the role credentials and do not expose them as ordinary editable values.

`src/stores/runtime-pools.ts` opens explicit domain pools and rejects bootstrap
credentials. Legacy database initialization rejects the original-only layout.
The trusted application startup writer admits saved assistant setup into versioned
control records. Policy and guard-mode changes revoke the prior epoch and enqueue
refresh work in the same transaction; security and execution paths reject an
outdated service configuration. Equivalent setup reuses its revision.
Application and security entrypoints select the separated repository composition
for this layout. Neither entrypoint initializes schemas or falls back to the legacy
pool. HTTP admission fsyncs observations before acknowledging them; independent
capture/reconciliation stages retire the spool only after downstream control
requests are durable. Scoped requests wait for the configured guard mode and all
three stores contribute to health. Restored installations refuse content access,
including in the security service through a read-only spool marker mount.

Preparing a source's first guarded copy leaves unrelated authorized contexts
available. That new source remains unreadable until its own prepared pointer is
ready. Replacement guards, derivative selection, and learned publications keep
the pending-publication authorization barrier. Reconciliation includes first
preparations even though they do not globally revoke existing contexts.

Preparation, reprocessing, native review, Honcho, and contextual learning register
with the existing Inngest workflow engine. Admission is bounded before borrowing
database clients; refresh sweeps checkpoint source/projection cursors in control.
Native ingestion uses work revisions so later inputs can schedule observation
after an earlier job completed. Uncertain effects retain their identity while
being reconciled. Guard, selection, and learned-publication recovery runs alongside
capture. Telegram action proposals and results are immutable derived records;
approval and receipt metadata live in control. The native sender checks the exact
current authorization and treats an unconfirmed prior intent as uncertain, with
no resend. Telegram dispatch stores prepared inputs and terminal native results in
derived storage and receipt metadata in control. Native observation precedes any
same-identity continuation; revoked queued contexts are cancelled. Original routing
identifiers cannot be changed through guarded edits. Workflow inspection, health,
metrics, and owner retry/cancel use control-only metadata and receipt/family fences.
They remain available without the Inngest control plane. Legacy family migration
does not apply to fresh original-only databases. Controlled shell/browser/MCP
proposals use immutable derived arguments and exact guarded fingerprints; owner
decisions, bounded grants, revocations, and idempotency receipts live in control.
Policy previews consume no grant. Host tool execution uses a durable claim/start
boundary, rechecks current authority, and saves derived results before control
completion. Retained receipts repair lost completion and settle uncertainty;
expired claims never authorize a repeat execution. The original-only listener
supports host Connect with inactive-installation checks. Host imports use the same
control coordinator, with each source/file/review request fenced by its current
job lease. Originals and file manifests use the archive repository; job membership,
progress, cancellation, review approval, and retained completion receipts use
control. Interrupted source commits replay idempotently without live replies or
automatic learning. Batch review cannot enable sources from another job or undo a
later owner revocation. Owner workflow inspection shows import progress and
revision-checked retry/cancel operations. Legacy bundles containing derivatives use the explicit legacy converter; source-only
import endpoints reject mixed records rather than silently truncating them.
Telegram review/approval/revocation commands use independently captured original
owner DMs and store decision references in control. Imported messages, edits,
guarded content, and group messages cannot grant administrative authority.
Managed capabilities include the admitted logical profile. Named profiles have
separate native identities and prepared-text caches within each audience and
guard generation; default profiles share their identity across transports.
Only preferences carry into a new native generation automatically, never old
unprepared notes. Native profile administration and browser admission resolve
the control catalog. Scheduled execution shares the managed claim/receipt protocol;
the combined installation rehearsal remains a separate gate.
Browser submission capture is filesystem-only until replay: original file bytes
are durable before the source spool entry, and archive commits all manifests with
the source. API acknowledgment reports `spooled`; execution requires separate
admission. Database or Inngest outages cannot discard an accepted submission.
Browser execution now has control-only admission, claims, leases, cancellation,
and receipts. Inputs/results remain immutable derivatives. Native continuation
observes the same receipt first; missing evidence after claim is uncertain and
cannot start a replacement execution. Imported derivative records are marked at
insertion and cannot satisfy current execution/checkpoint recovery. Explicit owner
adoption of imported content and guarded edits remains a separate operation.
An unstarted browser submission binds its execution guard revision after initial
file preparation/selection. The first native request intent is durable before the
call; after that boundary a changed guard cannot silently rebind the run. Default
logical profile IDs stay stable while native state remains generation isolated.
Completed browser output creates an immutable offer in the owned spool, outside
archive. The native dashboard acknowledges an exact received completion frame
or an exact missed response after rendering it. The owner-only `POST /v1/browser/delivered` endpoint verifies its opaque
receipt and text hash, then fsyncs the exact message into source capture. No
PostgreSQL or Inngest dependency can discard that accepted observation. The
browser keeps receipt IDs/hashes for retry across reconnect without storing
message text. Completion emission alone is not delivery evidence. Offers must
be erased with the spool during reset; stale browser receipts cannot recreate
missing offers. `POST /v1/browser/undelivered` resolves the current profile and
returns at most four authorized, unacknowledged results per cursor page. The
native dashboard renders recovery results before acknowledging them; merely
listing a stored result cannot create an original observation. Archive delivery
IDs retire offers from recovery without cross-store joins or a second receipt
source of truth. Native sidebar publication is initialized, while recovery does
not depend on that best-effort WebSocket connection.

A visible completed run supplies its current binding to the native browser.
The gateway validates audience, logical profile, installation generation, guard
revision, and native identity before switching its session database. It clears
old cached history and uses the new native state without copying old notes or
sessions. Native preparation creates the isolated database directory before UI
history reads. Transport channels use logical profiles across guard revisions;
logical profiles still have separate channels. Capture itself adds no database
dependency. Combined browser/Compose acceptance remains pending.
Host import coordination is verified independently; the full installation rehearsal
still requires its separate gate. The opt-in layout is not
yet a complete release candidate. Do not switch the live installation or infer
activation from a successful config render or repository-level HTTP check.

The candidate native-profile catalog lives in control storage. Its owner-only
`/v1/runtime/profiles` and `/v1/runtime/profiles/resolve` operations distinguish
display names, stable logical/preference identities, and current native directory
identities. Rename/retire revokes contexts in the same control transaction.
Native administration and browser admission consume this catalog, rejecting
retired identities, stale native directory aliases, and wrong audiences. Native
filesystem markers supply topic lookup hints only. Stable preference directories
survive rename and feed the next native turn without copying notes or sessions.
Saved native preferences use the bounded transfer library described below; its
reset-coordinator integration remains pending. The combined UI/runtime rehearsal
must verify generation changes during media preparation and browser reconnect.

Schedule definition/capture APIs use control operation references and immutable
versioned derivatives. Control stores configuration, active version pointers,
monotonic cursors, and occurrence identities; prompt/definition/trigger content
stays in derived storage. Changed execution versions revoke before publication;
clock-only cursor updates do not revoke their admitted run. Replays repair failed
handoffs without a new fire identity. Scheduler claims, preparation, heartbeat,
results, recovery, history, delivery proposals, and Inngest operations use these
repositories and the shared managed execution protocol. The native schedule file
remains the clock adapter; the combined rehearsal must verify its recovery against
committed control versions. Completed results close their runtime capability. A
trusted result-specific path stages exact approval proposals without reopening it;
uncertain executions never authorize delivery or a replacement run.

Run `NOCHEH_STORES_FIXTURE=1 python3 -m scripts.store_wiring_check` to render the
combined Compose configuration with temporary synthetic credentials, inspect
credential separation/dependencies, and start no services. The real database
bootstrap fixture additionally checks repeat setup, retained owner history,
maintenance exclusion, runtime role restrictions, and inactive-restore refusal.

</storage_setup>

<owner_interface_rehearsal>

Use `compatibility/stores-compose.yml` with
`compatibility/stores-dashboard-compose.yml` and profile `owner-preview` for the
candidate owner-interface fixture. Build the dashboard and TypeScript first. Set
an explicit fixture image, a dedicated Compose project, and a free localhost port
in a session-owned environment file (`NOCHEH_STORES_FIXTURE_IMAGE`,
`NOCHEH_STORES_FIXTURE_PROJECT`, `NOCHEH_STORES_UI_PORT`). Verify the actual
PostgreSQL cluster marker before seeding. Keep the foreground Compose terminal
visible alongside the preview. Restart the preview container after each rebuild,
because the build replaces the mounted output directories. Reload the browser
and inspect the new bundle before recording UI evidence. Never reuse an
installation database or credentials.

The fixture exercises real archive/derived/control repositories and owner
session/CSRF boundaries with synthetic messages, exact original file bytes,
versioned fixture transcription, deterministic privacy filtering, and inspectable
learning projections. It does not run Telegram, live Honcho, subscription providers,
background execution, or credential refresh. Those remain separate full-rehearsal
and live gates. Seeding is idempotent and retains owner edits and active selections
across fixture restarts.

Verify learned-memory corrections/history/retirement, project inheritance and
exclusions, approved and filtered sharing previews/revocation, original-source
inspection, two file-reading versions, guarded edits, reprocessing and activation.
Check retained drafts after revision conflicts, keyboard focus return and visibility
in long panels, desktop and 375px layouts, and light/dark appearances. File readings
are the default source-version view; all internal derivatives remain inspectable.

</owner_interface_rehearsal>

<source_portability_rehearsal>

The candidate source-only API is `GET /v1/exports/sources`,
`POST /v1/imports/sources`, and owner-only original-file byte transfers at
`/v1/original-files/:id/bytes`. `./scripts/nocheh export --sources-only --output DIR`
writes `nocheh-sources-v1`; `./scripts/nocheh import sources DIR` reads it.
It contains original observations, capture timestamps, stable source references,
file manifests, and exact bytes, without derivative or guarded content. The CLI
checks record-file checksums, counts, and all original files before import.
Paginated portable exports are not coordinated recovery points; use backup for
that guarantee.

Import admission is control state separate from an observation's original
`origin`. Persist that admission before archive commit, then complete normal
preparation handoff. Archive commit contains the observation and all supplied
manifests atomically. Bounded reconciliation repairs a lost completion response
without dispatching old replies, fetching historical Telegram attachments, or
automatically authorizing imported sources for learning. Explicit owner learning
consent remains separate. A duplicate import cannot change an existing live
capture admission. Source-only imports reject bundles containing derivative or
guarded records, rather than silently losing them. The complete v2 coordinator
routes these domains separately; legacy bundles use the converter below.

Verify source identity/wire/timestamps, exact binary and empty files, read-only
export during control unavailability, import control-outage behavior, interrupted
archive/control handoffs, missing imported bytes, duplicate imports, and explicit
learning consent. No provider credentials or live messages are required.

</source_portability_rehearsal>

<derivative_portability_rehearsal>

The candidate derivative transfer API enumerates its fixed record types at
`GET /v1/exports/derivatives/types`, exports pages at
`GET /v1/exports/derivatives?type=TYPE`, and retains prior import history at
`GET /v1/exports/derivative-history`. Owner-only
`POST /v1/imports/derivatives` accepts record batches;
`POST /v1/imports/derivatives/verify` checks completed references and heads.
The Python `scripts.derivative_transfer` library checks the package before
transfer, indexes record offsets on disk, imports parents before children,
detects missing/cyclic ancestry, and verifies every declaration afterward.

Restore immutable outputs, guard inputs/revisions, selection history, and learned
projections into derived storage. Restore operation identities only as historical
control references that cannot authorize effects. Retain exact imported records
in immutable derivative history, including prepared caches and guard fragments;
never insert imported cache entries into active preparation tables. Even equal
installation generations and authorization epochs must not revive a cache.

Imported guard heads stay pending and protect owner edits from automatic
replacement. Imported selections and learned projections remain inspectable but
unavailable to runtime readers, including while guarding is off. Explicit owner
guard restoration, prepared selection activation, or learned correction uses the
normal revision and revocation paths. Duplicate imports preserve subsequent
destination edits and selections; immutable conflicts fail without replacing data.

The bundle coordinator below composes these repositories. Complete installation
recovery remains a separate gate; native Honcho row restoration has an explicit
inactive coordinator below. A full export validates source/derivative reference completeness
before publishing its complete manifest. A concurrent append or head change that
leaves a missing parent/revision fails the candidate export explicitly.

</derivative_portability_rehearsal>

<complete_portable_rehearsal>

For original-only installations, `./scripts/nocheh export --output DIRECTORY`
creates `nocheh-portable-v2`: original observations/files, immutable derivatives
and guarded history, Hermes native notes/SQLite sessions, and configured Honcho
memory rows/embeddings. Dashboard archive-only downloads use the source-only API;
complete downloads use the same bundle coordinator. Operational credentials,
Honcho queue state, and webhooks are excluded. An unavailable configured native
store leaves the bundle incomplete. The manifest states that independently read
stores are not a coordinated recovery point; use backup for that requirement.

Honcho uses one exported PostgreSQL repeatable-read snapshot across its eight
pinned memory tables. The package stores data-only JSON, column/type metadata,
and the producer source revision. A reader does not execute SQL supplied by the
bundle. Verify exact native values and embeddings under a concurrent update with
`python3 compatibility/honcho-portable-rehearsal.py --env-file FIXTURE_ENV`.
This command requires the isolated PostgreSQL marker and creates/removes only a
new randomly named synthetic database.

`./scripts/nocheh import --portable DIRECTORY --native-output SEPARATE_DIRECTORY`
validates the whole package before API mutations, then imports originals through
the archive repository and derivative history through its dedicated repository.
It stages native history in a separate inactive directory, preserves the package
manifest, and records a durable import receipt. Retry uses the same package and
refuses to overwrite changed native files. Imported guards, selections, learned
projections, caches, and native state cannot authorize execution or attachment.
An owner must adopt representations through the normal guarded/revisioned paths.
Restore staged Honcho rows with
`./scripts/nocheh import --honcho-memory DIRECTORY/honcho --inactive-state STATE`.
The target must have a restored-inactive marker and an empty, initialized native
database whose column types match the pinned package. The coordinator rejects
running writers and orphan writable state mounts. It starts no service and changes
no attachment, provider, or spending configuration. Data enters temporary tables
before a single transaction materializes all eight memory tables. Exact completed
replay is accepted; a populated conflicting target, nonempty native queue/webhook
state, schema mismatch, or malformed row fails without replacing memory. Native
identity sequences advance past imported IDs. The standalone synthetic rehearsal
checks those boundaries. The pinned-schema rehearsal additionally uses the actual
Honcho Alembic migrations and ORM models on pgvector with 1,536-dimensional
embeddings, citation ancestry, and soft-deleted history. Use the dedicated
`compatibility/native-portability-compose.yml` with explicit fixture project and
image variables, then run `python3 compatibility/native-portability-rehearsal.py
--env-file FIXTURE_ENV`. It requires the native fixture cluster marker, creates
random test databases, and removes only those databases afterward. The schema
runner invokes no provider or deriver. Complete native service behavior and
coordinated installation restore remain separate gates.

Verify `store-portable-bundle.test.ts` using the fixture's read-only `scripts` and
`integrations` mounts in addition to `dist`. It exports from one empty three-store
namespace and imports into another through owner HTTP APIs, preserving exact
original bytes, two engine versions, guarded owner edits, and inactive Hermes
notes/sessions. Missing references/history, tampered files, symlinks, overlapping
destinations, interrupted import, and changed destination notes have offline
regression coverage.

Legacy `nocheh-archive-v1`/`nocheh-portable-v1` imports use the owner-only
`POST /v1/imports/legacy` converter. It retains each exact incoming document as
an immutable imported derivative before routing original observations/files to
archive and generated records/files to derived storage. Inspect retained input
versions at `GET /v1/imports/legacy/:OLD_EVENT_ID`; generated file uploads use
`POST /v1/imports/legacy/files/:OLD_ARTIFACT_ID/bytes`. Confirmed Telegram Message
observations can become originals, but imported intents never authorize sends.

`--restore-guarded` materializes legacy guard history as pending representations;
without it the exact history remains in the retained legacy document. Conversion
checks input hashes, authors, contiguous revisions, source/file identities, and
bytes. Typed references use normalized safe-integer sizes; the retained document
preserves legacy decimal strings. Conflicting immutable history fails without
replacing existing or later destination edits. Retry retains all incoming versions.
Both v1 and v2 complete import stage native history separately and inactive; a v1
bundle does not claim Honcho data that its format never included.

</complete_portable_rehearsal>


<recovery_rehearsal>

For the original-only layout, backup format 6 contains separate archive, derived,
and control dumps. The maintenance coordinator first obtains the installation
maintenance lock, then stops installation writers,
checks for orphan containers with writable state mounts, and holds a database
write barrier until database, original-file, Hermes, Honcho, and Inngest snapshots
and the manifest are complete. Verify checksums, row fingerprints, sequence
positions, guarded owner edits, and original file hashes. Restore into a fresh
installation only, with runtime database roles NOLOGIN, a revoked guard epoch,
provider logins held inactive, and execution/scheduling disabled.

Run `python3 -m scripts.store_fixture_recovery <fixture-env> <new-output-directory>`
against a dedicated `compatibility/stores-compose.yml` installation to verify the
three-database portion without live data. The script checks the real cluster
marker, refuses existing restore resources, tests blocked writes and interrupted
barrier setup, restores exact data, and restarts only the restored database.
The complete rehearsal must additionally exercise the coordinated original-file,
Hermes, Honcho, Inngest, Redis, and accounting snapshots through the final service
composition. Database-only fixture evidence does not satisfy that complete gate.

`compatibility/coordinated-recovery-rehearsal.py --directory NEW_DIRECTORY
--services-image CANDIDATE --honcho-image PINNED_CANDIDATE` exercises production
CLI format-6 backup/restore through the real Compose definitions with a synthetic
internal-network overlay. It creates fresh source/target installations, real
Honcho migrations and embeddings, both derivative versions and owner edits, native
notes/sessions, Inngest/Redis state, and a spending ledger. It starts no provider,
refresh authority, Telegram poller, or native execution. Runtime roles and logins
stay inactive on restore; fixture containers and volumes are removed afterward.
This rehearsal passes. Add `--management-image CANDIDATE` to run the backup through
the real containerized dashboard, verify that its coordinator survives, and
verify automatic writer resumption before inactive restore. That variant also
passes. It renders only the fresh synthetic installation's service definitions
and uses read-only Git metadata for snapshot provenance; it borrows no live state
or credentials and publishes no host ports.

Dashboard maintenance fences new requests before draining admitted uploads,
management work, websocket connections, and OAuth callbacks. Only authenticated
progress and static dashboard reads remain available. Backup verifies the exact
coordinator container and the active readiness token before writer exclusion,
before publishing its snapshot, and before resuming writers. Changed readiness
fails closed. Other writable state mounts still block the snapshot. Resume uses
only the saved running-service list without implicitly starting dependencies.
The full running application/native/UI rehearsal remains separate.


</recovery_rehearsal>

<reset>

`scripts.reset_protocol` records ordered evidence from isolated acceptance through
quiescence, effect settlement, preservation, erasure, initialization, empty baseline,
the Telegram boundary, fresh acceptance, and resumption. Bind it to the reviewed
preflight and a new installation generation. The caller must verify each phase;
recording a hash does not execute or establish acceptance. Hold the database
maintenance lock as well as the local journal lock while the old database exists.
macOS and Docker do not share advisory-lock visibility. Keep the reset journal and
its exclusive attempt reservation outside all content-erasure paths.

After complete isolated acceptance, call `scripts.reset_quiescence.quiesce` while
holding the journal and the PostgreSQL maintenance lock. Supply the exact reviewed
preflight, including container restart policies. The coordinator records prior
running states and policies before changes, establishes all four inactive fences,
suppresses Docker restart, then stops native ingress/scheduling, host executors and
launchers, and other writers and refresh owners. Database/cache servers remain
available for effect settlement; they are stopped before later volume erasure.
An interrupted shutdown retains its original settings and does not resume services.
Every retry revalidates configuration, container/mount identities, foreign references,
maintenance ownership, and fence ownership. A recorded initially absent fence can
recover an interrupted write of this reset's own prefix. Existing inactive restores
and another reset's markers require separate review.

Verify with `python3 compatibility/reset-quiescence-rehearsal.py --directory
NEW_DIRECTORY --management-image CANDIDATE`. It uses real Compose lifecycle and
PostgreSQL advisory exclusion, synthetic heartbeat writers, a late foreign writer,
and a separate sentinel. It verifies interruption/retry, preserved restart settings,
durable inactivity, database access for reconciliation, and unrelated-owner isolation.
Its synthetic lifecycle evidence does not satisfy full native/provider acceptance.

After quiescence, `scripts.reset_effects.settle` reads the current database layout
and native journals while maintenance remains held. Original source identity reads
use archive storage separately from control receipts. Confirmed transport records
are distinguished from no recorded send and stopped local results with unknown
outcomes. Uncertain external effects, orphan ambiguous receipts, or workflow effects
without domain evidence block progression. Never convert unknown results into
successful execution or replay delivery during reset. Recheck the evidence before
publishing the content-free settlement report and advancing the journal. The
complete preservation coordinator must retain receipts until this gate passes.
`compatibility/reset-effects-rehearsal.py --directory NEW_DIRECTORY
--management-image CANDIDATE` verifies both real schemas and native journal formats
on an internal-only Compose network with synthetic responses and no provider calls.

The internal `scripts.reset_files` primitive freezes the reviewed post-quiescence
installation-local paths into a metadata-only manifest. Bind its exact hash into
the coordinator's durable preservation evidence before calling `erase`. Its barrier
callback must recheck phase/journal ownership, writer exclusion, preservation and
inactive fences before mutations. Descriptor-relative traversal never follows
symlinks. New/replaced entries and overlapping preservation paths block deletion;
missing already-erased entries permit interruption recovery. Pass all four reset
markers as protected paths. This does not remove containers or database volumes,
resolve external backup ownership, or establish that earlier phases passed.
Detailed private manifests can contain filenames: retire them with the reset's
content-bearing administration data before the empty-baseline gate, retaining only
non-content hashes/counts needed for the generation and one-attempt boundary.

Only after verifying the empty baseline, inactive fence, current generation, and
stopped pollers may the coordinator issue one HTTPS `deleteWebhook` request with
`drop_pending_updates=true`. This is the [Telegram backlog operation](https://core.telegram.org/bots/api#deletewebhook),
not deletion of remote message history. Persist the attempted operation and its
exclusive file reservation before sending. Preserve a confirmed response before
completing the phase; reuse that confirmation after restart. A timeout, lost response,
or interruption between reservation and send remains uncertain and must not be
retried automatically. Telegram provides no idempotency key for this method;
an empty current queue alone cannot prove the earlier operation's outcome.
Normal polling retains `drop_pending_updates=false` and never invokes this reset
primitive. No public CLI discard operation is exposed by this library.

Run `python3 compatibility/reset-protocol-rehearsal.py --directory NEW_DIRECTORY
--management-image CANDIDATE --native-image PINNED_CANDIDATE` to exercise journal
failure paths and the pinned adapter's normal restart behavior in network-disabled
Compose containers. This bounded rehearsal has no installation mounts, providers,
or live Telegram requests; full reset and live acceptance remain separate gates.

Run `./scripts/nocheh reset plan --output NEW_FILE` with the saved installation
root/state to create a private read-only preflight. It inventories exact container
IDs and Compose origins, current database/cache mount identities, and explicit
path dispositions. Both running and stopped foreign containers can block shared
state or volume ownership. External volume drivers, unknown paths, and symlinked
preservation targets require review. Existing restorations and external archives
need per-item ownership evidence before entering an executable reset manifest.
The preflight contains no configuration values or source content and cannot
execute deletion. Revalidate and freeze it under maintenance exclusion after the
complete isolated acceptance gates; the executor must not treat this preflight
or its configuration fingerprint as an execution authorization.

Use `scripts.reset_ownership.prepare` to create the private review artifact for
every immediate item under a restore or external archive review root. Assign each
exact device/inode identity either `erase-installation-owned` or
`preserve-unrelated`; an absent disposition, new item, replaced item, unknown file
type, changed root, or incomplete root list stops validation. Only
`scripts.reset_ownership.validate` may turn those decisions into scoped rows for
`scripts.reset_files.freeze`. The file manifest accepts reviewed items only as
direct children of the exact preflight review roots, retains unrelated siblings,
and removes a reviewed symlink as a link without following its target. Neither
preparation nor validation infers ownership or deletes data.

`integrations.hermes.preference_transfer` captures only the eight preferences
accepted by the managed native interface. Preserve global defaults and explicit
profile overrides separately, including the absence of topic overrides. Legacy
owner markers map to deterministic stable profile IDs; for an original-only
source, supply active rows from the control profile repository instead. Unknown
or ambiguous legacy names require an explicit mapping before reset. Do not infer
administrative authority from restored filesystem markers.

The coordinator must hold maintenance exclusion, snapshot the control catalog,
retain the configuration-only manifest durably, and call `verify_source` before
deletion. Recheck the catalog independently. Submit `profile_commands` through the
explicit control repository with their deterministic operation IDs, then pass the
confirmed admissions to `restore` on fresh native state. Exact partial writes are
retryable; conflicting configuration and retained native history fail before any
write. Job preferences disappear with schedules. This library neither quiesces
services nor deletes data; those operations still require the complete scoped
coordinator and isolated reset rehearsal.

Use `scripts.reset_configuration.freeze` after effect settlement to capture only
the current setup rows. Legacy storage contributes the current security policy and
explicit conversation overrides. Original-only storage contributes the current
security policy, guard mode, admitted assistant configuration, projects and
assignments, sharing rules, and active logical profile identities. The query is one
read-only statement with explicit columns and bounded rows; it does not select
originals, derivatives, learned state, approvals, schedules, workflows, released
share text, owner-command receipts, or old configuration revisions. Recheck the
same snapshot before publishing it. A changed or unknown configuration area stops
the reset. Keep this private snapshot until fresh-store admission is verified, then
retire its content-bearing copy and retain only its digest and record counts.
`compatibility/reset-configuration-rehearsal.py` verifies both real database layouts
with seeded source/derivative canaries on an internal-only network. This component
does not complete the preservation phase by itself.

The provider monitor contains both accounting and content-bearing diagnostics.
After stopping its writer, use `scripts.reset_accounting.sanitize` on the exact
owned usage database. It requires the pinned schema and native manager lock,
preserves retained accounting/configuration fingerprints and cache-accounting
hints, erases raw response/error/log content, rebuilds full-text search, and
compacts SQLite plus its WAL. The Honcho spending ledger remains separate and
untouched. A compaction interruption requires a retry before service resumption;
an unknown schema needs review before deletion. Erase old usage-import files
through the scoped manifest as well. Verify with
`python3 compatibility/reset-accounting-rehearsal.py --directory NEW_DIRECTORY
--monitor-image PINNED_MONITOR --checks-image CANDIDATE_MANAGEMENT`.
This fixture has no network, creates its own state, proves exclusion by the real
monitor lock, and restarts the pinned monitor after cleanup. It does not authorize
or execute an installation reset.

`scripts.reset_preservation.freeze` is the complete pre-erasure gate. While the
journal and PostgreSQL maintenance exclusion remain held, it requires the exact
ownership review, freezes and independently rechecks the current database setup,
matches the saved environment policy, captures and verifies native preferences,
sanitizes provider accounting, and fingerprints credentials, provider login,
Honcho setup/spending state, and every other retained path without copying their
contents. It then freezes the anchored file-erasure manifest and binds all component
hashes into an immutable, content-free receipt before advancing
`preservation_frozen`. Detailed private artifacts stay under the reset journal.
Changed policy, files, source preferences, ownership, accounting, manifest scope,
maintenance ownership or inactive fences stop the phase. A retry reuses a verified
accounting receipt; a crash before that receipt reruns the idempotent sanitizer while
requiring the reviewed database identity. Run
`python3 compatibility/reset-preservation-rehearsal.py --directory NEW_DIRECTORY
--management-image CANDIDATE` for a fresh internal-network rehearsal with real
PostgreSQL configuration queries, the real SQLite sanitizer, and synthetic retained
credentials, spending, original-file and source/derivative canaries.

Stop ingress, scheduling, execution, learning, and provider refresh ownership;
settle in-flight effects before erasing receipts. Resolve installation-owned
paths and volumes explicitly; never use global pruning or touch unrelated state.

Preserve saved setup, external credentials/provider logins, spending accounting,
code, pinned upstream checkouts, synthetic fixtures, and unrelated worktrees or
installations. Erase original content/files, derivatives/guards, learned memory,
native sessions/notes, pending approvals, schedules, workflow history, content
logs, and installation-owned old backups/exports. Reset content-bearing Honcho,
Inngest, and Redis stores. Do not create a pre-reset content backup or delete
remote Telegram history.

Create a new installation generation and discard the pre-reset Telegram backlog
once during this deliberate reset. Normal restart preserves pending updates.
Verify all content stores are empty before collecting new acceptance traffic.
Preserve allowlisted setup separately from content and pending effects. Resume
the saved chat allowlist and enabled services after required live acceptance.

</reset>

<acceptance>

- Separate roles reject wrong-domain writes; originals and file hashes remain
  exact. Guard edits and lineage survive restart, export, and inactive restore.
- Crash every cross-store handoff boundary; verify duplicate/replay recovery,
  control/Inngest/database outages, guard and access revocation races, and
  uncertain deliveries without duplicate external effects.
- Generate two engine versions from identical original bytes, guard and activate
  both, preserve owner edits, and refresh dependent learning.
- Test reaction meanings across groups, old-message replies/reactions, removals,
  anonymous counts, delayed events, unknown actors/topics, missing context,
  conflicts, corrections, and retirement with source evidence.
- Verify project membership does not grant access, sharing previews/approved
  revisions/filtered sources/revocation, and conversational rules cannot grant
  administrative or action authority.
- Use an isolated visible preview for responsive light/dark and keyboard checks
  covering learned memory, projects/sharing, source derivatives, history, and
  reprocessing. Retain all existing regression and acceptance gates.
- Repeat [fresh live release acceptance](release-acceptance.md) after the reset,
  including owner DM and a dedicated group with human messages/reactions,
  subscription voice transcription, learned recall/correction, isolation,
  intentional silence, exact approval, and restart recovery. Repeat required
  Honcho ingestion, embedding, reasoning, retrieval, and failure/restart checks
  within the existing spending cap. Missing live evidence remains pending.

The dedicated group identifier and human participation remain execution
prerequisites. Healthy services, fixtures, and historical results do not count
as fresh live evidence. Continue independent implementation while awaiting input.

</acceptance>

</execution_plan>

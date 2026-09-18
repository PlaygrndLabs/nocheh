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
guarded records, rather than silently losing them; complete and legacy bundle
routing is a separate implementation gate.

Verify source identity/wire/timestamps, exact binary and empty files, read-only
export during control unavailability, import control-outage behavior, interrupted
archive/control handoffs, missing imported bytes, duplicate imports, and explicit
learning consent. No provider credentials or live messages are required.

</source_portability_rehearsal>

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

</recovery_rehearsal>

<reset>

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

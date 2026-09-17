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

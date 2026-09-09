# Guard once and use Honcho as primary memory

Accepted plan: ADR-0033. TASK.md records actual completion and evidence.

1. **Durable projections:** immutable originals, durable per-source guarded revisions,
   resumable jobs, persisted completed chunks, import/live/derived capture. No routing
   activation before phase 3. Verify duplicate, restart, failure and byte preservation.
2. **Owner editor:** original/guarded views, derived text, file access, status and
   revision history; compare-and-save and restore as a new revision. Owner edits win.
3. **On/off enforcement:** migrate auto to on; guarded search, prompts, histories,
   notes, tools and learning. Scoped runtime access, content revision validation
   on every attempt, no repeated detector work for reused content, no raw fallback.
4. **Honcho connection:** pinned isolated Honcho through CLIProxyAPI subscription
   reasoning and dedicated capped embeddings. Prove real ingestion, retrieval,
   reasoning, restart and failure handling. Credentials are required for live gates.
5. **Primary memory:** one Nocheh writer, source/revision receipts and reconciliation;
   scoped Honcho recall plus actual Hermes native notes, optional approved history.
6. **Lifecycle:** separate raw/guarded memory generations; edits retire stale context
   and rebuild affected memory; reversible attach/detach/catch-up, backup/restore,
   degraded notices and delivery fencing.
7. **Local acceptance:** guarded archive backfill, opted-in history pilot, dashboard
   and end-to-end acceptance, final system graph and operating instructions.

Each phase: appropriate tests, AST-only Graphify refresh, status/docs, scoped commit,
report hash and proceed automatically. Keep live gates pending when credentials or
evidence are missing; continue independent work. Do not activate incomplete routing.

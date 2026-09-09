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

G4 implementation evidence: both pinned images build and isolated Compose starts.
Nine pinned-image checks cover API/worker context binding, embedding preparation,
provider failure, conservative reservations and durable pilot/monthly cutover.
The [preflight report](../compatibility/results/2026-09-09-honcho-preflight.json)
keeps every real memory/provider gate pending. Later independent code can be built,
but primary-memory attachment must remain disabled until those gates pass.

Use only `NOCHEH_EMBEDDING_API_KEY` in the root `.env` or the dedicated experiment
credential file. CLIProxyAPI owns a separate device login (`scripts/honcho-experiment
login`); Hermes/Codex OAuth stores are not copied. The model route remains subscription
only. Embeddings use text-embedding-3-small at 1536 dimensions. The published
[$0.02 per million input tokens](https://developers.openai.com/api/docs/models/text-embedding-3-small)
was checked on 2026-09-09; the meter reserves a conservative $0.01 before each bounded
request, retaining the reservation after failures. Pilot total is $5. Monthly mode
is a durable post-pilot cutover, limited to $5 per UTC calendar month.

G5: Nocheh owns the only Honcho ingestion path. Hermes loads only the Nocheh
plugin, keeps its real MEMORY.md/USER.md files and receives Honcho recall through
the scoped archive API; no native Hermes-to-Honcho writes are enabled. Each source
revision has deterministic audience/generation/chunk receipts. A lost write response
is reconciled by its receipt metadata; absence after an uncertain write stays pending
rather than guessing that a resend is safe. Import-learning consent is unchanged.

`./scripts/nocheh memory honcho status` inspects attachment and receipts. Attach
and detach are owner operations; attachment rejects until real acceptance is recorded.
The `deploy/honcho-runtime.yml` overlay binds both API and deriver attempts to their
workspace. The meter asks Nocheh to select current prepared content before reasoning
or embeddings. Retired workspaces and unbound global jobs fail closed. Hermes has
no route to the private Honcho network and no Honcho credential. Group/topic workspaces
contain their own consented sources; approved/filtered cross-space sharing continues
through the audience-checked archive tools.

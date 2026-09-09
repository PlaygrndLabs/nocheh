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

G6: edits/mode switches retire old credentials and profiles immediately. Retired
Honcho workspaces cannot make further reasoning/embedding requests. Native review
jobs rebuild compact notes from the current consented sources. Old generated archive
summaries remain owner-visible but are withheld from guarded agent retrieval unless
bound to the current generation. Unsupported global Honcho reconciliation remains
blocked; current API/deriver work is explicitly bound.

Detach preserves source data, owner edits and receipts. Attach rebuilds previously
learned sources in the current representation. `--catch-up` adds consented sources
received since the previous attachment; `--include-history` includes older approved
sources. Neither grants import-learning consent. Uncertain old writes are reconciled
before new ingestion. Missing confirmation remains pending, never a blind resend.

Archive exports include guarded history. `scripts/archive import DIRECTORY
--restore-guarded` explicitly trusts saved copies from your own export; ordinary
imports prepare fresh copies. Existing divergent histories produce a conflict.
Full backups include the new PostgreSQL tables, native state and a snapshot of the
spending ledger. Inactive restores disable Honcho and use a separate memory network;
they never replace/reset the live spending ledger. Restore the ledger conservatively
before any recovery cutover. The archived Honcho source receipts let its disposable
provider memory be rebuilt; a local edit cannot recall previously transmitted data.

G7 local acceptance on 2026-09-09: 47 JS/TS, 94 pinned Hermes and 12 pinned
Honcho checks pass without skips. The real subscription workflow captures a
synthetic original, prepares it, saves owner wording, reads that exact projection
through scoped credentials and retrieves it using the native Hermes archive tool.
The native recall took 58.394 seconds; no Telegram messages or learning consent
were generated by this rehearsal. The owner dashboard saves a new revision while
showing the unchanged original. Restart preserves that edit and consent state.

Backfill finished with 161 events and 278 derived records ready, zero pending or
failed. Initial connection failures were retried from durable progress; originals
were retained and affected guarded reads stayed unavailable. Per-source preparation
locks allow a new live source to proceed while historical backfill is running.
Fresh request fragments are batched, and saved passages are reused without detector
calls. AST refresh: 156 files, 1,116 nodes, 3,450 edges, zero model calls.

The [acceptance report](../compatibility/results/2026-09-09-guarded-memory-acceptance.json)
and [system graph](guarded-memory-system.md) record the remaining limits. Honcho
provider gates and the opted-in history pilot remain pending the dedicated key and
separate bridge login. Primary attachment and monthly cutover remain gated. No paid
requests were made. Existing Telegram/release gates still apply; no merge to main.

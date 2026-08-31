# ADR-0013: Importer Core — A Message Log With Replayable Projections

## Status

Accepted

## Context

The pipeline is a chain. A Telegram update is mapped, pattern-redacted, buffered,
flushed, turned from media into text, guarded, grounded, analysed, and persisted — and
then the buffer row is deleted. `LiveMessageBufferService` line 203 is the only `DELETE`
in the codebase, and it fires unconditionally the moment `executeWindow` returns.

That single line is the reason nothing in this system can be reprocessed. Six
consequences, all verifiable in the current code:

- **History is frozen at the model that first saw it.** Change the analyzer, the prompt,
  the contract, the guard, or the embedding model, and everything already ingested keeps
  whatever the old model produced. There is no input left to re-run.
- **Any non-guard throw leaks the window forever.** Only `SecretGuardUnavailableError` is
  caught; anything else rethrows before the delete, so those rows are re-analysed and
  re-paid on every subsequent sweep.
- **Quarantined rows are permanent.** After `SECRET_GUARD_MAX_ATTEMPTS` they are set
  aside and filtered out of every window, holding pattern-redacted chat text
  indefinitely. "No raw chat as long-term memory" already has a permanent exception, and
  it is the one place nobody looks.
- **Deletion is not transactional with analysis.** Deliberate — losing a window is worse
  — but it means a crash mid-persist leaves a half-written graph and a still-buffered
  window.
- **Concurrency control is process-local.** `flushing = new Set<string>()` means two
  Nocheh instances against one database double-analyse and double-pay.
- **No retention, TTL, or vacuum anywhere.** Nothing bounds buffer age.

The owner's requirement is explicit: import the oldest batch data if it does not exist,
or live webhook data, into the database, so that "we have pure data and can do any
process on them like changing llm, memory, workflow."

That collides with rule 1 (no raw chat as long-term memory) and rule 2 (redact before
persistence), and the collision has to be resolved rather than fudged. "Pure" cannot mean
*pre-guard*. The guard is load-bearing, not belt-and-braces: ADR-0010 records the
perception model transcribing a photographed password verbatim after being told to omit
it. A permanent pre-guard store is a permanent credential store, and it would be the most
sensitive object in the system.

## Decision

**Purity is defined as: the guarded text, complete, ordered, forever — and everything
derived from it rebuildable.** Not the bytes. Not the unmasked secrets. Everything else.

**One write path, N independent readers.** The chain becomes a log plus projections.

```text
telegram webhook ┐
history import   ├─> IMPORTER CORE ──> raw_messages (append-only, guarded, ordered)
note / mock      ┘   pattern redact          │
                     media -> text     ┌─────┼─────┬──────────────┐
                     secret guard      ▼     ▼     ▼              ▼
                     append          analyzer  embedding  (honcho)  (consolidation)
                                     projection projection projection  projection
                                        │         │
                                   graph+records vectors
                                   tasks+suggestions
```

**The importer core owns the gate.** Pattern redaction, media understanding, and the
model-backed secret guard all run *inside* the importer, before the append. Rule 2 is
unchanged in substance and strengthened in position: today the authoritative guard runs at
flush, after rows have already been written; after this it runs before the only durable
write. Nothing downstream of the log ever sees unguarded text, which is what makes adding
a projection — including an external one — safe by construction.

**`raw_messages` is append-only and ordered.** Columns, plaintext unless noted:
`owner_id`, `platform`, `conversation_id`, `message_id`, `seq` (monotonic per
conversation), `occurred_at`, `imported_at`, `author_id`, `author_display_name`,
`text` (guarded), `reply_to_message_id`, `attachments` (jsonb: kind, `file_unique_id`,
derived description and transcript — never bytes), `guard_state`, `guard_attempts`.
Unique on `(owner_id, platform, conversation_id, message_id)`, so re-importing the same
export is a no-op rather than a duplicate.

**Media becomes text at import, once.** The `file_unique_id` cache stays as the cost
control it already is, but the derived description and transcript now live on the log row,
so replaying a projection never re-pays a perception call.

**Projections carry cursors, not deletions.** A `projection_cursors` row per
`(owner_id, projection, conversation_id)` records the last consumed `seq`. The batch
window stops being a queue that drains and becomes a *view over the unconsumed range*.
Nothing is deleted to signal progress.

**Replay is a first-class operation.** `POST /api/replay` takes a projection, an optional
conversation, and an optional range, and rewinds that cursor. Changing the analyzer,
the prompt, the embedding model or the guard is then a replay, not a migration. It is a
deliberate, paid button — the same reasoning ADR-0011 applied to `POST /api/memory/reindex`
— and it returns 409 when the projection's provider is unconfigured.

**Projections must be idempotent.** Node, edge and task ids stay deterministic so a
second pass over the same range converges instead of duplicating. Replaying the analyzer
over an identical range twice must produce an identical graph; this is a test, not a hope.

**History import writes in strict chronological order.** Export entries are sorted by
timestamp before append, and `seq` is assigned on insert. Any future consumer that infers
order from insertion — Honcho's deriver does exactly this, ordering by `Message.id` rather
than `created_at` — then receives history in the order it actually happened.

**Quarantine becomes a state, not a stuck row.** `guard_state` on the log row is
`guarded`, `quarantined`, or `pending`. Quarantined rows are visible, countable, and
retryable from the dashboard instead of invisible in a buffer.

**Concurrency moves to the database.** A Postgres advisory lock per
`(owner_id, conversation_id)` replaces the in-memory `flushing` set, so a second instance
is safe rather than expensive.

## Consequences

- Rule 1 in `AGENTS.md` is amended when this lands: guarded chat *is* long-term memory,
  and "structured records with source reference, confidence and timestamp" describes the
  projections, not the log. Media bytes remain never persisted.
- The 189–240s analysis stops being on any critical path by construction, not by
  configuration. `MESSAGE_ANALYSIS_MODE=immediate` becomes a projection run against a
  range, and the webhook's only job is append.
- Storage grows without bound. That is the point, and it is text: a year of heavy Telegram
  traffic is tens of megabytes. Retention, if ever wanted, becomes a policy over the log
  rather than an accident of the flush.
- A deletion request is answerable for the first time: tombstone the log row, replay the
  affected projections.
- `LiveMessageBufferService`, `HistoryImportService` and the flush sweep are all rewritten.
  `live_message_buffer` is replaced by `raw_messages` + cursors, so the SQLite buffer
  repository and its tests go away.
- Replaying costs real money, and a careless full replay costs a lot of it. The API takes
  a bounded range, reports an estimated call count before running, and every replay writes
  an audit record.

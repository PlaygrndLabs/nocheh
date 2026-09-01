# Tasks

Open work only. Delivered work lives in the code and in `docs/adr/`.

The refactor to MVP is phased below. Decisions behind it: ADR-0013 (importer core),
ADR-0014 (Postgres, plaintext, `owner_id`), ADR-0015 (the constraints Honcho must satisfy),
ADR-0016 (answer path and amended rule 3), and ADR-0017 (choose the memory backend from an
early bake-off, not from assumption).

## How These Phases Are Sequenced

**One phase at a time, each shipping alone on `main`, each with `npm test` and
`npm run test:web` green.** The provider swap, storage swap, pipeline inversion and selected
memory implementation can each break the system independently; combining them would make a
failure unattributable.

Phase order is not preference. Phase 0 freezes the corpus, rubric and cost ceiling before
results can move them. Phase 1 changes the provider numbers, reruns Nocheh fairly, and closes
the memory decision with a new ADR. **Phase 2 does not start without that ADR.** Phase 2 is
the only cheap moment to add `owner_id`; Phase 3 needs its schema; Phase 4 implements only
the selected memory branch. Phase 5 is the MVP. It can precede Phase 3 only when the selected
memory backend can consume the existing post-guard path without weakening the gate.

Rules in `AGENTS.md` that change, and when: rule 1 in Phase 3 (guarded chat becomes
long-term memory, bytes still never persisted), rule 3 in Phase 5 (bounded autonomous
sending), the encryption line in the Memory Policy in Phase 2. Rules 2, 4, 5, 6, 7 and 8 are
untouched — in particular the guard still runs before anything, it just runs earlier.

---

## Phase 0: Prove The Memory Choice — 3–5 days, evaluation only

ADR-0017. The current Nocheh memory and Honcho are both unproven on the owner's long-term,
mixed Persian/English Telegram corpus. This phase creates evidence before production work
deepens either bet. Evaluation code may be temporary; private corpus content and personal
answer keys are never committed.

- [ ] Write the benchmark manifest **before running either system**: exact versions, model
      ids, configuration, context budget, quality margin, maximum acceptable monthly cost,
      one salted aggregate corpus hash, network destinations and numeric pass thresholds.
- [ ] Build a private chronological quality corpus, targeting at least 1,000 guarded messages
      across at least three months when the export contains that much. No pre-guard text and
      no media bytes may enter either system.
- [ ] Write 60–100 owner-graded questions: factual recall, Persian, corrections over time,
      contradictions, multi-hop links, tasks/deadlines, preferences and long-range coaching
      patterns. Keep retrieval grading separate from answer-model grading.
- [ ] Build a deterministic non-personal scale fixture at 1k, 10k and 100k messages with
      seeded facts, corrections, duplicates and known answers.
- [ ] Run 20–30 live Nocheh windows. Confirm nodes, edges, suggestions and tasks land; inspect
      `errorLogs`, grounding duplication, `reasoningTokens`, throughput and `context_build`.
- [ ] Run the quality corpus through the current Nocheh stack and a pinned self-hosted Honcho
      stack in strict chronological order. Record the Honcho server version, model setup and
      every enabled background job.
- [ ] Compare both retrieval outputs under the same token budget and answer model. Report a
      separate native Honcho context/chat run rather than mixing its answer model into the
      retrieval score.
- [ ] Measure source-valid recall, answer accuracy, stale facts, duplicates, contradictions,
      Persian, multi-hop and coaching quality; p50/p95/max context tokens and retrieval
      latency; queue lag; ingest/query/maintenance calls, tokens and cost; database/index
      growth; replay, deletion/export, backup/restore and provider/worker failure recovery.
- [ ] Derive 10k/100k reasoning cost from measured representative batches and exact call/token
      counts. Do not pay to send 100k private messages through a model merely to estimate it.
- [ ] Produce a provisional three-column result: owned Nocheh, Honcho-primary, hybrid. Do not
      write a production Honcho adapter and do not delete the graph during the spike.

**Done when:** the frozen manifest, aggregate result table and raw measurement method are
recorded without private content. Phase 1 owes the final OpenAI-backed Nocheh rerun and the
decision ADR. **If the graph is empty, the contract is widely violated, or either system
crosses the secret gate, stop; later refactors cannot make that result trustworthy.**

---

## Phase 1: One Provider For All Five Roles — 1–2 days

There is no `openai` provider in the catalog: `nvidia`, `anthropic`, `gemini` only. Adding
one plausibly closes three open questions at once — the 13–17 tokens/second throughput
problem, the unverified NVIDIA embedding wire format, and whether the endpoint supports tool
calling. It is a day of work that changes every later estimate, which is why it is first.

- [ ] Add `openai` to `ai-provider-catalog.ts` for all five roles: `text_analysis`,
      `image_understanding`, `audio_understanding`, `secret_guard`, `embedding`.
- [ ] Adapters: chat completions with `response_format: json_schema` generated from the same
      `as const` vocabularies the prompt renders, vision, transcription, embeddings.
- [ ] Re-run Phase 0's complete Nocheh quality and cost pack against OpenAI. Compare recall,
      grounded answers, latency, throughput, warning count and dropped-item count directly;
      do not rerun Honcho unless its pinned configuration changed.
- [ ] Decide whether `response_format: json_schema` replaces prompt-only vocabulary
      enforcement. Prompt-only works in tests; a schema makes it structural.
- [ ] Re-grade the guard. `nvidia/nvidia-nemotron-nano-9b-v2` caught every planted secret
      with no false positives; `nvidia/nemotron-3-nano-30b-a3b` returned `{"segments":[]}`
      and must not be used. Whatever fills the role must pass the same planted-secret set.
- [ ] Decide whether the perception model should return a confidence-weighted summary rather
      than near-verbatim OCR, given it reproduces credentials it was told to omit.
- [ ] Apply ADR-0017's frozen gates to the final result and write the follow-up ADR selecting
      exactly one production branch: owned memory, Honcho-primary semantic memory, or hybrid.
      State which graph responsibilities remain and which are retired; do not leave two
      implicit sources of truth.

**Done when:** a role-by-role table of latency, throughput and cost for both providers is in
this file, `FLUSH_SWEEP_INTERVAL_SECONDS` is set deliberately from measured analysis latency,
and the memory-selection ADR is accepted. **Phase 2 is blocked until all three exist.**

---

## Phase 2: Postgres Foundation — 4–6 days, no behaviour change

ADR-0014. Same behaviour, different engine, plaintext payloads, indexed reads, `owner_id`.
Nothing user-visible changes; this phase is judged entirely by tests staying green and by
one performance number moving.

- [ ] Forward-only numbered SQL migrations, one applied-migrations table. Delete the four
      `CREATE TABLE IF NOT EXISTS` bootstrap functions.
- [ ] Postgres adapters for all 13 repositories. Port signatures already return `Promise`
      and do not change; every body becomes `await`.
- [ ] Payloads become plaintext `jsonb`. Keep AES-GCM for `app_config` secret values only.
      Delete the `"local-development-secret-change-me"` fallback — unset means fail closed.
      Replace the hardcoded scrypt salt with a per-install random salt.
- [ ] Promote every JavaScript-side filter to an indexed column: `source_message_id`,
      `conversation_id`, `occurred_at`, `owner_id`, `kind`, `relation`, `status`,
      `confidence`, `project_id`, `due_at`.
- [ ] `owner_id` on every table, in every primary key, leading every index, and on
      `SourceReference`. One value, no auth changes, no UI changes.
- [ ] Kill the three silent-failure hazards: hardcoded `person:mak` under
      `ON CONFLICT DO UPDATE`, the process-local `flushing` set (becomes a Postgres advisory
      lock), and the process-global vector cache.
- [ ] Fix the four known Postgres traps: `AS "conversationId"` quoting, `row.encrypted === 1`,
      the synchronous `database.transaction()` callbacks, and `@named` → `$n` parameters.
- [ ] Wrap graph persistence in a real transaction. Today a window can be half-persisted and
      the code compensates with per-item try/catch.
- [ ] One-shot offline migration script: read SQLite, decrypt with the existing key, write
      plaintext `jsonb`, verify row counts and a payload sample. Delete the script afterwards.
- [ ] `pg_dump` on a schedule to an encrypted destination, **and a restore rehearsal recorded
      in `docs/deploy.md`**. An unrehearsed backup is not a backup.
- [ ] Remove `better-sqlite3`.

**Done when:** all tests green against Postgres, and a test asserts that building grounding
for one window performs a bounded number of queries rather than ~17 full graph scans.

---

## Phase 3: Importer Core — 4–6 days

ADR-0013. The chain becomes a log plus projections. This is the phase that makes changing
the model, the memory, or the workflow a replay instead of a rewrite.

- [ ] `raw_messages`: append-only, guarded, `seq` monotonic per conversation, unique on
      `(owner_id, platform, conversation_id, message_id)`, `attachments` holding
      `file_unique_id` plus derived description and transcript, `guard_state` on the row.
      Bytes are never persisted.
- [ ] `ImportMessageUseCase` owns the gate: pattern redaction → media understanding →
      secret guard → append. Nothing downstream of the log ever sees unguarded text.
- [ ] `projection_cursors` per `(owner_id, projection, conversation_id)`.
- [ ] Rewrite the analyzer path as a projection over an unconsumed range. The batch window
      becomes a view over the log, not a queue that drains by deletion.
- [ ] Rewrite the embedding indexer as a projection.
- [ ] Rewrite `HistoryImportService` to append in strict chronological order, idempotent on
      re-import of the same export.
- [ ] `POST /api/replay`: projection, optional conversation, optional range. Reports an
      estimated call count before running, writes an audit record, returns 409 when the
      projection's provider is unconfigured.
- [ ] Prove idempotency: replay the analyzer over the same range twice, assert an identical
      graph.
- [ ] Retire `live_message_buffer` and its repository. Quarantine becomes `guard_state`.
- [ ] Amend rule 1 in `AGENTS.md`.

**Done when:** 200 imported messages can be replayed through the analyzer twice with
identical output, no `DELETE` remains on the ingestion path, and a quarantined message is
visible and retryable rather than stuck.

---

## Phase 4: Implement The Selected Memory Backend — 2–5 days

ADR-0017 and the Phase 1 decision ADR choose this implementation. Do **not** implement all
branches. Every branch has the same invariant: corpus growth may increase storage and index
work, but it must not increase prompt context beyond the configured budget.

Common work:

- [ ] Define the selected memory read/write ports in `src/application` before its adapter.
      Keep provider types and Honcho SDK types out of the domain.
- [ ] Give recent messages, typed facts/rules and optional narrative memory explicit context
      sub-budgets. Trim within sections; never let a large memory section cut off the current
      question by slicing one concatenated string.
- [ ] Apply Persian normalisation consistently at ingest and query time: ZWNJ, Arabic versus
      Persian ye and kaf, digit forms and diacritics.
- [ ] Emit retrieval latency, returned-source count, context tokens, queue lag where relevant,
      provider calls/tokens and estimated cost through the existing metrics and audit ports.
- [ ] Preserve source ids in the answer context. Narrative conclusions may be labelled as
      advisory, but they may not masquerade as stored `MemoryRecord`s.

Only the selected branch:

- [ ] **Owned:** vectors into pgvector with model id and dimension; measure the cosine
      distribution before setting `DEFAULT_SIMILARITY_FLOOR` and `DEFAULT_LEXICAL_WEIGHT`;
      make `POST /api/memory/reindex` a replay of the embedding projection.
- [ ] **Honcho-primary:** add `PeerRepresentationPort` and a pinned self-hosted adapter;
      map owner/person to peers and `conversation_id` to sessions; `observe` consumes only
      guarded log rows and `recall` returns labelled conclusions plus every available remote
      source/conclusion id. Add timeouts, queue-health metrics and a no-op fallback.
- [ ] **Hybrid:** implement both adapters with fixed separate budgets. Typed Nocheh state wins
      factual conflicts; Honcho remains advisory; surface disagreement instead of silently
      choosing or writing Honcho conclusions into the graph.

**Done when:** the selected branch passes Phase 0's Persian, temporal, contradiction and
source-valid recall gates; p95 retrieval and maximum context stay inside the frozen limits at
the 1k and 10k fixture sizes; and measured/projected cost stays inside the owner's ceiling.

---

## Phase 5: The Answer Path — 5–8 days. This is the MVP.

ADR-0016. Nothing answers today: no `sendMessage`, `AssistantAiPort` unimplemented,
`AssistantReplyMode` branched on by nothing, no reply field in any contract, no scheduler.
This phase depends on the Phase 1 memory decision and Phase 2. It may ship before Phase 3
only if the selected backend can consume the existing post-guard path without bypassing the
secret gate or creating an unreplayable second source of truth.

- [ ] `AnswerQuestionUseCase`: grounding under a token budget → its own small reply contract
      → answer text, source ids, confidence, explicit "I don't know". Never writes memory.
- [ ] Answers cite the local record/node ids and any remote conclusion/source ids they were
      built from. Advisory narrative context is visibly distinguished from typed fact.
- [ ] `TelegramClientPort.sendMessage`.
- [ ] `OutboundDeliveryService` as the single egress. Every send writes an audit record with
      what, to whom, why, which policy allowed it, and whether a human approved it.
- [ ] Wire `AssistantReplyMode`: `silent`, `mention`, `active`, `digest`.
- [ ] Autonomy policy in the domain, not the prompt: risk ceiling, no first contact, content
      exclusions (money, credentials, commitments), daily cap falling back to `pending`, kill
      switch that needs no model or network, visible "sent by Nocheh" attribution, mandatory
      dry-run period before autonomy can be enabled at all.
- [ ] Delete `AssistantAiPort`.
- [ ] Amend rule 3 in `AGENTS.md`.

**Done when:** a question asked in Telegram returns a grounded, sourced answer at a measured
p50 under 5 seconds; every send is in `/api/audit`; and the kill switch is verified to stop
egress with the model provider unreachable.

---

## Phase 6: Scheduler And Briefings — 2–3 days

- [ ] Generalise the flush sweep into a job scheduler. Jobs carry a prompt, a query or
      projection, a delivery target, and a cadence — first-class agent tasks, not shell tasks.
- [ ] Daily brief and weekly review as the first two jobs, delivered through the Phase 5
      egress and subject to the same policy.
- [ ] Surface job history and next run in the dashboard.

**Done when:** a brief arrives on schedule, is auditable, and is stoppable by the kill switch.

---

## Phase 7: Close The Loop In The UI — 2–3 days

- [ ] Approve / edit / reject / archive controls. `/api/brain/suggestions/*` and the domain
      lifecycle already exist; nothing calls them from the UI.
- [ ] Surface quarantined messages, with retry.
- [ ] Surface projection cursors, replay controls, and lag per projection.
- [ ] Surface `summaryEveryMessages` and `summaryEveryMinutes` in Settings — persisted and
      used, but not editable.
- [ ] Autonomy settings, the dry-run review queue, and the kill switch.
- [ ] Make brain routes return the same `{ ok: true, ... }` envelope as the rest of the API.

---

## Phase 8: Maintain The Selected Memory — 3–5 days

The long-term side effects depend on the Phase 1 choice. Maintenance is incremental,
budgeted and observable; no backend receives permission to rescan an unbounded corpus on a
schedule without a cursor, candidate selector and cost ceiling.

- [ ] **Owned:** scheduled projection over affected graph neighborhoods for contradiction
      detection, duplicate merging, supersession **with history preserved** and confidence
      decay. Do not full-scan the graph on every run.
- [ ] **Honcho-primary:** monitor derivation/dream queue age, last successful maintenance,
      duplicate/stale conclusion rate, provider failures and per-run tokens/cost. Verify
      export, deletion and rebuild procedures against the pinned version.
- [ ] **Hybrid:** run the owned typed-fact maintenance and Honcho health checks; detect and
      surface cross-backend contradictions with the typed graph taking factual precedence.
- [ ] Every local consolidation is audited and reversible. Any irreversible remote mutation
      is rejected or preceded by an auditable snapshot/reference that permits rebuild from
      the guarded log.
- [ ] Enforce daily and per-run model-call/token ceilings. Exceeding a ceiling pauses
      maintenance and raises visible lag; it never silently starts a second run.
- [ ] Surface contradictions, stale memory, projection/worker lag and last successful run in
      the dashboard rather than resolving or hiding them silently.

**Done when:** a maintenance run changes only its selected candidates, a repeated run is
idempotent, failure leaves replayable state, and the monthly maintenance projection remains
inside the Phase 0 cost ceiling.

---

## Phase 9: Long-Horizon Proof — 2–3 days

Phase 0 selected an architecture using prototypes. This phase tests the production
implementation before it is called durable.

- [ ] Replay the full available guarded history and the deterministic 1k/10k fixtures through
      every selected projection. Load the 100k fixture through storage/index/retrieval and
      measure representative projection batches instead of paying to reason over all 100k.
      Do not send private fixtures to a hosted service.
- [ ] Re-run the frozen Phase 0 question set and report quality deltas, not only the final
      score. Investigate every stale correction, invalid source and new duplicate.
- [ ] Assert that maximum prompt context is unchanged across corpus sizes and that p95
      retrieval, queue lag, database/index size and projected monthly ingest/query/
      maintenance cost remain inside the frozen gates.
- [ ] Rehearse a model/embedding change, bounded replay, tombstone/delete, backup restore and
      optional-memory outage. Verify no input is lost and no unsafe outbound send occurs.
- [ ] Write the operating limits and failure runbook into `docs/deploy.md`: capacity,
      expected lag, cost alarms, replay estimate, backup/restore and rollback procedure.

**Done when:** the production memory passes the same predeclared gates that selected it,
restore/replay has been demonstrated, and the owner has one measured monthly cost rather
than an extrapolation from constants.

---

## Later

- [ ] Document understanding (PDF, docx). Documents are recorded today but never sent to a
      model. Borrow Hermes's extraction-before-model shape.
- [ ] Media in Telegram Desktop history imports. Export entries reference local file paths,
      not `file_id`s, so the Bot API cannot fetch them.
- [ ] A second input channel (email or calendar). The importer core makes this an adapter
      plus a source id rather than a pipeline change.
- [ ] Activate multi-user: auth, a real user store, per-owner provider credentials, per-owner
      allow-lists. The `owner_id` column from Phase 2 is the prerequisite, not the feature.

## Verify

```bash
npm test
npm run test:web
npm run graphify:update
```

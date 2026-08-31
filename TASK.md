# Tasks

Open work only. Delivered work lives in the code and in `docs/adr/`.

The refactor to MVP is phased below. Decisions behind it: ADR-0013 (importer core),
ADR-0014 (Postgres, plaintext, `owner_id`), ADR-0015 (no Honcho), ADR-0016 (answer path
and amended rule 3).

## How These Phases Are Sequenced

**One phase at a time, each shipping alone on `main`, each with `npm test` and
`npm run test:web` green.** Three of these phases are independently capable of breaking
everything — the model swap, the storage swap, and the pipeline inversion — and doing any
two at once makes a failure unattributable.

Phase order is not preference. Phase 1 changes the numbers every later estimate depends on.
Phase 2 is the only cheap moment to add `owner_id`. Phase 3 needs Phase 2's schema. Phase 5
is the MVP and needs nothing from Phase 3, so if time runs out, ship Phase 5 and stop.

Rules in `AGENTS.md` that change, and when: rule 1 in Phase 3 (guarded chat becomes
long-term memory, bytes still never persisted), rule 3 in Phase 5 (bounded autonomous
sending), the encryption line in the Memory Policy in Phase 2. Rules 2, 4, 5, 6, 7 and 8 are
untouched — in particular the guard still runs before anything, it just runs earlier.

---

## Phase 0: Measure What Exists — one afternoon, no code

Everything below is estimated from numbers that do not exist yet: zero live graph runs, one
latency data point, two constants documented as guesses. This is the cheapest information in
the project.

- [ ] Run 20–30 real windows. Confirm nodes, edges, suggestions and tasks land in SQLite.
- [ ] Read `errorLogs` on those runs. Anything dropped is a prompt gap or a vocabulary gap,
      and the reason string says which.
- [ ] Read `reasoningTokens` and `outputTokensPerSecond`. A large reasoning count means the
      model is the cost; a small one with the same wall time means the endpoint is.
- [ ] Read `context_build`: `memoryCount` of 0 against a populated corpus means the floor is
      too high; `approxTokens` near `tokenBudget` means grounding is crowding out the window.
- [ ] Grade whether grounding prevents duplicates — whether the model obeys "never extract
      from `groundingContext`" is still unobserved.
- [ ] Project a monthly cost from `/api/metrics` token totals at real message volume.

**Done when:** the four numbers above are written into this file, and Phase 1's before/after
comparison has a baseline. **If the graph turns out to be empty or the contract is widely
violated, the analyzer rewrite moves ahead of Phase 2.**

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
- [ ] Re-run Phase 0's measurements against OpenAI. Compare latency, throughput, warning
      count, and dropped-item count directly.
- [ ] Decide whether `response_format: json_schema` replaces prompt-only vocabulary
      enforcement. Prompt-only works in tests; a schema makes it structural.
- [ ] Re-grade the guard. `nvidia/nvidia-nemotron-nano-9b-v2` caught every planted secret
      with no false positives; `nvidia/nemotron-3-nano-30b-a3b` returned `{"segments":[]}`
      and must not be used. Whatever fills the role must pass the same planted-secret set.
- [ ] Decide whether the perception model should return a confidence-weighted summary rather
      than near-verbatim OCR, given it reproduces credentials it was told to omit.

**Done when:** a role-by-role table of latency, throughput and cost for both providers is in
this file, and `FLUSH_SWEEP_INTERVAL_SECONDS` is set deliberately from the measured analysis
latency rather than left at its default.

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

## Phase 4: Recall On pgvector, And Persian That Tokenises — 2–3 days

ADR-0015 puts the retrieval bet on owned rows. `lexical-score.ts` splits on
`/[^a-z0-9]+/`, so Persian tokenises to nothing and 25% of the blended score is structurally
zero for a multilingual owner. Both scoring constants are still guesses.

- [ ] Vectors into pgvector, plaintext, with model id and dimension per row. Dimension is
      not pinned by the schema — re-embedding is a replay.
- [ ] Persian normalisation before both embedding and lexical scoring: ZWNJ, Arabic versus
      Persian ye and kaf, digit forms, diacritics. Applied identically at index and query
      time or the two will never match.
- [ ] Measure the real cosine distribution over the corpus and set `DEFAULT_SIMILARITY_FLOOR`
      (currently 0.3) and `DEFAULT_LEXICAL_WEIGHT` (currently 0.25) from data.
- [ ] `POST /api/memory/reindex` becomes a replay of the embedding projection.
- [ ] Assert a non-zero lexical score for a Farsi query against Farsi content.

**Done when:** both constants are justified by a measured distribution written into this
file, and a Farsi recall test passes that fails today.

---

## Phase 5: The Answer Path — 5–8 days. This is the MVP.

ADR-0016. Nothing answers today: no `sendMessage`, `AssistantAiPort` unimplemented,
`AssistantReplyMode` branched on by nothing, no reply field in any contract, no scheduler.
This phase depends on Phase 1 and Phase 2 only, and can ship before Phase 3 if needed.

- [ ] `AnswerQuestionUseCase`: grounding under a token budget → its own small reply contract
      → answer text, source ids, confidence, explicit "I don't know". Never writes memory.
- [ ] Answers cite the record and node ids they were built from.
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

## Phase 8: Consolidation Sweep — 3–5 days

ADR-0015 accepted this as owned work. Without it the graph accretes: `superseded` exists as
a status and is only ever set when a model happens to emit a status update for a window.
Nothing sweeps for contradictions, redundancy, or staleness.

- [ ] Scheduled projection over the graph: contradiction detection, duplicate merging,
      supersession **with history preserved**, confidence decay.
- [ ] Every consolidation writes an audit record and is reversible.
- [ ] Surface contradictions in the dashboard rather than resolving them silently.

---

## Phase 9: The Honcho Spike — 2 days, conditional

Only if Phase 4 shows recall is still poor after tuning, or coaching visibly needs inference
across months rather than extraction within a window. Gated by ADR-0015's named test.

- [ ] Scratch self-hosted instance. Import ~300 real Farsi messages from the log in
      chronological order.
- [ ] Read `POST /conclusions/list` and `POST /conclusions/query` directly and answer three
      questions: are conclusions in Farsi or silently translated, are they self-contained,
      does a Farsi query retrieve them.
- [ ] Verify the endpoint supports OpenAI tool calling — the Dreamer and Dialectic require
      it, and without the Dreamer only flat `explicit` extraction remains.
- [ ] If all pass: `PeerRepresentationPort` returning strings, wired as one projection
      (`observe`) plus one grounding section (`recall`). The graph stays the record of fact;
      conclusions are advisory. If any fails: delete the spike, ADR-0015 stands.

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

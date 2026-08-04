# Tasks

Open work only. Delivered work lives in the code and in `docs/adr/`.

## Now: Confirm The Graph Populates Against A Live Model

The analysis contract is now generated from the domain vocabularies, so the prompt
names every node kind, relation, scope, payload kind and suggestion kind, and the
mapping layer refuses anything outside them instead of casting it through. Drop
reasons reach the audit record's `errorLogs`, and a dangling edge is discarded before
SQLite's foreign key can abort the window. Covered by
`test/memory-graph-analysis-mapping.test.ts`; not yet observed against a real model.

- [ ] Run a real window and confirm nodes, edges and suggestions land in SQLite.
- [ ] Read `errorLogs` on that run: anything still dropped is either a prompt gap or a
      vocabulary gap, and the reason string says which.
- [ ] Decide whether to also send the vocabularies as NVIDIA `response_format:
      json_schema`, generated from the same arrays. Prompt-only is working in tests;
      a schema would make it structural.

## Now: Decide Where Analysis Runs

Measured: a two-message window takes 189-240s against `z-ai/glm-5.2`. In batch mode
the flush runs inside the Telegram webhook request, so Telegram's own timeout fires
and it retries while the first flush is still running. Nothing is lost or duplicated
in storage (the buffer upserts on `(conversation_id, message_id)`) but the analysis
call can be paid for twice.

- [ ] Move the flush off the request path: ack Telegram, let
      `FLUSH_SWEEP_INTERVAL_SECONDS` drive analysis. The sweep already exists.
- [ ] Decide whether a faster text model is worth the quality trade for noisy groups
      (`docs/research/0003-model-selection-cost-reasoning.md`).

## Next: Prove Quality And Cost

- [ ] Run real conversations through the pipeline and grade extraction
      quality: memories, graph nodes, edges, suggestions, safety refusals.
- [ ] Record token cost per analysis window and project a monthly cost from real
      message volume. One measured window: 2198 perception + ~950 guard + 3194
      analysis tokens.
- [ ] Grade guard recall and precision on a larger set. So far
      `nvidia/nvidia-nemotron-nano-9b-v2` caught every planted secret with no false
      positives, while `nvidia/nemotron-3-nano-30b-a3b` returned `{"segments":[]}`
      for the same input and must not be used.
- [ ] Decide whether the perception model should be asked for a confidence-weighted
      summary rather than near-verbatim OCR, given it reproduces credentials it was
      told to omit.

## Next: Close The Loop

- [ ] Wire approve / edit / reject / archive controls into the dashboard. The API
      (`/api/brain/suggestions/*`) and domain lifecycle already exist; nothing
      calls them from the UI.
- [ ] Surface quarantined buffer messages in the dashboard. Guard failures set
      them aside after `SECRET_GUARD_MAX_ATTEMPTS`, but only a log says so.
- [ ] Surface `summaryEveryMessages` and `summaryEveryMinutes` in **Settings**
      (persisted and used, but not editable).
- [ ] Make brain routes return the same `{ ok: true, ... }` envelope as the rest
      of the API.

## Later

- [ ] Embedding-backed retrieval to replace lexical scoring in
      `SemanticMemoryRetrievalService`.
- [ ] Document understanding (PDF, docx). Documents are recorded today but never
      sent to a model.
- [ ] Media in Telegram Desktop history imports. Export entries reference local
      file paths, not `file_id`s, so the Bot API cannot fetch them.
- [ ] Approved outbound replies (draft -> owner approves -> send). Nocheh sends
      nothing today.
- [ ] A second input channel (email or calendar) once multi-group Telegram memory
      proves useful.

## Verify

```bash
npm test
npm run test:web
npm run graphify:update
```

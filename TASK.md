# Tasks

Open work only. Delivered work lives in the code and in `docs/adr/`.

## Now: Prove Quality And Cost

- [ ] Run real conversations through the pipeline and grade extraction
      quality: memories, graph nodes, edges, suggestions, safety refusals.
- [ ] Record token cost per analysis window and project a monthly cost from real
      message volume.
- [ ] Decide whether noisy groups need a cheaper extraction tier
      (`docs/research/0003-model-selection-cost-reasoning.md`).
- [ ] Confirm JSON reliability in practice; drop `NVIDIA_JSON_RESPONSE_FORMAT` if
      it turns out to be unnecessary.

## Next: Close The Loop

- [ ] Wire approve / edit / reject / archive controls into the dashboard. The API
      (`/api/brain/suggestions/*`) and domain lifecycle already exist; nothing
      calls them from the UI.
- [ ] Surface `summaryEveryMessages` and `summaryEveryMinutes` in **Settings**
      (persisted and used, but not editable).
- [ ] Make brain routes return the same `{ ok: true, ... }` envelope as the rest
      of the API.

## Later

- [ ] Embedding-backed retrieval to replace lexical scoring in
      `SemanticMemoryRetrievalService`.
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

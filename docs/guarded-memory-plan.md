# Guarded projections and Honcho execution

[SPECS.md](../SPECS.md) defines guarded data and memory behavior. [TASK.md](../TASK.md)
records implementation and activation. ADR-0033 supplies the accepted sequence;
ADRs 0034–0035 define dedicated embeddings and shared subscription reasoning.
Follow [AGENTS.md](../AGENTS.md) for verified increments and Git integration.

## Phases and acceptance

| Phase | Work and acceptance procedure |
| --- | --- |
| G1 — Durable projections | Verify immutable originals, per-source revisions, persisted completed chunks, resumable live/import/derived preparation, duplicate/concurrent capture, restart, and detector-failure recovery. |
| G2 — Owner editor | Verify original/guarded views, files, preparation status, compare-and-save conflicts/races, history, and restoration as a new revision. Confirm saved owner wording wins. |
| G3 — On/off enforcement | Convert legacy auto configuration to on; exercise guarded search, prompts, history, notes, tools, and learning. Check every attempt for current audience/revision and prove stored content reuse avoids repeated detection. |
| G4 — Live Honcho connection | Build pinned isolated images; complete live shared reasoning, dedicated embedding canary, ingestion, retrieval, restart, provider failure, and durable budget checks before attachment. |
| G5 — Primary memory | Exercise the sole Nocheh writer, audience/generation/source receipts, lost-response reconciliation, scoped recall, real native notes, and optional explicitly consented history. |
| G6 — Lifecycle and recovery | Test edits/mode changes, stale-generation rejection, attach/detach/catch-up, guarded export/restore conflicts, inactive recovery, conservative ledger preservation, and delivery fencing. |
| G7 — Local acceptance | Verify guarded backfill, exact owner-edit recall, dashboard editing, restart, real scoped Honcho use, and the opted-in history pilot. Record activation and monthly budget cutover separately. |

## Evidence and remaining work

- [G4 preflight](../compatibility/results/2026-09-09-honcho-preflight.json): pinned infrastructure and boundary checks; not live connection acceptance.
- [G7 guarded acceptance](../compatibility/results/2026-09-09-guarded-memory-acceptance.json) and [live saved-copy recall](../compatibility/results/2026-09-09-guarded-copies.json): owner edits, exact retrieval, and restart passed. The historical backfill recorded 161 events plus 278 derived records ready, zero pending/failed.
- [Dedicated embedding attempt](../compatibility/results/2026-09-09-openai-embeddings.json): HTTP 429 with a retained reservation. Configuration is supplied; provider capacity and live memory gates remain pending, rather than being reported as absent configuration or passed acceptance.
- [Operating instructions and system graph](guarded-memory-system.md): actual commands, embedding model configuration, receipt reconciliation, and the accepted target flow. [Shared-provider cutover](shared-provider-plan.md) is separate from Honcho attachment.

Honcho attachment, opted-in history acceptance, and monthly cutover remain gated.
Existing Telegram release checks are also pending. These gates do not prohibit
verified Git integration into main.

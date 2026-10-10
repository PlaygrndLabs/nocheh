<execution_plan>

# Stage timing, storage growth and Inngest orchestration review

<authority>

Plan only, from the owner's 2026-10-09 review. Requirements live in
[SPECS.md](../SPECS.md) (Monitoring, Workflow orchestration, Foundation) and
status in [TASK.md](../TASK.md). Code references are from `main` at `c1e274f`.

</authority>

<stage_timing>

Goal: break a message-to-reply into stages, with internal workflow time,
third-party service time and LLM time measured separately.

| Stage | Measured today | Gap |
| --- | --- | --- |
| Telegram poll and capture | `network_ms`, `capture_ms` in memory (`services/hermes/capture.py:221`) | Not persisted per event |
| Capture to workflow request, outbox publish | Timestamps only | Derivable, not reported |
| Inngest queue, waits, steps | Inngest history only | No Nocheh record per event |
| Transcription | None | Missing |
| Hermes turn phases | `services/hermes/timing.py` phases | Dropped: `storeResult` keeps only state and error (`src/stores/telegram-dispatch.ts:92`) |
| LLM via security broker | Provider header/read vs local time (`src/security/timing.ts`) | Already event-bound |
| Honcho and embeddings | `duration_ms` in the meter SQLite (`services/honcho/meter.py`) | Not bound to the event |
| Telegram send | None | Missing |

The detailed design is in the [stage timing plan](stage-timing-plan.md). Next steps: persist Hermes phase timings with the dispatch result; bind Honcho
and transcription calls to the source event; record send duration; expose one
per-event stage breakdown in the admin CLI and Monitoring, using Inngest step
timing for workflow execution.

</stage_timing>

<storage_growth>

The legacy disk failure came from uncontrolled database growth. Owned original
source data is excluded; it is retained by design.

| Risk | Component | Evidence |
| --- | --- | --- |
| High | Guard-epoch fan-out re-requests work for every source and creates Honcho workspaces never deleted | `src/stores/workflow-operations.ts:76-84`, `src/stores/native-memory.ts:122` |
| Resolved | 120-second Honcho `context:` workflow never ended; each wait was Inngest history. It now runs once per rebuild ([ADR-0114](adr/0114-event-driven-honcho-context.md)) | `src/stores/workflow-operations.ts` |
| High | Inngest telemetry retention covers only spans, history and traces; it is 14 days by default per [ADR-0110](adr/0110-default-workflow-history-retention.md) | `docker-compose.yml:454` |
| High | Honcho PostgreSQL and Redis have no cleanup | `docker-compose.yml` Honcho services |
| Medium | Control tables never pruned: workflow registry, outbox, runs, receipts, ingestion receipts, security events, dispatches, turns, version history | `src/workflows/store.ts:28-62` and others |
| Medium | Derived tables never compacted: derived artifacts, guard revisions, learned versions | `src/stores/schema.ts:74` |
| Medium | Docker logs have no rotation; a stuck one-second worker stage logs continuously | No `logging:` in `docker-compose*.yml`; `src/worker-loops.ts` |
| Medium | Hermes native stores never pruned | `services/hermes/isolated_profile.py` |
| Low | Honcho meter calls and provider monitor usage have no retention | `services/honcho/meter.py:42` |

Next steps: ADR-0109 removes the first two; then decide retention per table
family, add log rotation, and add a storage-size report to Monitoring.

</storage_growth>

<inngest_orchestration>

Inngest orchestrates Nocheh's workflow; Hermes and Honcho are steps called
from it, and Hermes keeps its own internals. Paths that run outside Inngest
today: Telegram polling and capture (Hermes thread), the one-second
`nocheh-app` loops for capture, reconciliation, guards, outbox and heartbeat
(`src/stores/worker.ts:14-31`), the 5-second connection supervisor, the Hermes
2-second scheduler loop, the native memory review thread, and the executor
supervisor. Telegram polling and the Hermes turn stay in Hermes. Each
remaining loop is now classified in
[ADR-0120](adr/0120-loops-outside-inngest.md), and the superseded
`src/worker.ts` and `src/workflows/service.ts` are removed.

</inngest_orchestration>

</execution_plan>

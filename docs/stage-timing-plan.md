<execution_plan>

# Per-stage message timing

<authority>

The owner chose "plan first" on 2026-10-09: review this plan before any code.
The requirement is in [SPECS.md](../SPECS.md) Monitoring: the duration of each
stage is broken down; system workflows are tracked by execution time; external
(third-party) services and the LLM are measured separately. Current gaps are
in [the operations review](operations-review-plan.md). Code references are from
`main` at `c1e274f`.

</authority>

<goal>

For any message, the owner can run one CLI command or open one Monitoring view
and see where its reply time went, for example:

```
event 1234 · reply 212.4 s · attempt 1
  internal   capture → archive            0.3 s
  internal   outbox → Inngest publish     1.1 s
  workflow   preparation queue wait       2.0 s
  third-party transcription               6.8 s
  workflow   dispatch queue wait         38.5 s
  internal   Hermes bootstrap + history   4.2 s
  third-party Honcho context              1.9 s
  llm        provider wait (3 calls)    121.0 s
  internal   tools + guard               18.7 s
  third-party Telegram send               0.6 s
  unmeasured                             17.3 s
```

</goal>

<stage_model>

Every measurement has one category, so the categories never mix:

| Category | Meaning | Examples |
| --- | --- | --- |
| `internal` | Nocheh or Hermes code running | capture, guard, history prepare, tool execution |
| `workflow` | Waiting in or between Inngest steps | queue wait before a step, prerequisite waits, retry backoff |
| `third_party` | Waiting on an external service other than the LLM | Honcho, embeddings, transcription, Telegram Bot API |
| `llm` | Waiting on the reasoning provider | broker `provider_headers_ms` + `provider_read_ms` |

The rules in the existing spec still hold: overlapping phases are not summed;
provider waits are not called model compute; a missing value is shown as
unmeasured, never as zero; no content or credentials are recorded.
`unmeasured` is reply time minus the non-overlapping measured stages.

</stage_model>

<sources>

| Stage | Source today | Change |
| --- | --- | --- |
| Capture → archive | `events.received_at`, spool timestamps | Record start and end as `internal` |
| Outbox → Inngest | `workflow_outbox.created_at` / `published_at` | Derive as `internal`; stop overwriting `published_at` on republish so the first value survives |
| Inngest queue and steps | `workflow_registry`, Inngest history | Record step start/end in `advanceWorkflow` (`src/workflows/engine.ts:9-56`); queue wait = step start − request time, as `workflow` |
| Transcription | none | Time the speech call in `services/hermes/transcription.py` as `third_party` |
| Hermes phases | `services/hermes/timing.py`, already in the dispatch result | Keep them: `storeResult` (`src/stores/telegram-dispatch.ts:92`) currently drops them |
| Honcho context and recall | Hermes `memory_recall` phase; Honcho meter `calls.duration_ms` | Time Nocheh's Honcho HTTP calls per event as `third_party` |
| Embeddings | Honcho meter SQLite, not event-bound | Tag meter rows with the event when the call is bound to one |
| LLM | `security_events.timings` (`src/security/timing.ts`) | Already event-bound; map to `llm` |
| Hermes `conversation` | one number that mixes LLM, tools and guard | Split into `llm` (from broker) and remaining `internal` |
| Telegram send | none | Time each Bot API send in the Hermes adapter as `third_party` |

</sources>

<storage>

One control-database table, `stage_timings`, with columns: event, attempt,
stage, category, started_at, duration_ms, calls, and source (which component
measured it). It is append-only per attempt and bounded by the same retention
rule as other operational data (default 14 days, configurable), so timing
data cannot grow unbounded.

</storage>

<sequence>

| Step | Work | Acceptance |
| --- | --- | --- |
| T1 | `stage_timings` table, writer, retention | Insert, idempotent re-write per attempt, retention removes only expired rows |
| T2 | Persist Hermes phases from the dispatch result | A dispatch result with timings is stored; malformed timings are rejected |
| T3 | Workflow step and queue timing in `advanceWorkflow` | Wait and run durations recorded for a synthetic workflow |
| T4 | Third-party timers: Honcho calls, transcription, Telegram send, embedding tagging | Each records `third_party` with the event; failures still record duration |
| T5 | `./bin/nocheh admin timings <event>` stage breakdown, a Monitoring event view, and Monitoring per-stage p50/p95 across recent messages | Breakdown sums only non-overlapping stages; unmeasured shown explicitly |
| T6 | Synthetic Telegram simulation run | One breakdown per scenario message, no content in rows |

</sequence>

<decisions>

- Monitoring shows both per-stage averages (p50/p95) across recent messages and
  a per-message breakdown (owner decision, 2026-10-09).

</decisions>

<implementation_notes>

- Reply time runs from Telegram's message date (one-second resolution; the
  archive time when the date is missing or implausible) to the end of the last
  Hermes attempt's delivery. `capture` therefore includes Bot API polling.
- Each instant of the reply is attributed once: Hermes and transcription over
  workflow steps, steps and outbox over queue and step waits. Duration-only
  Hermes phases split the time of the Hermes stage that contains them, and
  `conversation` keeps only what provider wait, model guard and Honcho recall do
  not explain ("tools + agent"). Anything left is `unmeasured`.
- Hermes `memory_recall` is shown as third-party "Honcho context"; it includes
  Nocheh's request hop to the cached context. `context_prepare` is nested in other
  phases and is not added.
- The Hermes run journal supplies the attempt window (queued, processing,
  delivery, finished); the run receipt keeps allowlisted durations only.
- `workflow_outbox.first_published_at` keeps the first publication; republishing
  still refreshes `published_at`, which drives the republish interval.
- Stage rows follow `NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS` (default 14; `0`
  keeps them) and are pruned hourly by the storage worker.
- `./bin/nocheh admin timings <event>` prints the breakdown, `timings recent`
  prints p50/p95 per stage, and `timings <event> --effects` keeps the raw
  provider measurements and workflow receipts.

</implementation_notes>

</execution_plan>

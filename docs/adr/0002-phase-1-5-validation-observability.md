# ADR-0002: Phase 1.5 Validation and Observability

## Status

Accepted

## Context

Phase 1 can ingest Telegram messages, redact secrets, extract tasks, persist local structured memory, and synchronize tasks to Notion through MCP. The next risk is correctness: operators need to see how a message moved through the pipeline, why tasks were accepted or rejected, and whether external sync succeeded.

The system must remain cleanly layered. Observability must not couple domain logic to Telegram, Notion, or dashboard concerns.

## Decision

Add a processing audit trail, task validation service, metrics collector port, and internal dashboard.

Each message produces one `ProcessingAuditRecord` with step-level metadata for:

- Telegram message receipt
- Secret detection
- Redaction
- Task extraction
- Validation
- Persistence
- Notion sync

Extracted task metadata is stored in the audit record, including confidence, extraction reason, source message id, processing timestamp, validation warnings, task id when persisted, sync status, and sync error when present.

Validation is handled by a domain service, `TaskValidationService`, which flags duplicate tasks, empty tasks, low confidence tasks, and invalid deadlines. Failed Notion syncs are treated as operational failures: local persistence remains intact, the failure is recorded in audit and metrics, and the processing result reports the failed sync count.

Metrics are collected through `MetricsCollectorPort`. The current implementation is in-process for Phase 1.5. It can be replaced later by Prometheus, OpenTelemetry, or hosted metrics without changing domain or use-case code.

The developer dashboard is an internal HTTP handler that reads only audit records and metrics snapshots. It does not read raw Telegram messages and does not write business state.

## Consequences

Positive:

- Operators can debug every processing step without exposing raw secrets.
- Validation decisions are explicit and testable.
- Sync failures are visible and recoverable without losing local task state.
- Metrics provide an immediate quality baseline for extraction and sync.
- Dashboard code remains outside domain and application business rules.

Tradeoffs:

- Audit records increase local storage volume.
- In-process metrics reset on restart until a production metrics backend is added.
- The dashboard is intentionally lightweight and should remain internal-only.

## Guardrails

- Do not store raw messages in audit records.
- Redacted previews are capped and must pass through the redaction stage first.
- Do not use audit state as long-term memory.
- Do not let dashboard requirements shape domain entities.
- Do not block local persistence because Notion sync failed.

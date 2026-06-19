# Phase 1.5 Observability Architecture

Phase 1.5 adds internal validation and observability without expanding product behavior.

## Processing Audit Trail

`ProcessIncomingMessageUseCase` writes one `ProcessingAuditRecord` per message through `AuditRepositoryPort`.

Tracked steps:

- `telegram_message`
- `secret_detection`
- `redaction`
- `task_extraction`
- `validation`
- `persistence`
- `notion_sync`

Audit records store redacted previews only. Raw Telegram messages are not persisted.

## Validation

`TaskValidationService` is domain logic. It flags:

- duplicate tasks
- empty tasks
- low confidence tasks
- invalid or past deadlines

Rejected candidates remain visible in audit records but are not persisted as tasks.

## Extraction Metadata

Every extracted candidate includes:

- confidence score
- extraction reason
- source message id
- processing timestamp
- validation warnings
- sync status

This metadata is diagnostic and should not become long-term memory.

## Metrics

`MetricsCollectorPort` tracks:

- messages processed
- tasks extracted
- extraction success rate
- sync success rate
- average confidence
- redaction events
- average processing latency

The Phase 1.5 implementation is `InMemoryMetricsCollector`. It can be replaced with an OpenTelemetry or Prometheus adapter later.

## Developer Dashboard

`createDeveloperDashboardHandler` renders an internal HTML dashboard from `AuditRepositoryPort` and `MetricsCollectorPort`.

The dashboard is read-only and must remain operator-facing. It does not mutate tasks, memory, sync state, or message data.

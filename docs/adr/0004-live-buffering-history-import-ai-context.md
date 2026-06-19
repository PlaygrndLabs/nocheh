# ADR-0004: Live Buffering, History Import, and AI Context

## Status

Accepted

## Context

The assistant must support old Telegram groups with existing history while keeping live AI costs controlled.

Telegram bot ingestion is update-based, so the live bot should treat new group messages separately from any one-time historical data supplied by an administrator. The assistant also needs configurable analysis intervals so deployments can choose immediate processing for local smoke tests or batched processing for production-like group chats.

The system must prepare for AI integration without coupling the Telegram webhook, memory model, or task pipeline to one specific AI provider.

## Decision

Split assistant processing into three explicit concerns:

```text
Old group export -> HistoryImportService -> chunked processing -> structured memory
New Telegram messages -> LiveMessageBufferService -> interval/batch flush -> existing pipeline
AI request -> AssistantContextBuilder -> current batch + relevant structured memory
```

Add group-level assistant settings:

- analysis mode: `immediate` or `batch`
- analysis interval in seconds
- maximum messages per batch
- maximum AI context tokens
- maximum retrieved memories
- maximum recent messages
- summary cadence
- reply mode

Add `LiveMessageBufferService` behind `IncomingMessageProcessorPort`. The Telegram webhook now depends on the processor port instead of the concrete `ProcessIncomingMessageUseCase`, so the same handler can use immediate processing or buffered processing.

Buffered live messages are redacted before being stored in the short-lived buffer. When the configured interval elapses or the batch reaches the configured size, the buffer creates one synthetic batch message and sends it through the existing processing pipeline.

Add `HistoryImportService` for one-time backfill from old group exports. It sorts imported messages, redacts each message, chunks by message count and age, and processes each chunk as a synthetic history message. It does not send full history as one AI context.

Add `AssistantContextBuilder` for future AI calls. It builds context from:

- current message or batch
- recent bounded message window
- relevant structured memory records
- configured token budget

Add `AssistantAiPort` as the provider-agnostic AI boundary. Concrete OpenAI, Anthropic, local model, or other adapters can implement it later without changing Telegram ingestion or memory storage.

Add encrypted local repositories for:

- group assistant settings
- short-lived live message buffer

The dev server now uses `LiveMessageBufferService` by default and exposes environment variables for runtime tuning.

## Consequences

Positive:

- Old group history has a deliberate import path instead of pretending the bot can fetch all prior messages.
- Live processing is cost-controlled by interval, batch size, context token budget, and retrieval limits.
- Local smoke tests can still use immediate mode.
- AI provider integration has a clean application port.
- The Telegram webhook remains thin and provider-independent.
- Existing task, memory, redaction, audit, and Notion sync behavior is reused.

Tradeoffs:

- Batched mode means a single live message may not appear in the dashboard until the interval or batch threshold is reached.
- Buffered messages are stored temporarily, even though redacted.
- History import currently expects messages to be supplied by an external importer/export parser.
- The AI port is defined, but no concrete AI provider adapter is implemented yet.

## Guardrails

- Do not send full chat history to AI.
- Do not rely on the Telegram bot to retrieve historical group messages.
- Redact before buffering, history chunking, context building, extraction, persistence, logs, or sync.
- Keep raw historical export parsing outside the live Telegram webhook.
- Keep AI provider details behind `AssistantAiPort`.
- Keep context bounded by explicit message, memory, and token limits.
- Store durable knowledge as structured memory, not raw chat logs.

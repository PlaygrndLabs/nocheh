# ADR-0001: Phase 1 Core Processing

## Status

Accepted

## Context

Phase 1 needs a minimal production-ready pipeline for Telegram ingestion, secret redaction, task extraction, local memory, and Notion MCP sync.

Business logic must stay independent from Telegram, Notion, and future LLM providers.

## Decision

Use clean architecture:

```text
interfaces -> application -> domain
infrastructure -> application ports
```

The main pipeline is:

```text
Telegram webhook
  -> TelegramUpdateMapper
  -> ProcessIncomingMessageUseCase
  -> RegexSecretDetector
  -> TaskExtractorPort
  -> TaskRepository + MemoryRecordRepository
  -> TaskProviderPort
```

Phase 1 uses:

- `RuleBasedTaskExtractor` for deterministic task extraction.
- `RegexSecretDetector` for local redaction before processing or persistence.
- encrypted JSON files for local task, memory, and sync state.
- `NotionMcpTaskProvider` behind `TaskProviderPort`.

Raw Telegram messages are not persisted.

## Consequences

Positive:

- Telegram can be replaced without changing task logic.
- Notion can be replaced without changing task logic.
- Local persistence is simple but encrypted.
- The pipeline is testable without live Telegram or Notion.

Tradeoffs:

- Rule-based extraction is limited.
- Local JSON storage is not suitable for high concurrency.
- Notion MCP sync needs deployment-specific tool names and config.

## Guardrails

- Do not store raw messages by default.
- Redact secrets before extraction, persistence, logs, or sync.
- Keep provider code in infrastructure.
- Keep task and memory rules in domain/application layers.

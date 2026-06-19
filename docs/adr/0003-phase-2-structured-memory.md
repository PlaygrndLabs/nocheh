# ADR-0003: Phase 2 Structured Memory

## Status

Accepted

## Context

The assistant needs durable project knowledge beyond individual tasks. Phase 1 stored extracted tasks as local structured memory, but the memory model was task-only and did not support project context, decisions, blockers, deadlines, summaries, or semantic retrieval.

Long-term memory must remain structured knowledge, not Telegram history. Redaction must run before memory extraction so secrets never enter memory records.

## Decision

Introduce a Phase 2 structured memory model with the following record types:

- Task
- Decision
- Project
- Deadline
- Blocker
- Summary

Every `MemoryRecord` includes:

- `id`
- `type`
- `source`
- `timestamp`
- `confidence`

The source is a message reference only: platform, conversation id, message id, and occurrence time. Raw message text is not stored in long-term memory.

Add `MemoryExtractorPort` for sanitized-message-to-knowledge extraction. The initial implementation is `RuleBasedMemoryExtractor`, which detects explicit project, decision, blocker, deadline, and summary language. It links records to projects via stable normalized project ids where project context is available.

Extend `MemoryRecordRepositoryPort` with typed and project-scoped reads. The local encrypted repository serializes Phase 2 records and can rehydrate legacy Phase 1 task records.

Add `ConversationSummaryService` for periodic summaries derived from existing structured memory records only. It does not summarize or persist raw chat logs.

Add `MemoryRetrievalPort` and `SemanticMemoryRetrievalService` for local semantic-style retrieval. The current implementation ranks structured records by token overlap over structured fields. This avoids adding an embedding provider or vector store before one is needed, while preserving a replaceable retrieval boundary.

Add `MemoryQueryService` for common read-side questions:

- What decisions were made?
- What blockers exist?
- What is the status of project X?

## Consequences

Positive:

- Memory can retain project context, decisions, blockers, deadlines, summaries, and task links without storing chat history.
- Redaction remains the first persistence guardrail.
- Project status and decision/blocker queries have explicit read-side APIs.
- Retrieval can be upgraded to embeddings later behind the same port.
- Local encrypted storage remains sufficient for the current deployment shape.

Tradeoffs:

- Rule-based extraction only handles explicit language and will miss implicit decisions or blockers.
- Token-overlap retrieval is deterministic and testable but less capable than embedding-backed semantic search.
- Project linking depends on detectable project names until richer entity resolution exists.

## Guardrails

- Do not store raw Telegram messages as long-term memory.
- Store only structured knowledge records.
- Run redaction before memory extraction and persistence.
- Do not persist secrets, passwords, API keys, access tokens, private keys, seed phrases, or connection secrets.
- Do not implement personality learning in Phase 2.
- Do not implement autonomous replies in Phase 2.

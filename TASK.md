# Nocheh Brain Tasks

## Goal

Build Nocheh into Mak's personal AI brain and growth assistant: a multi-source
memory system that understands chats, builds structured knowledge, maintains a
knowledge graph, proposes goals/ideas/routine improvements, manages tasks, and
requires Mak approval before external actions.

## Current Phase

Memory graph foundation and live rule-based pipeline are implemented. Current
phase is model/provider selection research before enabling a paid AI provider.
Mak's first preferred paid-provider target is Claude Sonnet through Anthropic
direct API, not AWS Bedrock.

## Task Plan

### 1. Memory Graph Domain

- [x] Add `MemoryNode` domain type.
- [x] Add `MemoryEdge` domain type.
- [x] Add `MemoryNodeKind` union.
- [x] Add `MemoryRelation` union.
- [x] Add shared memory graph source/reference type.
- [x] Add status lifecycle types: `active`, `superseded`, `archived`, `deleted`.
- [x] Add validation helpers for confidence, ids, labels, and temporal fields.

### 2. Expanded Memory Types

- [x] Add memory payload types for `Person`, `Preference`, `StyleRule`, `PersonalRule`, and `Skill`.
- [x] Add strategic memory payload types for `Goal`, `Idea`, `Opportunity`, and `Insight`.
- [x] Add routine payload types for `Routine` and `RoutineExperiment`.
- [x] Add operating-domain payload types for `Asset`, `Risk`, `ContentPlan`, `LearningPlan`, and `InvestmentThesis`.
- [x] Keep raw chat text out of durable payloads.

### 3. Strategic Suggestions

- [x] Add `StrategicSuggestion` domain type.
- [x] Add `ActionSuggestion` domain type.
- [x] Add suggestion statuses: `pending`, `accepted`, `rejected`, `archived`, `converted`.
- [x] Add risk levels for suggestions and external actions.
- [x] Ensure suggestions do not become facts until Mak accepts or converts them.

### 4. SQLite Persistence

- [x] Create fresh SQLite schema for `memory_nodes`.
- [x] Create fresh SQLite schema for `memory_edges`.
- [x] Create fresh SQLite schema for `suggestions`.
- [x] Encrypt sensitive payload/source/fact/rationale fields.
- [x] Add indexes for node kind/scope/status and edge relation/from/to/status.
- [x] Add repository interfaces in application ports.
- [x] Add SQLite repository implementations.
- [x] Add repository tests for save/read/list/update behavior.
- [x] Add tests proving encrypted fields are not stored as plaintext.

### 5. Graph Query Services

- [x] Add `MemoryGraphQueryService`.
- [x] Query node by id.
- [x] List edges for node.
- [x] Query graph neighborhood with bounded depth.
- [x] Query by relation type.
- [x] Add cycle protection for recursive graph traversal.
- [x] Add tests for graph queries across people, projects, goals, routines, ideas, and tasks.

### 6. Suggestion Services

- [x] Add service to create pending suggestions.
- [x] Add approve/edit/reject/archive flows.
- [x] Add conversion flow from accepted suggestion to memory/project/task/routine.
- [x] Add tests that external actions cannot execute without approval.

### 7. Assistant Context Builder Upgrade

- [x] Include relevant graph neighborhood in assistant context.
- [x] Include accepted preferences/style rules/personal rules.
- [x] Include pending high-value suggestions when useful.
- [x] Keep context bounded by token budget.
- [x] Never send full chat history.

### 8. AI Analysis Contract

- [x] Define provider-neutral AI output schema.
- [x] Validate AI output before persistence.
- [x] Support output arrays for memories, nodes, edges, strategic suggestions, action suggestions, and warnings.
- [x] Require source references, confidence, reason, and idempotency key per item.
- [x] Add tests for invalid/partial/low-confidence AI output.

### 9. UI And Observability

- [x] Add complete pre-deployment simulator preview for intake, memory, graph, suggestions, approval, safety, and cost.
- [x] Add memory graph inspection view.
- [x] Add pending suggestions view.
- [x] Add approve/edit/reject controls.
- [x] Add graph/suggestion audit records.
- [x] Add token usage fields and UI display for future provider calls.

### 10. Safety Guardrails

- [x] Keep human approval required for external actions.
- [x] Keep crypto support as decision support only; no auto-trading.
- [x] Label generated goals, ideas, hypotheses, and routine experiments as suggestions until accepted.
- [x] Add source/confidence display for advice and suggestions.
- [x] Add tests for no raw chat text in durable graph nodes/edges.

## Development Tooling

- [x] Install Graphify as dev tooling.
- [x] Add project-scoped Codex Graphify integration.
- [x] Generate initial codebase graph.
- [x] Ignore generated `graphify-out/`.

## Model Selection Research

- [ ] Compare candidate models for reasoning quality, structured JSON reliability, privacy, latency, and real cost.
- [ ] Estimate monthly cost from Nocheh's expected message volume and token budget.
- [ ] Run a local eval set for memory extraction, graph extraction, suggestions, and safety refusals.
- [ ] Evaluate Claude Sonnet through Anthropic direct API as the first quality candidate.
- [ ] Select final provider/model only after eval results and budget review.
- [ ] Keep provider disabled by default until explicitly selected.

## Verification Commands

```bash
npm test
npm run test:web
npm run graphify:update
```

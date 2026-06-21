# Nocheh Brain Tasks

## Goal

Build Nocheh into Mak's personal AI brain and growth assistant: a multi-source
memory system that understands chats, builds structured knowledge, maintains a
knowledge graph, proposes goals/ideas/routine improvements, manages tasks, and
requires Mak approval before external actions.

## Current Phase

Foundation is documented. Next phase is implementation of memory graph domain,
SQLite persistence, and query services.

## Task Plan

### 1. Memory Graph Domain

- [ ] Add `MemoryNode` domain type.
- [ ] Add `MemoryEdge` domain type.
- [ ] Add `MemoryNodeKind` union.
- [ ] Add `MemoryRelation` union.
- [ ] Add shared memory graph source/reference type.
- [ ] Add status lifecycle types: `active`, `superseded`, `archived`, `deleted`.
- [ ] Add validation helpers for confidence, ids, labels, and temporal fields.

### 2. Expanded Memory Types

- [ ] Add memory payload types for `Person`, `Preference`, `StyleRule`, `PersonalRule`, and `Skill`.
- [ ] Add strategic memory payload types for `Goal`, `Idea`, `Opportunity`, and `Insight`.
- [ ] Add routine payload types for `Routine` and `RoutineExperiment`.
- [ ] Add operating-domain payload types for `Asset`, `Risk`, `ContentPlan`, `LearningPlan`, and `InvestmentThesis`.
- [ ] Keep raw chat text out of durable payloads.

### 3. Strategic Suggestions

- [ ] Add `StrategicSuggestion` domain type.
- [ ] Add `ActionSuggestion` domain type.
- [ ] Add suggestion statuses: `pending`, `accepted`, `rejected`, `archived`, `converted`.
- [ ] Add risk levels for suggestions and external actions.
- [ ] Ensure suggestions do not become facts until Mak accepts or converts them.

### 4. SQLite Persistence

- [ ] Create fresh SQLite schema for `memory_nodes`.
- [ ] Create fresh SQLite schema for `memory_edges`.
- [ ] Create fresh SQLite schema for `suggestions`.
- [ ] Encrypt sensitive payload/source/fact/rationale fields.
- [ ] Add indexes for node kind/scope/status and edge relation/from/to/status.
- [ ] Add repository interfaces in application ports.
- [ ] Add SQLite repository implementations.
- [ ] Add repository tests for save/read/list/update behavior.
- [ ] Add tests proving encrypted fields are not stored as plaintext.

### 5. Graph Query Services

- [ ] Add `MemoryGraphQueryService`.
- [ ] Query node by id.
- [ ] List edges for node.
- [ ] Query graph neighborhood with bounded depth.
- [ ] Query by relation type.
- [ ] Add cycle protection for recursive graph traversal.
- [ ] Add tests for graph queries across people, projects, goals, routines, ideas, and tasks.

### 6. Suggestion Services

- [ ] Add service to create pending suggestions.
- [ ] Add approve/edit/reject/archive flows.
- [ ] Add conversion flow from accepted suggestion to memory/project/task/routine.
- [ ] Add tests that external actions cannot execute without approval.

### 7. Assistant Context Builder Upgrade

- [ ] Include relevant graph neighborhood in assistant context.
- [ ] Include accepted preferences/style rules/personal rules.
- [ ] Include pending high-value suggestions when useful.
- [ ] Keep context bounded by token budget.
- [ ] Never send full chat history.

### 8. AI Analysis Contract

- [ ] Define provider-neutral AI output schema.
- [ ] Validate AI output before persistence.
- [ ] Support output arrays for memories, nodes, edges, strategic suggestions, action suggestions, and warnings.
- [ ] Require source references, confidence, reason, and idempotency key per item.
- [ ] Add tests for invalid/partial/low-confidence AI output.

### 9. UI And Observability

- [x] Add complete pre-deployment simulator preview for intake, memory, graph, suggestions, approval, safety, and cost.
- [ ] Add memory graph inspection view.
- [ ] Add pending suggestions view.
- [ ] Add approve/edit/reject controls.
- [ ] Add graph/suggestion audit records.
- [ ] Expose AI token usage once provider calls exist.

### 10. Safety Guardrails

- [ ] Keep human approval required for external actions.
- [ ] Keep crypto support as decision support only; no auto-trading.
- [ ] Label generated goals, ideas, hypotheses, and routine experiments as suggestions until accepted.
- [ ] Add source/confidence display for advice and suggestions.
- [ ] Add tests for no raw chat text in durable graph nodes/edges.

## Development Tooling

- [x] Install Graphify as dev tooling.
- [x] Add project-scoped Codex Graphify integration.
- [x] Generate initial codebase graph.
- [x] Ignore generated `graphify-out/`.

## Verification Commands

```bash
npm test
npm run test:web
npm run graphify:update
```

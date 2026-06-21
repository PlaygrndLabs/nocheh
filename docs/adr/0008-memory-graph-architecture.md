# ADR-0008: Memory Graph Architecture

## Status

Accepted

## Context

Nocheh needs to become a personal AI brain, not only a task extractor. The next
implementation phase needs a durable memory model that can represent facts,
people, projects, routines, goals, ideas, assets, risks, learning plans, content
plans, and investment theses. It also needs a graph layer so Nocheh can reason
over relationships across conversations and domains.

The current app already uses SQLite with encrypted payload fields. Keeping the
first graph implementation in SQLite preserves the current deployment model and
avoids adding graph database operations before the product proves that it needs
them.

This phase can create the graph schema from scratch. Do not spend effort on
backward-compatible graph migrations until the graph model is proven.

## Decision

Add explicit memory graph records:

- `MemoryNode`
- `MemoryEdge`
- `StrategicSuggestion`
- `ActionSuggestion`

Use SQLite tables for graph storage:

- `memory_nodes`
- `memory_edges`
- `suggestions`

Use normal indexed columns for routing/filtering metadata:

- node kind
- relation
- scope
- status
- confidence
- timestamps
- `from_node_id`
- `to_node_id`

Use encrypted JSON fields for sensitive or rich payloads:

- summaries
- aliases
- facts
- source references
- full typed payloads
- suggestion rationale

Support graph retrieval with bounded recursive CTEs and graph-neighborhood
queries. Every recursive graph query must have a depth limit and cycle
protection.

Use JSON Schema as the provider-neutral AI output contract, with application
validation before persistence. AI output may propose memory, graph records, and
suggestions, but it may not execute actions.

Persist all externally meaningful actions as pending suggestions first. Mak must
approve, edit, reject, archive, or convert them before execution or durable
behavior changes.

## Initial Types

Memory node kinds:

- `person`
- `project`
- `conversation`
- `task`
- `decision`
- `goal`
- `idea`
- `routine`
- `area`
- `resource`
- `skill`
- `asset`
- `risk`
- `content_plan`
- `learning_plan`
- `investment_thesis`
- `concept`

Initial edge relations:

- `PERSON_WORKS_ON_PROJECT`
- `PERSON_OWNS_TASK`
- `PROJECT_HAS_DECISION`
- `PROJECT_HAS_DEADLINE`
- `PROJECT_HAS_BLOCKER`
- `TASK_BLOCKED_BY_PERSON`
- `GOAL_HAS_PROJECT`
- `GOAL_HAS_ROUTINE`
- `IDEA_SUPPORTS_GOAL`
- `IDEA_BECAME_PROJECT`
- `ROUTINE_SUPPORTS_AREA`
- `PREFERENCE_GUIDES_STYLE`
- `SKILL_SUPPORTS_TASK`
- `PARTNER_WORKS_ON_STARTUP`
- `CLIENT_OWNS_PROJECT`
- `CONTENT_PLAN_SUPPORTS_GOAL`
- `LEARNING_PLAN_BUILDS_SKILL`
- `ASSET_BELONGS_TO_PROJECT`
- `INVESTMENT_THESIS_HAS_RISK`
- `RISK_AFFECTS_GOAL`

Suggestion types:

- `goal`
- `idea`
- `opportunity`
- `routine_experiment`
- `hypothesis`
- `recommendation`
- `reply`
- `external_action`

## Consequences

Positive:

- Nocheh can connect memory across people, projects, goals, routines, assets,
  ideas, and decisions.
- The first implementation stays compatible with local SQLite/VPS deployment.
- Graph records stay auditable through source references, confidence, status,
  and timestamps.
- Encrypted payloads preserve the current privacy posture while still allowing
  indexed graph queries.
- AI providers remain replaceable because output is validated against a
  provider-neutral schema.

Tradeoffs:

- SQLite graph queries are enough for v1, but complex graph analytics may later
  need a dedicated graph or vector/graph hybrid store.
- Encrypted payloads limit deep SQL filtering, so frequently queried fields must
  be promoted to indexed columns deliberately.
- The graph model adds schema complexity before the AI analyzer is fully
  implemented.

## Guardrails

- Do not store raw chat text in graph nodes or edges.
- Do not persist AI output unless it validates against the application schema.
- Do not execute external actions from AI output.
- Do not auto-trade or present crypto support as guaranteed financial advice.
- Do not let suggestions become accepted goals, routines, tasks, or rules
  without Mak approval.
- Keep graph queries bounded by depth and limit to avoid runaway traversal.

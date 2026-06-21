# Research 0002: Memory Graph Implementation

## Purpose

Turn the product memory direction into an implementation-ready technical shape:
SQLite graph storage, scoped retrieval, provider-neutral AI output validation,
and guardrails for advice/action domains.

## Sources Reviewed

- SQLite recursive CTEs and graph queries:
  https://www.sqlite.org/lang_with.html
- SQLite JSON functions:
  https://www.sqlite.org/json1.html
- JSON Schema overview:
  https://json-schema.org/overview/what-is-jsonschema
- NIST AI Risk Management Framework:
  https://www.nist.gov/itl/ai-risk-management-framework
- SEC investor alert on crypto asset securities:
  https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-alerts/crypto-asset-securities
- Existing Nocheh persistence ADR:
  `docs/adr/0005-sqlite-vps-persistence.md`

## Findings

### SQLite Graph Storage

SQLite is enough for the first graph implementation. Recursive CTEs can walk
trees and graphs, and SQLite's own docs include graph query examples with edge
indexes. The Nocheh graph does not need Neo4j or a graph database yet.

Use two graph tables:

- `memory_nodes`
- `memory_edges`

Keep queryable metadata as normal indexed columns. Keep sensitive descriptions,
facts, and payloads inside encrypted JSON fields, matching the current SQLite
repository pattern.

Recommended indexes:

- nodes by `kind`, `scope`, `status`, `updated_at`
- edges by `from_node_id`, `to_node_id`, `relation`, `status`
- edges by `(from_node_id, relation, status)`
- edges by `(to_node_id, relation, status)`
- edges by `valid_from`, `valid_until` for temporal reasoning

For graph-neighborhood queries, use bounded recursive CTEs:

- always require a max depth
- default depth should be low, likely `2`
- use `UNION` or path tracking to avoid cycles
- return node ids, edge ids, relation, depth, and score hints

### JSON Payloads

SQLite JSON functions are useful for local tooling, migrations, and occasional
inspection, but Nocheh should not depend on querying deeply into encrypted JSON.

Use this split:

- indexed columns for routing and filtering
- encrypted JSON payload for rich domain-specific data
- TypeScript/domain validation before persistence

If a payload field must be searched often, promote it to a normal indexed column
instead of relying on ad hoc JSON queries.

### Provider-Neutral AI Output Validation

Use JSON Schema as the provider-neutral contract for AI analysis output. JSON
Schema defines structure and constraints for JSON data and enables validators to
check whether a JSON document conforms to the schema.

For Nocheh, AI output should be one object with separate arrays:

- `memories`
- `nodes`
- `edges`
- `strategicSuggestions`
- `actionSuggestions`
- `warnings`

Each item must include:

- `sourceMessageIds` or `sourceRecordIds`
- `confidence`
- `reason`
- `idempotencyKey`

Rejected AI output should not partially persist unless it can be safely split
and validated per item. Store an audit record for invalid output, but do not
store raw model text as durable memory.

### Advice and Safety

NIST AI RMF is the right high-level guide: map risks, measure behavior, manage
controls, and keep governance visible. For Nocheh this means:

- classify suggestions by risk
- require human approval before external effects
- audit why suggestions were made
- make confidence and source evidence visible
- support rejection/editing feedback loops

Crypto trading support needs stricter boundaries. SEC investor guidance says
crypto asset investments can be volatile, speculative, and may lack important
investor protections. Nocheh should support research, thesis tracking, risk
rules, journaling, and reminders, but not auto-trading or guaranteed financial
advice.

## Recommended Technical Shape

### Domain Types

Add graph domain types:

- `MemoryNode`
- `MemoryEdge`
- `MemoryNodeKind`
- `MemoryRelation`
- `MemoryGraphSource`

Add suggestion domain types:

- `StrategicSuggestion`
- `ActionSuggestion`
- `SuggestionStatus`
- `SuggestionRiskLevel`

Extend memory payloads for:

- `Person`
- `Preference`
- `StyleRule`
- `PersonalRule`
- `Skill`
- `Goal`
- `Idea`
- `Opportunity`
- `Insight`
- `Routine`
- `RoutineExperiment`
- `Asset`
- `Risk`
- `ContentPlan`
- `LearningPlan`
- `InvestmentThesis`

### SQLite Tables

`memory_nodes`:

- `id TEXT PRIMARY KEY`
- `kind TEXT NOT NULL`
- `label TEXT NOT NULL`
- `scope TEXT NOT NULL`
- `status TEXT NOT NULL`
- `summary_cipher TEXT`
- `aliases_cipher TEXT`
- `payload_cipher TEXT NOT NULL`
- `source_cipher TEXT NOT NULL`
- `confidence REAL NOT NULL`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

`memory_edges`:

- `id TEXT PRIMARY KEY`
- `from_node_id TEXT NOT NULL`
- `to_node_id TEXT NOT NULL`
- `relation TEXT NOT NULL`
- `status TEXT NOT NULL`
- `fact_cipher TEXT NOT NULL`
- `payload_cipher TEXT NOT NULL`
- `source_cipher TEXT NOT NULL`
- `confidence REAL NOT NULL`
- `valid_from TEXT`
- `valid_until TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

`suggestions`:

- `id TEXT PRIMARY KEY`
- `type TEXT NOT NULL`
- `status TEXT NOT NULL`
- `risk_level TEXT NOT NULL`
- `title_cipher TEXT NOT NULL`
- `rationale_cipher TEXT NOT NULL`
- `payload_cipher TEXT NOT NULL`
- `source_cipher TEXT NOT NULL`
- `confidence REAL NOT NULL`
- `impact TEXT`
- `effort TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `resolved_at TEXT`
- `converted_to_id TEXT`

### Retrieval Services

Add services in this order:

1. `MemoryGraphQueryService`
   - fetch node
   - list edges for node
   - neighborhood query with max depth
   - relation-filtered query

2. `StrategicSuggestionService`
   - create pending suggestion
   - approve/edit/reject/archive
   - convert accepted suggestion into memory/project/task/routine

3. Update `AssistantContextBuilder`
   - current messages
   - relevant structured memory
   - relevant graph neighborhood
   - pending accepted rules/preferences
   - never full history

### AI Analysis Contract

The AI analyzer should return only structured objects. It should not decide to
execute anything.

Output categories:

- durable memory candidates
- graph node candidates
- graph edge candidates
- strategic suggestions
- action suggestions
- warnings or uncertainty notes

The application layer should:

- validate shape
- redact again defensively
- reject low-confidence or source-less items
- persist accepted memory candidates
- persist suggestions as pending
- audit token usage and validation failures

## Decision

Use SQLite with explicit node/edge tables for v1 graph memory. Avoid a graph
database until local graph queries, indexes, and retrieval needs are proven
insufficient.

Use JSON Schema as the provider-neutral contract for AI output, plus TypeScript
domain validation before persistence.

Keep human approval mandatory for external actions and high-impact suggestions.
For crypto and financial domains, Nocheh provides tracking and decision support,
not automated trading or guaranteed advice.

# Research 0001: Second-Brain and Agent Memory Patterns

## Purpose

Before extending Nocheh's memory model, compare existing second-brain,
agent-memory, and human-approval patterns. Use this to choose the next memory
structure and avoid inventing a fragile design.

## Sources Reviewed

- LangGraph memory overview:
  https://docs.langchain.com/oss/python/concepts/memory
- Mem0 memory types and operations:
  https://docs.mem0.ai/core-concepts/memory-types
  https://docs.mem0.ai/core-concepts/memory-operations/add
  https://docs.mem0.ai/core-concepts/memory-operations/search
- Zep context graph concepts:
  https://help.getzep.com/users-and-user-graphs
  https://help.getzep.com/facts
  https://help.getzep.com/entities
  https://help.getzep.com/episodes
- Letta stateful agents and HITL tools:
  https://docs.letta.com/guides/core-concepts/stateful-agents
  https://docs.letta.com/guides/core-concepts/tools/human-in-the-loop
- LangGraph interrupts:
  https://docs.langchain.com/oss/python/langgraph/interrupts
- Forte Labs PARA method:
  https://fortelabs.com/blog/para/
- Obsidian internal links and Bases:
  https://obsidian.md/help/links
  https://obsidian.md/help/bases

## Findings

### Memory Structure

LangGraph's most useful split for Nocheh is:

- short-term memory: current thread/conversation state
- long-term semantic memory: facts and preferences across sessions
- episodic memory: past experiences or examples
- procedural memory: rules/instructions for how the agent should work

Mem0 adds practical scoping:

- conversation memory for the current turn
- session/run memory for temporary task context
- user memory for durable personalization
- org/shared memory for shared knowledge

Zep adds the strongest model for connected personal memory:

- user graph: one unified memory graph across threads
- entities: people, projects, products, places, concepts
- facts: precise relationship claims with timestamps
- summaries: narrative rollups for entities and threads
- episodes: source artifacts behind extracted knowledge

For Nocheh, use Zep's entity/fact/time idea, but do not copy Zep's default
verbatim episode retention. Nocheh's privacy rule stays stricter: durable
storage should keep structured knowledge and redacted source references, not raw
chat messages.

Nocheh should have an explicit knowledge graph, not only a flat list of memory
records. The graph should connect people, projects, conversations, tasks, goals,
ideas, decisions, blockers, routines, preferences, areas, resources, and skills.
Graph edges should be typed facts with source, confidence, and temporal
validity.

The graph must be broad enough for the owner's real operating domains: startups,
partners, freelance work, coaching, routines, English learning, X/Twitter
growth, assets, crypto trading decision support, and personal/business advice.

### Retrieval

Best pattern:

- retrieve local conversation context first
- retrieve global user memory second
- retrieve by type/filter before broad semantic search
- include source references and confidence
- keep a small final context block

Nocheh should support both:

- direct queries: "what did I promise Ali?"
- context assembly: "what does the assistant need to know before drafting?"
- graph questions: "which routines support this goal?", "who blocks this
  project?", "which ideas came from this client conversation?"

### Organization

PARA is useful as a product-level lens:

- Projects: active outcomes with deadlines/tasks
- Areas: ongoing responsibilities
- Resources: reusable knowledge
- Archives: inactive/completed context

Nocheh should not force all memory into PARA folders, but projects and areas
should be first-class metadata. This keeps memory actionable instead of becoming
a passive note archive.

Goals and ideas should be first-class, not hidden inside tasks. Tasks describe
execution. Goals describe desired outcomes. Ideas describe possible approaches
or inventions that may or may not become projects.

Routines should also be first-class. A routine is a repeated behavior or system,
not a task. A routine experiment is a proposed change to test for a short period
before accepting it as a durable personal rule or routine.

Obsidian-style links are useful for inspection:

- every memory can link to people, projects, conversations, tasks, and decisions
- database-like views help review/filter memory records

### Approval and Action

Letta and LangGraph converge on the same safe pattern:

- risky tools or external actions pause
- the system stores the proposed action and exact arguments
- a human approves, edits, or rejects
- execution resumes only after approval

For Nocheh, every outward communication should be approval-gated at first:

- send Telegram reply
- update Notion
- send email
- create external calendar event
- delete/update stored memory

### Cost Management

The common cost pattern is:

- batch noisy messages
- extract/promote only useful memories
- retrieve a small number of relevant memories
- summarize stale context
- track token usage
- support dry-run/rule-based mode

Nocheh already has batching, context budgets, and rule-based extraction. The
next step is to make those controls explicit in the AI analysis contract and
audit records.

## Recommended Nocheh Memory Shape

Use four durable memory layers:

1. `WorkingMemory`
   - temporary batch/conversation context
   - expires or is flushed after processing
   - may contain redacted message text

2. `KnowledgeMemory`
   - durable structured facts
   - includes tasks, decisions, deadlines, blockers, summaries, people,
     preferences, projects, areas, resources, goals, ideas, opportunities,
     insights, routines, routine experiments, skills, assets, risks, content
     plans, learning plans, and investment theses
   - no raw message text

3. `RelationshipMemory`
   - graph edges between memory entities
   - examples: `PERSON_WORKS_ON_PROJECT`, `PROJECT_HAS_DEADLINE`,
     `MAK_PREFERS_STYLE`, `TASK_BLOCKED_BY_PERSON`
   - each edge has source, confidence, valid/invalid timestamps

4. `ProcedureMemory`
   - durable rules for how Nocheh should behave
   - examples: reply style rules, approval policy, prioritization rules, learned
     skills
   - changes should be auditable and approval-gated when they affect external
     behavior

5. `StrategicSuggestion`
   - pending goals, ideas, opportunities, routine experiments, hypotheses, and
     recommendations
   - not treated as facts until accepted by the owner
   - can be converted into projects, tasks, personal rules, or durable memories

## Recommended Record Fields

Every durable memory record should have:

- `id`
- `type`
- `scope`: `user`, `conversation`, `project`, or `global`
- `source`: platform, conversation id, message id or import chunk id, occurred at
- `subjectIds`: linked people/projects/conversations/tasks
- `confidence`
- `status`: `active`, `superseded`, `archived`, or `deleted`
- `createdAt`
- `updatedAt`
- optional `validFrom`
- optional `validUntil`
- optional `supersedes`
- structured payload by type

Graph node records should have:

- `id`
- `kind`: `person`, `project`, `conversation`, `task`, `decision`, `goal`,
  `idea`, `routine`, `area`, `resource`, `skill`, `asset`, `risk`,
  `content_plan`, `learning_plan`, `investment_thesis`, or `concept`
- `label`
- `summary`
- `aliases`
- `scope`
- `source`
- `confidence`
- `status`
- `createdAt`
- `updatedAt`

Graph edge records should have:

- `fromId`
- `toId`
- `relation`
- `fact`
- `source`
- `confidence`
- `status`: `active`, `superseded`, `archived`, or `deleted`
- `validFrom`
- `validUntil`
- `createdAt`
- `updatedAt`

Initial relation names should be explicit and queryable:

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

Strategic suggestion records should have:

- `id`
- `type`: `goal`, `idea`, `opportunity`, `routine_experiment`, `hypothesis`, or
  `recommendation`
- `title`
- `rationale`
- `evidenceIds`
- `source`
- `confidence`
- `impact`
- `effort`
- `status`: `pending`, `accepted`, `rejected`, `archived`, or `converted`
- optional `convertedToId`

Routine records should have:

- `id`
- `name`
- `area`
- `trigger`
- `action`
- `cadence`
- `successSignal`
- `status`: `active`, `paused`, `retired`, or `archived`
- `source`
- `confidence`

Routine experiment records should have:

- `id`
- `title`
- `hypothesis`
- `trigger`
- `proposedAction`
- `reviewCadence`
- `successSignal`
- `status`: `pending`, `accepted`, `rejected`, `running`, `completed`, or
  `converted`
- optional `convertedRoutineId`

## Recommended Next Implementation Order

1. Add an ADR for memory architecture based on this research.
2. Extend the domain model with `Person`, `Preference`, `StyleRule`,
   `PersonalRule`, `Skill`, `Goal`, `Idea`, `Opportunity`, `Insight`, and
   `Routine`, `RoutineExperiment`, `Asset`, `Risk`, `ContentPlan`,
   `LearningPlan`, `InvestmentThesis`, and relationship records.
3. Add `MemoryNode` and `MemoryEdge` records for graph memory.
4. Add repository methods for scoped/type-filtered and graph-neighborhood
   retrieval before adding
   embeddings.
5. Add AI analysis output schemas that can create/update those records.
6. Add strategic suggestion/action records with approval status.
7. Add UI views for memory graph inspection and pending approvals.

## Decision

Do not copy any single project wholesale.

Adopt a Nocheh-specific hybrid:

- LangGraph memory categories for conceptual clarity.
- Mem0 scoping for conversation/session/user separation.
- Zep-style entities, facts, summaries, and temporal relationships.
- Explicit Nocheh `MemoryNode` and `MemoryEdge` graph records.
- PARA metadata for action-oriented organization.
- Obsidian-like links and views for human inspection.
- Letta/LangGraph-style approval gates for actions.

Keep Nocheh's stricter default privacy rule: durable memory is structured
knowledge, not raw chat history.

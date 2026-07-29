# ADR-0007: Personal AI Brain Roadmap

## Status

Accepted

## Context

Nocheh started as an AI Telegram assistant that ingests group messages, redacts
secrets, extracts tasks and structured memory, stores data locally, and can sync
tasks to Notion.

The intended product is broader: a personal AI brain for its owner. It should observe
many conversations over time, analyze context, preserve durable knowledge, learn
preferences and communication style, and help the owner remember, decide, and
draft responses. It should also help the owner set goals, find opportunities, and
generate
new ideas from accumulated context. It should help improve routines and repeated
behaviors through small, reviewable experiments. Telegram is the first adapter,
not the product boundary.

The product must cover the owner's real operating domains: startups and partners,
freelance work, coaching and personal growth, projects and tasks, English
learning, X/Twitter growth, asset management, crypto trading decision support,
and personal/business advice.

The assistant must avoid two failure modes:

- becoming a raw chat archive that stores too much sensitive data
- acting or speaking as the owner without explicit approval

AI provider choice should also remain replaceable. The current code already has
`AssistantAiPort`, bounded context building, structured memory repositories,
redaction, audit records, and platform-neutral incoming messages.

## Decision

Adopt Nocheh Brain as the product direction:

```text
Input channels
  -> normalized incoming messages
  -> redaction and safety checks
  -> bounded AI/rule analysis
  -> structured personal memory
  -> knowledge graph updates
  -> retrieval and context building
  -> goals, ideas, routine experiments, answers, and actions for owner approval
```

Telegram remains the first production source. Future sources such as email,
calendar, DMs, and other chat systems must enter through the same normalized
message model instead of creating platform-specific business logic.

Long-term memory remains structured-only by default. The system may temporarily
buffer sanitized messages for batching and context building, but durable memory
must store facts, summaries, source references, confidence, preferences, style
rules, and learned skills rather than full raw chat history.

Knowledge graph memory is required for the long-term product. Entities such as
people, projects, goals, tasks, routines, conversations, ideas, and decisions
should become graph nodes. Relationships between them should become typed graph
edges with source references, confidence, and temporal validity.

AI integration must be provider-neutral. Provider adapters can implement
`AssistantAiPort`, but domain, application, Telegram, memory, and approval
logic must not depend on a specific provider.

Any outward action requires approval. The assistant may draft replies, propose
task changes, propose goals, generate ideas, identify opportunities, or suggest
routine experiments and next actions, but early versions must persist those as
pending suggestions until the owner approves, edits, rejects, or archives them.

Strategic suggestions are not facts. Proposed goals, ideas, opportunities, and
hypotheses must be labeled as suggestions until the owner accepts them or converts
them into a project, task, rule, or durable memory.

Routine suggestions are also not commands. They should be framed as small
experiments with an optional review cadence and success signal. The assistant
must not nag, shame, or treat a missed routine as personal failure.

Cost management is part of the product contract. AI processing must use batching,
bounded recent-message windows, retrieved structured memory, summaries, token
budgets, dry-run or AI-off mode, and token usage metrics once provider calls are
implemented.

## Roadmap

1. Documentation and product alignment
   - Update `AGENTS.md`, `README.md`, and ADRs to describe Nocheh as
     a personal AI brain.
   - Keep current capabilities clearly separate from planned capabilities.

2. Multi-group Telegram foundation
   - Make conversation identity, settings, retrieval, history import, and UI
     language clearly support many Telegram groups.
   - Preserve the platform-neutral `IncomingMessage` boundary.

3. AI analysis contract
   - Define stable structured AI outputs for tasks, memories, people,
     preferences, style signals, risks, goals, ideas, opportunities, suggested
     routine improvements, replies, and actions.
   - Validate AI output before persistence or approval creation.
   - Record confidence and token usage.

4. Structured personal memory
   - Extend memory beyond `Task`, `Decision`, `Project`, `Deadline`, `Blocker`,
     and `Summary`.
   - Add planned memory categories for `Person`, `Preference`, `StyleRule`,
     `PersonalRule`, `Skill`, `Goal`, `Idea`, `Opportunity`, `Insight`,
     `Routine`, `RoutineExperiment`, `Asset`, `Risk`, `ContentPlan`,
     `LearningPlan`, and `InvestmentThesis`.
   - Continue storing source references and confidence scores without raw
     long-term message text.

5. Knowledge graph memory
   - Add `MemoryNode` and `MemoryEdge` style records.
   - Store typed relationship facts such as `PERSON_WORKS_ON_PROJECT`,
     `GOAL_HAS_ROUTINE`, `IDEA_SUPPORTS_GOAL`, `TASK_BLOCKED_BY_PERSON`, and
     `PROJECT_HAS_DECISION`.
   - Support graph-backed questions across conversations, people, projects,
     routines, goals, ideas, and tasks.

6. Cost-managed AI processing
   - Add global and per-conversation AI budget controls.
   - Support dry-run mode where analysis is simulated or rule-based only.
   - Track and expose token usage through metrics/audit once provider calls
     exist.

7. Human approval layer
   - Persist suggested goals, ideas, routine experiments, replies, and actions
     as pending records.
   - Add UI/API paths to approve, edit, reject, or archive suggestions.
   - Send or execute externally only after explicit approval.

8. Future platform expansion
   - Add more sources only after Telegram multi-group memory is reliable.
   - Prefer email or calendar next, depending on which produces the highest
     value for commitments and planning.

## Consequences

Positive:

- The product direction matches the desired second-brain and future clone goal.
- The assistant can become a strategic thinking partner, not only a task
  organizer.
- The assistant can improve repeated behavior by proposing small routine
  experiments instead of only managing one-off work.
- Graph memory gives Nocheh a way to reason over relationships, not just search
  isolated records.
- The architecture can support startups, freelance work, learning, content,
  assets, trading decision support, and personal growth without becoming a set
  of disconnected mini-apps.
- Telegram remains useful without locking core logic to Telegram.
- Structured memory protects privacy better than raw history storage.
- Human approval prevents accidental impersonation or unintended action.
- Provider-neutral AI integration keeps the system flexible.
- Cost constraints are designed into the architecture early.

Tradeoffs:

- Structured-only memory is safer but may learn style more slowly than raw
  transcript retention.
- Human approval reduces automation speed, but it protects trust.
- Proactive ideation may create noisy suggestions until ranking and feedback
  loops improve.
- Routine suggestions can feel intrusive if not clearly optional and editable.
- Delaying provider choice slows real AI analysis, but avoids premature coupling.
- Multi-platform expansion is intentionally postponed until Telegram memory is
  strong enough to be a reliable foundation.

## Guardrails

- Do not store raw chat history as durable memory by default.
- Redact before buffering, analysis, context building, persistence, logs, or
  external sync.
- Do not send full history to an AI provider.
- Do not store raw chat text inside graph nodes or edges.
- Do not implement provider-specific logic outside provider adapters.
- Do not auto-send replies or auto-execute external actions without owner approval.
- Do not treat generated ideas, hypotheses, or proposed goals as accepted facts.
- Do not treat routine suggestions as obligations unless the owner accepts them.
- Do not auto-trade, make financial decisions, or present trading support as
  guaranteed financial advice.
- Do not claim clone/personality behavior is implemented before style memory,
  approval, and provider-backed analysis exist.
- Keep cost controls configurable and visible.

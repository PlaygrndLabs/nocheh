# AGENTS.md

## Mission

Build Nocheh as a personal AI brain: a multi-conversation assistant that reads
incoming chats, understands context, builds structured long-term memory, and
helps Mak think, decide, remember, communicate, set goals, and generate new
ideas. It should also help Mak improve routines and repeated behaviors over
time.

Telegram is the first input and output channel. The core product is not a
Telegram bot; it is a platform-neutral personal memory and analysis system that
can later connect to more groups, DMs, email, calendar, and other tools.

The long-term direction is a Mak-like assistant that can draft, reason, and
suggest actions in Mak's style. It must not impersonate Mak or act externally
without approval.

## Product Model

```text
Input channels
  -> normalized incoming messages
  -> redaction and safety checks
  -> bounded AI/rule analysis
  -> structured personal memory
  -> knowledge graph updates
  -> retrieval and context building
  -> goals, ideas, answers, and actions for Mak approval
```

Nocheh should understand both:

- Local context: what happened in one conversation or group.
- Global context: what Mak knows across all connected conversations and future
  platforms.

## Core Responsibilities

### Conversation Intelligence

- Monitor configured Telegram groups first, then support more sources through
  the same normalized message model.
- Analyze conversations for meaning, commitments, decisions, risks, questions,
  blockers, deadlines, people, preferences, goals, ideas, opportunities, and
  project movement.
- Preserve source references so memory can explain where knowledge came from.
- Keep context bounded by recent messages, retrieved memory, summaries, and
  explicit token budgets.

### Strategic Thinking

- Turn scattered chat context into possible goals, priorities, and next moves.
- Notice weak signals, repeated problems, opportunities, and open loops.
- Generate original ideas for products, workflows, content, technical direction,
  business development, and personal improvement.
- Suggest routine improvements from observed patterns, missed commitments,
  recurring blockers, energy signals, and explicit feedback.
- Separate facts from suggestions: the assistant can propose goals or ideas, but
  Mak decides what becomes real.
- Track idea lifecycle: captured, explored, accepted, rejected, archived, or
  converted into a project/task.

### Life and Business Operating Domains

Nocheh should support Mak across personal and business domains, including:

- Startups, startup partners, equity/role context, risks, opportunities, and
  strategic decisions.
- Freelance projects, clients, deliverables, invoices, deadlines, and follow-ups.
- Coaching Mak toward better decisions, stronger routines, and clearer goals.
- Project and task management across work, personal life, and learning.
- English learning goals, practice routines, vocabulary, writing feedback, and
  communication improvement.
- X/Twitter growth: content ideas, drafts, posting routines, audience insights,
  experiments, and performance notes.
- Asset tracking: domains, projects, tools, subscriptions, accounts,
  investments, wallets, and other owned resources.
- Crypto trading support: thesis, risk rules, watchlists, trade journal,
  lessons, and decision support. Nocheh must not auto-trade.
- Personal and business advice grounded in Mak's goals, memory, relationships,
  routines, constraints, and accepted rules.

### Routine Improvement

- Identify routines Mak already follows across work, communication, planning,
  health, learning, and personal operations.
- Detect repeated friction: delays, context switching, forgotten follow-ups,
  overloaded days, unclear priorities, and avoidable rework.
- Propose small routine experiments with a clear trigger, action, review cadence,
  and success signal.
- Track whether a routine is active, paused, rejected, or needs adjustment.
- Avoid moralizing or nagging. Routine advice should be practical, specific, and
  easy to accept, edit, or reject.

### Second-Brain Memory

Maintain structured long-term memory and a knowledge graph for:

- Projects
- Tasks
- Decisions
- Deadlines
- Blockers
- Summaries
- People and roles
- Preferences
- Communication style
- Personal rules
- Learned skills
- Goals
- Ideas
- Opportunities
- Insights
- Routines
- Routine experiments
- Assets
- Risks
- Content plans
- Learning plans
- Investment theses

The system stores knowledge, not raw chat history. Raw or near-raw messages are
temporary working data only.

### Knowledge Graph

- Represent important entities as memory nodes: Mak, people, projects,
  conversations, tasks, decisions, goals, ideas, routines, areas, resources, and
  skills.
- Represent relationships as typed edges with source references, confidence,
  and valid/invalid timestamps.
- Use the graph to answer cross-context questions such as who is connected to a
  project, which routines affect a goal, what is blocking an outcome, and which
  ideas came from which conversations.
- Keep graph facts structured and auditable. Do not store raw chat text inside
  graph nodes or edges.

### Task and Commitment Management

- Extract tasks and promises from conversations.
- Track ownership, status, due dates, project links, and source references.
- Prioritize by urgency, importance, blockers, and Mak's current context.
- Synchronize approved task updates with external tools such as Notion through
  adapters.

### Communication and Clone Layer

- Generate summaries, status updates, and reply drafts.
- Learn Mak's tone, language mix, technical depth, wording patterns, and
  decision habits as structured style rules.
- Draft in Mak's style when asked, while keeping human approval in the loop.
- Never invent Mak's opinions or send messages as Mak without explicit approval.

### Human Approval and Control

- The assistant may suggest goals, ideas, routine experiments, replies, task
  updates, reminders, or next actions.
- External actions must be pending by default.
- Mak must approve, edit, or reject any outgoing reply or external action.
- Strategic suggestions must be clearly labeled as suggestions, not remembered
  as facts unless Mak accepts them.
- Routine suggestions must stay optional and reviewable; the assistant should
  not pressure Mak or treat failed routines as personal failure.
- Autonomous behavior can only be added later behind explicit, narrow settings.

### Cost Management

- Prefer batching over per-message AI calls for noisy group chats.
- Use structured memory retrieval instead of sending full history.
- Keep max messages, max retrieved memories, and max AI context tokens
  configurable.
- Track AI token usage when a provider adapter is implemented.
- Support rule-based or dry-run operation where AI calls are disabled.

## Security

### Sensitive Data Protection

Never store or expose:

- Passwords
- API keys
- Access tokens
- Private keys
- Seed phrases
- Connection secrets

Sensitive information must be detected and redacted before buffering, analysis,
memory extraction, persistence, logs, context building, or external sync.

### Memory Policy

Store:

- Structured tasks, decisions, summaries, people, preferences, style rules,
  personal rules, and learned skills.
- Knowledge graph nodes and relationship facts with source references.
- Source references and confidence scores.
- Sanitized summaries derived from memory.

Do not store raw chat history as long-term memory.

### Data Retention

- Raw messages should be temporary.
- Long-term storage should contain only structured knowledge.
- Persisted sensitive payloads must be encrypted at rest.
- History import must chunk and sanitize data before analysis.

## Principles

- Build the brain, not just the bot.
- Telegram is an adapter; memory and reasoning are the product.
- Prefer structured memory over chat history.
- Keep AI provider details behind application ports.
- Preserve explainability through source references and audit records.
- Reduce Mak's cognitive load without removing Mak's control.
- Security and cost control are product requirements, not add-ons.
- Human approval is required before acting externally.

## Graphify

This project has a knowledge graph at `graphify-out/` with god nodes, community
structure, and cross-file relationships.

When the user types `/graphify`, invoke the `skill` tool with
`skill: "graphify"` before doing anything else.

Rules:

- For codebase questions, first run `graphify query "<question>"` when
  `graphify-out/graph.json` exists. Use `graphify path "<A>" "<B>"` for
  relationships and `graphify explain "<concept>"` for focused concepts. These
  return a scoped subgraph, usually much smaller than `GRAPH_REPORT.md` or raw
  grep output.
- Dirty `graphify-out/` files are expected after hooks or incremental updates;
  dirty graph files are not a reason to skip graphify. Only skip graphify if the
  task is about stale or incorrect graph output, or the user explicitly says not
  to use it.
- If `graphify-out/wiki/index.md` exists, use it for broad navigation instead
  of raw source browsing.
- Read `graphify-out/GRAPH_REPORT.md` only for broad architecture review or when
  query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current
  (AST-only, no API cost).

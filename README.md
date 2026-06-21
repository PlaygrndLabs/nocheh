# My Nocheh

Nocheh is being built as a **personal AI brain**: a multi-conversation
assistant that reads incoming chats, analyzes what matters, builds structured
long-term memory, and helps Mak remember, decide, communicate, set goals, and
generate new ideas. It should also help Mak improve routines and repeated
behaviors over time.

The current implementation is at **Phase 2: Structured Memory**. Telegram is
the first channel, but the product direction is platform-neutral: Telegram
groups now, more conversations and tools later.

## What Works

- Telegram webhook ingestion
- Secret detection and redaction
- Rule-based task extraction
- Structured memory extraction for projects, decisions, blockers, deadlines, and summaries
- Configurable live group-message batching before analysis
- One-time history import service for old group exports
- AI context builder that uses recent messages plus retrieved structured memory
- Task-to-project linking when project context is detected
- Semantic-style local memory retrieval
- Task validation and audit trail
- SQLite task/memory/audit store with encrypted payload fields
- Notion MCP task sync adapter
- React client at `/app` for configuration, bot connection, history import, mock testing, metrics, conversations, and chat-flow visualization

Not included yet: concrete AI provider calls, personal profile/style memory,
approval workflow for suggested replies/actions, embedding-backed vector search,
or additional platform adapters beyond Telegram/mock/history import.

## Product Direction

Nocheh should become a second brain, not just a task extractor:

```text
Telegram groups / future sources
  -> normalized messages
  -> redaction and safety checks
  -> bounded AI/rule analysis
  -> structured personal memory
  -> knowledge graph updates
  -> retrieval and context building
  -> goals, ideas, routine experiments, drafts, and actions for Mak approval
```

The assistant should understand:

- local context inside one conversation
- global context across all connected conversations
- tasks, decisions, deadlines, blockers, projects, people, preferences, style,
  goals, ideas, opportunities, insights, routines, and learned personal rules
- graph relationships between people, projects, goals, tasks, routines, and
  ideas
- what Mak is likely to forget or need next
- recurring patterns that could become better routines

Any outgoing reply or external action must require Mak approval. The system may
draft, suggest, and generate ideas; it must not impersonate Mak or auto-act by
default. Strategic suggestions should stay separate from facts until Mak accepts
them. Routine suggestions should be optional experiments, not pressure.

## Operating Domains

Nocheh should eventually help across Mak's personal and business operating
system:

- startups, startup partners, roles, risks, strategic decisions, and
  opportunities
- freelance projects, clients, deliverables, invoices, deadlines, and follow-ups
- coaching, personal growth, better decisions, and routine improvement
- project and task management across business, personal life, and learning
- English learning goals, practice routines, vocabulary, and writing feedback
- X/Twitter growth: content ideas, drafts, posting routines, audience insights,
  experiments, and performance notes
- asset tracking: domains, projects, tools, subscriptions, accounts,
  investments, wallets, and owned resources
- crypto trading support: thesis, risk rules, watchlists, trade journal,
  lessons, and decision support, without auto-trading
- personal and business advice grounded in memory, goals, relationships,
  routines, constraints, and accepted rules

## Roadmap

1. **Docs and product alignment**
   Reframe the app as Nocheh Brain in agent docs, README, ADRs, and UI wording.
2. **Multi-group Telegram foundation**
   Make conversation identity, settings, retrieval, history import, and views
   clearly support many Telegram groups.
3. **AI analysis contract**
   Define provider-neutral schemas for tasks, memories, people, preferences,
   style signals, risks, goals, ideas, opportunities, routine improvements,
   suggested replies, and suggested actions.
4. **Structured personal memory**
   Extend memory with people, preferences, style rules, personal rules, goals,
   ideas, opportunities, insights, routines, routine experiments, and learned
   skills while continuing to avoid raw long-term chat storage.
5. **Knowledge graph memory**
   Add graph nodes for entities and typed relationship facts with source,
   confidence, and temporal validity.
6. **Cost-managed AI processing**
   Add explicit AI budgets, token usage tracking, dry-run mode, and controls for
   batch size, interval, retrieved memories, and context size.
7. **Human approval layer**
   Persist suggested replies/actions as pending until Mak approves, edits, or
   rejects them.
8. **Future platform expansion**
   Add email, calendar, or other chat sources after Telegram multi-group memory
   works well.

## Current Assistant Model

Telegram bots receive new updates after they can see a chat; they do not automatically fetch old group history. Nocheh handles this with two paths:

```text
Old group export -> HistoryImportService -> chunked analysis -> structured memory
New messages     -> LiveMessageBufferService -> interval/batch flush -> structured memory/tasks
```

The AI context should be built from:

- current message or batch
- recent short window
- relevant structured memories
- summaries/tasks/blockers

It should not receive full chat history. Future AI provider adapters must remain
behind the existing provider-neutral application port.

## Memory Policy

Long-term memory stores structured knowledge only. It does not store raw Telegram messages.

Every memory record includes:

- `id`
- `type`
- `source`
- `timestamp`
- `confidence`

Supported memory types:

- `Task`
- `Decision`
- `Project`
- `Deadline`
- `Blocker`
- `Summary`

Planned memory types:

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

Planned graph records:

- `MemoryNode`
- `MemoryEdge`
- typed relations such as `PERSON_WORKS_ON_PROJECT`, `GOAL_HAS_ROUTINE`,
  `IDEA_SUPPORTS_GOAL`, `TASK_BLOCKED_BY_PERSON`, and `PROJECT_HAS_DECISION`

Redaction runs before memory extraction. Secrets, passwords, API keys, access tokens, private keys, seed phrases, and connection strings must not be persisted.

## Run

```bash
npm install
npm test
npm run dev
```

For local smoke tests where each webhook should process immediately:

```bash
MESSAGE_ANALYSIS_MODE=immediate npm run dev
```

Open:

```text
http://127.0.0.1:3000/app
```

Health check:

```bash
curl http://127.0.0.1:3000/health
```

Send a test Telegram-style message:

```bash
curl -X POST http://127.0.0.1:3000/telegram/webhook \
  -H 'content-type: application/json' \
  -d '{"update_id":1,"message":{"message_id":101,"date":1781870400,"chat":{"id":"dev-chat"},"from":{"id":7,"first_name":"Dev"},"text":"Task: prepare release notes by 2026-06-20 urgent"}}'
```

Then refresh `/app`.

## Client UI

A React client at `/app` bootstraps the assistant: add the AI key, connect a
Telegram bot (validate + register webhook), import history, configure group
settings, inject mock messages, and visualize the processing flow. Secrets are
written to a gitignored `.env` and never read back through the API.

Build it once, then it is served by the same backend:

```bash
npm run build:all   # backend + web/dist
npm run dev
# open http://127.0.0.1:3000/app
```

For active UI development with hot reload, run the backend and the Vite dev
server (it proxies `/api` to the backend, so there is no CORS to configure):

```bash
npm run dev          # backend on :3000
npm run dev:web      # Vite on :5173, proxying /api -> :3000
```

Frontend tests:

```bash
npm run test:web
```

Note: most environment variables are read once at startup, so values saved
through the client require a restart to take effect. The Telegram token is
used immediately when connecting the bot.

## Env

Optional:

```bash
PORT=3000
DATA_DIR=./data
DATABASE_PATH=./data/nocheh.sqlite
LOCAL_ENCRYPTION_SECRET=change-this-secret
MESSAGE_ANALYSIS_MODE=batch
LIVE_ANALYSIS_INTERVAL_SECONDS=300
LIVE_MAX_MESSAGES_PER_BATCH=50
MAX_AI_CONTEXT_TOKENS=4000
MAX_RETRIEVED_MEMORIES=12
MAX_RECENT_MESSAGES=30
SUMMARY_EVERY_MESSAGES=100
SUMMARY_EVERY_MINUTES=60
```

For real Notion MCP sync:

```bash
NOTION_MCP_COMMAND=...
NOTION_MCP_ARGS=...
NOTION_DATABASE_ID=...
NOTION_MCP_CREATE_TOOL=notion_create_task
NOTION_MCP_UPDATE_TOOL=notion_update_task
```

If Notion env is missing, local tasks still persist and the audit trail shows sync failure.

## Docker

### Dev (live reload)

Keep a stack running that rebuilds on every code change:

```bash
docker compose -f docker-compose.dev.yml up --build
# UI (Vite HMR):     http://127.0.0.1:5173/app
# Backend API/SPA:   http://127.0.0.1:3000
```

- **Frontend** runs under Vite with hot module replacement — edit anything in
  `web/src` and the browser updates instantly.
- **Backend** runs `tsc --watch` + `node --watch` — edit anything in `src` and it
  recompiles and restarts automatically.
- Source is bind-mounted; `node_modules` live in named volumes so the container's
  native `better-sqlite3` build is preserved. Run detached with `-d`; follow logs
  with `docker compose -f docker-compose.dev.yml logs -f`. Override ports with
  `HOST_PORT` (backend) and `WEB_PORT` (Vite).

Develop against the Vite URL (`:5173/app`) for instant UI updates; it proxies
`/api` to the backend container.

### Local (built image)

```bash
docker compose up -d --build
# open http://127.0.0.1:3000/app
```

This starts only the `nocheh` app container and publishes it to
`127.0.0.1:3000`. The `cloudflared` tunnel is behind a `tunnel` profile, so it is
not started locally (it would crash-loop without a token). Set `HOST_PORT` to use
a different host port:

```bash
HOST_PORT=8080 docker compose up -d --build   # http://127.0.0.1:8080/app
```

### VPS (Cloudflare Tunnel ingress)

The production path adds the Cloudflare Tunnel for ingress with SQLite on a
mounted data directory.

```bash
cp .env.example .env
# edit LOCAL_ENCRYPTION_SECRET and CLOUDFLARE_TUNNEL_TOKEN
docker compose --profile tunnel up -d --build
```

The app listens inside Docker on:

```text
http://nocheh:3000
```

Configure the Cloudflare Tunnel public hostname to route to:

```text
http://nocheh:3000
```

Then set the Telegram webhook to:

```text
https://<your-tunnel-hostname>/telegram/webhook
```

SQLite is stored at `./data/nocheh.sqlite` on the VPS. Back up the `data` directory, and keep `LOCAL_ENCRYPTION_SECRET` stable; encrypted payloads cannot be read if that secret changes.

## Structure

```text
src/domain          Core entities, validation, memory, audit types
src/application     Use cases, query services, and ports
src/infrastructure  Telegram, storage, security, reasoning, metrics, Notion MCP adapters
src/interfaces      HTTP webhook, JSON API router, and static handler
test                Unit tests
web                 React client (Vite, served at /app)
docs                Short architecture notes and ADRs
```

## Docs

- [Task Plan](TASK.md)
- [Development Tooling](docs/development-tooling.md)
- [ADR 0001: Phase 1 Core Processing](docs/adr/0001-phase-1-core-processing.md)
- [Phase 1.5 Observability](docs/observability-architecture.md)
- [ADR 0002: Phase 1.5 Validation and Observability](docs/adr/0002-phase-1-5-validation-observability.md)
- [ADR 0003: Phase 2 Structured Memory](docs/adr/0003-phase-2-structured-memory.md)
- [ADR 0004: Live Buffering, History Import, and AI Context](docs/adr/0004-live-buffering-history-import-ai-context.md)
- [ADR 0005: SQLite VPS Persistence](docs/adr/0005-sqlite-vps-persistence.md)
- [ADR 0006: Client UI and Chat-Flow Visualization](docs/adr/0006-setup-dashboard.md)
- [ADR 0007: Personal AI Brain Roadmap](docs/adr/0007-personal-ai-brain-roadmap.md)
- [ADR 0008: Memory Graph Architecture](docs/adr/0008-memory-graph-architecture.md)
- [Research 0001: Second-Brain and Agent Memory Patterns](docs/research/0001-second-brain-and-agent-memory.md)
- [Research 0002: Memory Graph Implementation](docs/research/0002-memory-graph-implementation-research.md)

## Commands

```bash
npm run build
npm test
npm run dev
```

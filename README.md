# My Nocheh

AI Telegram assistant, currently at **Phase 2: Structured Memory**.

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
- Internal dashboard and metrics

Not included yet: concrete AI provider calls, personality learning, autonomous replies, embedding-backed vector search.

## Assistant Model

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

It should not receive full chat history.

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
http://127.0.0.1:3000/dashboard
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

Then refresh `/dashboard`.

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

## VPS Docker

The production path is a persistent Docker Compose service with SQLite on a mounted data directory and Cloudflare Tunnel for ingress.

```bash
cp .env.example .env
# edit LOCAL_ENCRYPTION_SECRET and CLOUDFLARE_TUNNEL_TOKEN
docker compose up -d --build
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
src/interfaces      HTTP webhook and internal dashboard handlers
test                Unit tests
docs                Short architecture notes and ADRs
```

## Docs

- [ADR 0001: Phase 1 Core Processing](docs/adr/0001-phase-1-core-processing.md)
- [Phase 1.5 Observability](docs/observability-architecture.md)
- [ADR 0002: Phase 1.5 Validation and Observability](docs/adr/0002-phase-1-5-validation-observability.md)
- [ADR 0003: Phase 2 Structured Memory](docs/adr/0003-phase-2-structured-memory.md)
- [ADR 0004: Live Buffering, History Import, and AI Context](docs/adr/0004-live-buffering-history-import-ai-context.md)
- [ADR 0005: SQLite VPS Persistence](docs/adr/0005-sqlite-vps-persistence.md)

## Commands

```bash
npm run build
npm test
npm run dev
```

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
- React setup dashboard at `/app` for configuration, bot connection, history import, mock testing, and chat-flow visualization

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

## Setup Dashboard

A React dashboard at `/app` bootstraps the assistant: add the AI key, connect a
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
through the dashboard require a restart to take effect. The Telegram token is
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
src/interfaces      HTTP webhook, JSON API router, static handler, dashboard handlers
test                Unit tests
web                 React setup dashboard (Vite, served at /app)
docs                Short architecture notes and ADRs
```

## Docs

- [ADR 0001: Phase 1 Core Processing](docs/adr/0001-phase-1-core-processing.md)
- [Phase 1.5 Observability](docs/observability-architecture.md)
- [ADR 0002: Phase 1.5 Validation and Observability](docs/adr/0002-phase-1-5-validation-observability.md)
- [ADR 0003: Phase 2 Structured Memory](docs/adr/0003-phase-2-structured-memory.md)
- [ADR 0004: Live Buffering, History Import, and AI Context](docs/adr/0004-live-buffering-history-import-ai-context.md)
- [ADR 0005: SQLite VPS Persistence](docs/adr/0005-sqlite-vps-persistence.md)
- [ADR 0006: Setup Dashboard and Chat-Flow Visualization](docs/adr/0006-setup-dashboard.md)

## Commands

```bash
npm run build
npm test
npm run dev
```

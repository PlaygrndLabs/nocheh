# My Nocheh

AI Telegram assistant, currently at **Phase 2: Structured Memory**.

## What Works

- Telegram webhook ingestion
- Secret detection and redaction
- Rule-based task extraction
- Structured memory extraction for projects, decisions, blockers, deadlines, and summaries
- Task-to-project linking when project context is detected
- Semantic-style local memory retrieval
- Task validation and audit trail
- Encrypted local task/memory/audit store
- Notion MCP task sync adapter
- Internal dashboard and metrics

Not included yet: personality learning, autonomous replies, embedding-backed vector search.

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
LOCAL_ENCRYPTION_SECRET=change-this-secret
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

## Commands

```bash
npm run build
npm test
npm run dev
```

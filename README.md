# My Nocheh

AI Telegram assistant, currently at **Phase 1.5: Validation & Observability**.

## What Works

- Telegram webhook ingestion
- Secret detection and redaction
- Rule-based task extraction
- Task validation and audit trail
- Encrypted local task/memory/audit store
- Notion MCP task sync adapter
- Internal dashboard and metrics

Not included yet: personality learning, long-term memory graph, autonomous agent behavior.

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
src/domain          Core entities, validation, audit types
src/application     Use cases and ports
src/infrastructure  Telegram, storage, security, metrics, Notion MCP adapters
src/interfaces      HTTP webhook and internal dashboard handlers
test                Unit tests
docs                Short architecture notes and ADRs
```

## Commands

```bash
npm run build
npm test
npm run dev
```

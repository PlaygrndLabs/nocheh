# Nocheh

Personal AI brain. It reads chats, redacts secrets, turns them into structured
memory plus a knowledge graph, and proposes suggestions the owner approves.

Telegram is the first input channel. Memory and reasoning are the product.

**Status:** private MVP. Single owner, password-gated dashboard, SQLite on one box.

## Pipeline

```text
Telegram webhook | mock | note | history import
  -> secret detection + redaction
  -> buffer (batch or immediate)
  -> AI analysis (one provider port)
  -> memory records + graph nodes/edges + tasks
  -> pending suggestions -> owner approves
```

Raw chat is working data only. Long-term storage keeps structured knowledge with
source references and confidence.

## Quickstart

VPS, one command after a clone — installs Docker, generates every secret, starts
the stack behind a Cloudflare Tunnel, registers the Telegram webhook:

```bash
bash scripts/bootstrap.sh
```

Local:

```bash
npm install
npm run build:all           # backend + web/dist
npm run dev                 # http://127.0.0.1:3000/app
```

`.env` needs at minimum:

```bash
APP_AUTH_USERNAME=<username>
APP_AUTH_PASSWORD=<strong-password>
LOCAL_ENCRYPTION_SECRET=<long-stable-secret>
```

`bash scripts/bootstrap.sh --env-only` writes those for you.

Without auth env, every `/api/*` route except `/api/auth/*` returns 503. Without
an AI provider the app runs in **dry-run**: ingestion, redaction, buffering, and
audit still work, no analysis is produced.

```bash
curl http://127.0.0.1:3000/health
MESSAGE_ANALYSIS_MODE=immediate npm run dev   # process each message at once
```

UI hot reload: `npm run dev` + `npm run dev:web` (Vite on :5173, proxies `/api`).

## Dashboard (`/app`)

| Tab | Does |
| --- | --- |
| Setup | Readiness checks; pick AI provider, save key/model to `.env` |
| Connect bot | Validate Telegram token, register webhook, edit chat/user allow-lists |
| Import history | Paste a Telegram Desktop export and process it into memory |
| Simulator | Mock groups: inject messages, reactions, notes, run analysis, inspect the flow |
| Notes | Send authoritative out-of-band notes to the brain |
| Conversations | Metrics plus per-conversation pipeline audit trace |
| Knowledge graph | Read-only memory graph and recent relations |
| Settings | Per-conversation analysis settings and the redaction policy |

Secrets are written to a gitignored `.env` and never read back. Most env is read
at boot, so provider changes need a restart (the dashboard reports
`restartRequired`). The Telegram token applies immediately.

## What Works

- Telegram webhook ingestion with chat/user allow-lists
- Configurable secret detection and redaction before anything is stored
- Batch or immediate analysis windows, with summary cadence
- Provider-neutral AI analysis: NVIDIA `z-ai/glm-5.2` (default) or Anthropic Claude
- Validated AI output contract (source ref, confidence, reason, idempotency key)
- 6 memory record types, 17 graph node kinds, 20 relation types, 16 payload kinds
- Bounded assistant context: recent window + retrieved memory + graph neighborhood
  + accepted rules + high-value pending suggestions
- Pending suggestions with an approve/reject/archive/convert domain lifecycle
- SQLite persistence with encrypted payload columns; per-step audit records
- Token usage recorded per analysis run
- One-time Telegram history import
- Notion MCP task sync adapter

## Not Yet

- Embedding-backed vector search (retrieval is lexical scoring)
- Approval controls in the UI (the suggestion API exists; no buttons wired)
- Outbound messages: Nocheh never writes to Telegram, ingestion only
- Any channel other than Telegram, mock, note, and history import
- Autonomous external actions (by design: approval first)

## Env

```bash
PORT=3000
HOST=127.0.0.1
DATA_DIR=./data
DATABASE_PATH=./data/nocheh.sqlite
LOCAL_ENCRYPTION_SECRET=
APP_AUTH_USERNAME=
APP_AUTH_PASSWORD=
APP_AUTH_SESSION_SECRET=          # defaults to LOCAL_ENCRYPTION_SECRET
APP_AUTH_SECURE_COOKIE=false      # true when served over HTTPS
PUBLIC_HOSTNAME=                  # tunnel hostname, used by scripts/bootstrap.sh

AI_PROVIDER=nvidia                # blank = dry-run
NVIDIA_API_KEY=nvapi-...
NVIDIA_MODEL=z-ai/glm-5.2         # optional, this is the default
NVIDIA_BASE_URL=                  # optional, self-hosted NIM or gateway
NVIDIA_JSON_RESPONSE_FORMAT=true  # false if the endpoint rejects json_object
# AI_PROVIDER=anthropic; ANTHROPIC_API_KEY=sk-ant-...; ANTHROPIC_MODEL=<required>

MESSAGE_ANALYSIS_MODE=batch       # or immediate
LIVE_ANALYSIS_INTERVAL_SECONDS=300
LIVE_MAX_MESSAGES_PER_BATCH=50
MAX_AI_CONTEXT_TOKENS=4000
MAX_AI_OUTPUT_TOKENS=4000
MAX_RETRIEVED_MEMORIES=12
MAX_RECENT_MESSAGES=30
SUMMARY_EVERY_MESSAGES=100
SUMMARY_EVERY_MINUTES=60

TELEGRAM_ALLOWED_CHAT_IDS=        # optional allow-lists
TELEGRAM_ALLOWED_USER_IDS=

NOTION_MCP_COMMAND=               # optional Notion sync
NOTION_MCP_ARGS=
NOTION_DATABASE_ID=
NOTION_MCP_CREATE_TOOL=notion_create_task
NOTION_MCP_UPDATE_TOOL=notion_update_task
```

Without Notion env, tasks still persist locally and the audit shows sync failure.

## Structure

```text
src/domain          Entities, memory graph, suggestions, redaction policy, audit
src/application     Use cases, services, ports, provider catalog
src/infrastructure  Telegram, SQLite, security, reasoning, metrics, Notion MCP
src/interfaces      HTTP router, JSON API, webhook, static handler
src/dev-server.ts   Composition root
scripts             bootstrap.sh (VPS deploy), run-tests.mjs
test                Backend tests (node:test)
web                 React client served at /app
docs                Deploy guide, ADRs, research
```

Adding an AI provider = one adapter in `src/infrastructure/reasoning/` plus one
entry in `src/application/config/ai-provider-catalog.ts`.

## Commands

```bash
bash scripts/bootstrap.sh   # provision/deploy on a VPS (idempotent, --help)
npm run build          # backend
npm run build:all      # backend + web
npm test               # backend tests
npm run test:web       # frontend tests
npm run graphify:update
```

## Docs

- [Deploy](docs/deploy.md)
- [Open tasks](TASK.md)
- [Agent rules](AGENTS.md)
- [ADRs](docs/adr/README.md)
- Research: [second-brain memory](docs/research/0001-second-brain-and-agent-memory.md),
  [memory graph](docs/research/0002-memory-graph-implementation-research.md),
  [model cost](docs/research/0003-model-selection-cost-reasoning.md)

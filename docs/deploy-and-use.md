# Deploy And Use Nocheh

## Readiness

Nocheh is ready for private MVP use as a local/VPS assistant with:

- Telegram webhook ingestion.
- Multi-conversation settings.
- Secret redaction before processing.
- Rule-based task and structured memory extraction.
- Memory graph nodes, edges, and pending suggestions.
- SQLite persistence with encrypted sensitive payload fields.
- Dashboard at `/app` for setup, simulation, metrics, conversation audit, graph,
  and suggestion approval.
- Optional Notion MCP task sync.
- Optional provider adapter support, disabled by default until model research is
  complete.

Nocheh is not yet ready as a fully autonomous or fully AI-powered clone:

- No paid AI provider/model is selected by default.
- The default analyzer is deterministic/rule-based.
- Suggested replies/actions still require human approval.
- Telegram is the only live chat adapter.
- Crypto support is decision support only; no auto-trading.

Use it now to collect structured memory, test workflows, import history, inspect
the graph, and validate the operating model before enabling paid model calls.

## Local Run

Install dependencies and run tests:

```bash
npm install
npm test
npm run test:web
```

Build and run the backend plus bundled web UI:

```bash
npm run build:all
npm run dev
```

Open:

```text
http://127.0.0.1:3000/app
```

Health check:

```bash
curl http://127.0.0.1:3000/health
```

For faster local testing, process each mock/webhook message immediately:

```bash
MESSAGE_ANALYSIS_MODE=immediate npm run dev
```

## Local Docker

Create `.env`:

```bash
cp .env.example .env
```

Edit at minimum:

```bash
LOCAL_ENCRYPTION_SECRET=replace-with-a-long-stable-secret
APP_AUTH_USERNAME=mak
APP_AUTH_PASSWORD=replace-with-a-strong-password
```

Start:

```bash
docker compose up -d --build
```

Open:

```text
http://127.0.0.1:3000/app
```

Logs:

```bash
docker compose logs -f nocheh
```

Stop:

```bash
docker compose down
```

## VPS Deploy With Cloudflare Tunnel

Prerequisites:

- Docker and Docker Compose plugin installed.
- A Cloudflare Tunnel token.
- A Telegram bot token from BotFather.
- A domain/subdomain routed through the Cloudflare Tunnel.

On the VPS:

```bash
git clone <repo-url> my-nocheh
cd my-nocheh
cp .env.example .env
```

Edit `.env`:

```bash
LOCAL_ENCRYPTION_SECRET=replace-with-a-long-stable-secret
APP_AUTH_USERNAME=mak
APP_AUTH_PASSWORD=replace-with-a-strong-password
CLOUDFLARE_TUNNEL_TOKEN=replace-with-cloudflare-tunnel-token
MESSAGE_ANALYSIS_MODE=batch
LIVE_ANALYSIS_INTERVAL_SECONDS=300
LIVE_MAX_MESSAGES_PER_BATCH=50
```

Optional bot allow-list:

```bash
TELEGRAM_ALLOWED_CHAT_IDS=-1001234567890
TELEGRAM_ALLOWED_USER_IDS=123456789
```

When either allow-list is set, the webhook ignores Telegram messages outside the configured chat/user IDs.

Keep these blank until model research is done:

```bash
AI_PROVIDER=
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=
```

Start the app and tunnel:

```bash
docker compose --profile tunnel up -d --build
```

Check health:

```bash
docker compose ps
docker compose logs -f nocheh
```

Open the dashboard:

```text
https://<your-public-hostname>/app
```

## First Use

1. Open `/app`.
2. Go to **Setup**.
3. Confirm encryption is configured.
4. Leave AI provider empty while model selection is still open.
5. Connect the Telegram bot:
   - paste Telegram bot token
   - set webhook URL to `https://<your-public-hostname>/telegram/webhook`
6. Add the bot to the target Telegram group.
7. Configure the group in **Settings**:
   - use `batch` for noisy groups
   - use `immediate` for testing
8. Send a test message in Telegram or use **Simulator**.
9. Review:
   - **Simulator** for brain-flow preview
   - **Conversations** for audit trace
   - brain graph/suggestion panels for persisted graph and pending suggestions

## Import Old Telegram History

Telegram bots do not automatically read old group history. Use Telegram Desktop
export:

1. Export the group as JSON from Telegram Desktop.
2. Open `/app`.
3. Go to **History**.
4. Upload/import the export.
5. Nocheh chunks, redacts, and processes the history into structured memory.

Do not import sensitive exports until you trust the redaction behavior and have
backups.

## Using The Assistant

Good messages to test:

```text
Project: Atlas - launch work
Decision: use Cloudflare Workers for the API
Blocker: waiting on legal review
Deadline: launch by 2026-07-01
Task: prepare release notes
```

For second-brain scenarios:

```text
I want English routine, X content ideas, startup partner goals, and crypto thesis but do not trade.
```

Expected behavior:

- Creates structured memories.
- Creates graph nodes and edges.
- Creates pending suggestions.
- Blocks high-risk external action paths.
- Keeps raw chat out of long-term memory.

## Provider / Model Selection

Provider calls are disabled by default.

Current policy:

- Use rule-based analysis until model selection research is complete.
- Do not set `AI_PROVIDER` unless Mak explicitly approves a provider/model.
- Do not enable a premium reasoning model for every group message.
- Run evals first for JSON reliability, memory quality, safety, latency, and
  real token cost.
- First preferred paid-provider path is Claude Sonnet through Anthropic direct
  API, not AWS Bedrock.

Research plan:

- See `docs/research/0003-model-selection-cost-reasoning.md`.
- Candidate families include Claude Sonnet first, then Gemini Flash/Lite or
  DeepSeek as cheaper extraction baselines.
- Final selection should be based on measured Nocheh eval results, not brand.

If Anthropic Sonnet is selected later:

```bash
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=<explicit-approved-sonnet-model-id>
```

Restart after changing provider env.

## Backups

SQLite lives at:

```text
./data/nocheh.sqlite
```

Back up:

```bash
mkdir -p backups
cp data/nocheh.sqlite "backups/nocheh-$(date +%Y%m%d-%H%M%S).sqlite"
```

Important:

- Keep `LOCAL_ENCRYPTION_SECRET` stable.
- If the encryption secret changes, encrypted payloads become unreadable.
- Back up `.env` securely, especially the encryption secret and tunnel token.

## Updating

```bash
git pull
npm test
npm run test:web
docker compose --profile tunnel up -d --build
```

If running without tunnel:

```bash
docker compose up -d --build
```

## Troubleshooting

Dashboard does not load:

```bash
docker compose logs -f nocheh
curl http://127.0.0.1:3000/health
```

Telegram messages do not appear:

- Check webhook URL is public HTTPS.
- Check bot is in the group.
- Check Telegram privacy mode if group messages are missing.
- Check `/app` setup status.
- Check `docker compose logs -f nocheh`.

No AI-like suggestions:

- This is expected while provider is disabled.
- Rule-based graph/suggestions still work for supported patterns.
- Do not enable provider until model research is complete.

Notion sync fails:

- Local tasks still persist.
- Configure `NOTION_MCP_COMMAND` and `NOTION_DATABASE_ID` only if you want
  Notion sync.

Graphify:

```bash
npm run graphify:update
```

## Verification Commands

Before using or deploying:

```bash
npm test
npm run test:web
npm run build:all
```

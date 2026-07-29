# Deploy

Target: one small VPS, Docker, SQLite on a mounted volume, Cloudflare Tunnel for
public HTTPS. Same image runs locally.

## 1. Configure

```bash
cp .env.example .env
```

Required:

```bash
LOCAL_ENCRYPTION_SECRET=<long, stable, never rotate casually>
APP_AUTH_USERNAME=<username>
APP_AUTH_PASSWORD=<strong-password>
```

Public HTTPS deploys also need:

```bash
CLOUDFLARE_TUNNEL_TOKEN=<tunnel-token>
APP_AUTH_SECURE_COOKIE=true
```

Optional AI provider (blank `AI_PROVIDER` = dry-run):

```bash
AI_PROVIDER=nvidia
NVIDIA_API_KEY=nvapi-...
```

Optional bot allow-lists — when either is set, the webhook drops everything else:

```bash
TELEGRAM_ALLOWED_CHAT_IDS=-1001234567890
TELEGRAM_ALLOWED_USER_IDS=123456789
```

## 2. Run

Local, built image (app only, no tunnel):

```bash
docker compose up -d --build          # http://127.0.0.1:3000/app
HOST_PORT=8080 docker compose up -d --build
```

VPS, with tunnel ingress:

```bash
docker compose --profile tunnel up -d --build
```

Route the Cloudflare Tunnel hostname to `http://nocheh:3000`. The app port is
bound to `127.0.0.1` on the host, so the tunnel is the only public path.

Local dev with hot reload (Vite HMR + `tsc --watch`):

```bash
docker compose -f docker-compose.dev.yml up --build
# UI  http://127.0.0.1:5173/app   (proxies /api to the backend)
# API http://127.0.0.1:3000
```

Without Docker:

```bash
npm install && npm run build:all && npm run dev
```

## 3. First Run

1. Open `/app`, log in with `APP_AUTH_*`.
2. **Setup** — confirm encryption is configured, pick the provider, paste the key,
   save, then restart the app (`docker compose up -d`).
3. **Connect bot** — paste the BotFather token, set the webhook to
   `https://<hostname>/telegram/webhook`, save allow-lists.
4. Add the bot to the group. Disable Telegram privacy mode if group messages
   never arrive.
5. **Settings** — `batch` for real groups, `immediate` for testing.
6. Send a message, or use **Simulator**.
7. Check **Conversations** for the audit trace and **Knowledge graph** for output.

Verify:

```bash
docker compose ps
docker compose logs -f nocheh
curl http://127.0.0.1:3000/health
```

## Provider and Cost

Default: NVIDIA API Catalog, `z-ai/glm-5.2` (key from
<https://build.nvidia.com/z-ai/glm-5.2>). OpenAI-compatible endpoint, 1M context,
`response_format: json_object` for the structured analysis contract.

Alternative behind the same port:

```bash
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=<explicit-model-id>
```

Cost rules:

- Keep `MESSAGE_ANALYSIS_MODE=batch`. Windows drive calls, not messages.
- `MAX_AI_OUTPUT_TOKENS` caps output; truncation fails loudly.
- Watch `aiTokenUsage` (provider, model, token counts per run) in the pipeline
  trace before widening usage.
- Reasoning behind the choice: `docs/research/0003-model-selection-cost-reasoning.md`.

## Import Telegram History

Bots cannot read old group history. Export the group as JSON from Telegram
Desktop, then paste it into **Import history**. Nocheh chunks, redacts, and
processes it into structured memory. Do not import sensitive exports before you
trust the redaction policy in **Settings**.

## Backup

```bash
mkdir -p backups
cp data/nocheh.sqlite "backups/nocheh-$(date +%Y%m%d-%H%M%S).sqlite"
```

Back up `.env` separately. **If `LOCAL_ENCRYPTION_SECRET` changes, every
encrypted payload becomes unreadable.**

## Update

```bash
git pull
npm test && npm run test:web
docker compose --profile tunnel up -d --build   # drop --profile locally
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `/app` blank or 404 | `web/dist` was not built: `npm run build:all` (Docker builds it) |
| All `/api/*` return 503 | `APP_AUTH_USERNAME` / `APP_AUTH_PASSWORD` unset |
| No Telegram messages | Public HTTPS webhook, bot in group, privacy mode, allow-lists, `docker compose logs -f nocheh` |
| No analysis output | **Setup** shows provider not ready, or boot log warns about missing env; restart after saving; check the `analysis` step in the trace |
| Notion sync failed | Tasks still persist locally; set `NOTION_MCP_COMMAND` and `NOTION_DATABASE_ID` only if you want sync |

## Limits

- Suggestions are approved through the API, not yet through UI buttons.
- Nocheh never sends Telegram messages; it only ingests.
- Crypto support is decision support. No auto-trading, ever.

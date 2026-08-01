# Deploy

Target: one small VPS, Docker, SQLite on a mounted volume, Cloudflare Tunnel for
public HTTPS. Same image runs locally.

## Bootstrap

Two manual things first, because neither can be scripted:

1. **Cloudflare Tunnel token.** one.dash.cloudflare.com → Networks → Tunnels →
   Create a tunnel → Cloudflared. Copy the token out of the install command.
   Then Public Hostname → your subdomain → Service type **HTTP**, URL
   `nocheh:3000` (the compose service name; cloudflared resolves it on the
   internal network). Do not put a Cloudflare Access policy on that hostname, or
   Telegram's webhook POSTs get blocked.
2. **Bot token.** Telegram → @BotFather → `/newbot`, then
   `/mybots → Bot Settings → Group Privacy → Turn off`. Privacy must be off or
   the bot only sees messages that mention it.

Then, on the VPS:

```bash
git clone <repo> ~/nocheh && cd ~/nocheh
bash scripts/bootstrap.sh
```

It installs Docker and the compose plugin, adds swap when RAM is under ~2 GB,
optionally enables ufw (allowing the SSH ports it finds), writes `.env` with
freshly generated secrets, starts the stack behind the tunnel, waits for
`/health`, then validates the bot token and registers the webhook. It prompts
only for the things above plus a username and an AI key.

Safe to re-run: existing secrets are never regenerated, and previous answers
become the prompt defaults.

```bash
bash scripts/bootstrap.sh --help
bash scripts/bootstrap.sh --bot-only        # only re-register the webhook
bash scripts/bootstrap.sh --env-only        # only write .env (no Docker)
bash scripts/bootstrap.sh --skip-system     # Docker already set up
```

Unattended, every answer from the environment:

```bash
APP_AUTH_USERNAME=owner \
PUBLIC_HOSTNAME=nocheh.example.com \
CLOUDFLARE_TUNNEL_TOKEN=... \
AI_PROVIDER=nvidia NVIDIA_API_KEY=nvapi-... \
TELEGRAM_BOT_TOKEN=... \
bash scripts/bootstrap.sh --non-interactive
```

Without a terminal and without `--non-interactive` the script fails instead of
writing a half-configured `.env`.

## Manual Setup

Skip this if `scripts/bootstrap.sh` worked.

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
PUBLIC_HOSTNAME=<hostname routed by the tunnel>
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

## Run

Local, built image (app only, no tunnel):

```bash
docker compose up -d --build          # http://127.0.0.1:3000/app
HOST_PORT=8080 docker compose up -d --build
```

VPS, with tunnel ingress:

```bash
docker compose --profile tunnel up -d --build
```

The app port is bound to `127.0.0.1` on the host, so the tunnel is the only
public path. `.env` must exist before `up`: it is bind-mounted into the container
so config the dashboard writes survives rebuilds, and Docker would otherwise
create a directory in its place.

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

## First Run

The bootstrap script covers steps 1–3. What is left:

1. Open `/app`, log in with `APP_AUTH_*`.
2. **Setup** — confirm encryption is configured and the provider is ready.
3. **Connect bot** — token and webhook `https://<hostname>/telegram/webhook`.
4. Add the bot to the group, with BotFather group privacy off.
5. Send a message, then read the chat id off the **Conversations** tab (the
   conversation id *is* the Telegram chat id) and paste it into the allow-list.
6. **Settings** — `batch` for real groups, `immediate` for testing.
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

Config the dashboard wrote (provider key, bot token) lives in the host `.env`
through the bind mount, so it survives the rebuild.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `/app` blank or 404 | `web/dist` was not built: `npm run build:all` (Docker builds it) |
| All `/api/*` return 503 | `APP_AUTH_USERNAME` / `APP_AUTH_PASSWORD` unset |
| Cannot log in over HTTPS | Correct is `APP_AUTH_SECURE_COOKIE=true`. Over a plain-HTTP forwarded port some browsers reject the Secure cookie; use the tunnel hostname |
| A `.env` **directory** appeared | `up` ran before `.env` existed. Remove it, create the file, start again |
| No Telegram messages | Public HTTPS webhook, bot in group, privacy mode, allow-lists, `docker compose logs -f nocheh` |
| Webhook 403 / Access denied | A Cloudflare Access policy covers the hostname; bypass `/telegram/webhook` |
| No analysis output | **Setup** shows provider not ready, or boot log warns about missing env; restart after saving; check the `analysis` step in the trace |
| Bot token gone after an update | The `./.env:/app/.env` mount is missing from `docker-compose.yml` |
| Build killed / OOM | Under ~2 GB RAM, add swap (the bootstrap script does this) |
| Notion sync failed | Tasks still persist locally; set `NOTION_MCP_COMMAND` and `NOTION_DATABASE_ID` only if you want sync |

## Limits

- Suggestions are approved through the API, not yet through UI buttons.
- Nocheh never sends Telegram messages; it only ingests.
- Crypto support is decision support. No auto-trading, ever.

# ADR-0009: Scripted Bootstrap and `.env` as the Deployment Source of Truth

## Status

Accepted

## Context

ADR-0005 established a Docker Compose VPS deployment with SQLite on a mounted
volume and Cloudflare Tunnel ingress. ADR-0006 added a dashboard that writes
configuration — provider keys, the Telegram bot token, allow-lists — through
`EnvStorePort` into `.env`.

Two problems appeared when deploying that combination for real.

**Config written by the dashboard did not survive a rebuild.** `DotenvFileStore`
targets `<cwd>/.env`, which is `/app/.env` inside the container. `.dockerignore`
excludes `.env`, so the file never existed in the image, and nothing mounted it.
Writes landed in the container's writable layer and disappeared on every
`docker compose up -d --build`. `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_URL`
are not in the compose `environment:` block, so they had no other home at all:
after an update the dashboard reported the bot as disconnected, while Telegram
kept delivering to a webhook the app could no longer describe.

**First deployment was a long manual sequence.** Docker install, swap, firewall,
secret generation, `.env` editing, tunnel wiring, `setWebhook` registration. Each
step is individually simple and collectively easy to get wrong, and the
irreversible one — `LOCAL_ENCRYPTION_SECRET` — is the easiest to treat casually.

## Decision

**Bind-mount the host `.env` into the container** (`./.env:/app/.env`). One file
is the source of truth for both compose interpolation and the app's own reads and
writes. This works in both directions because `DotenvFileStore` uses `writeFile`,
which truncates in place and preserves the inode, and because the dotenv loader
already refuses to let empty compose-injected variables shadow file values.

Any tooling that edits `.env` must also write in place. Replacing the file with
`mv` would give it a new inode and silently detach the running container from
further updates.

**Add `scripts/bootstrap.sh`** as the documented deployment entry point. It is
the composition root for provisioning, the way `src/dev-server.ts` is for the
runtime:

- installs Docker Engine and the compose plugin on apt-based hosts
- adds swap below ~2 GB RAM, where the TypeScript and Vite builds get OOM-killed
- optionally enables ufw, allowing the SSH ports found in `sshd_config`
- creates `.env` and generates every secret that can be generated
- prompts only for what cannot be: username, AI key, tunnel token, public
  hostname, bot token
- starts the stack and waits on `/health`
- validates the bot token with `getMe` and registers the webhook with the same
  `allowed_updates` as `TelegramHttpClient.setWebhook`

Constraints the script holds to:

- **Idempotent.** Existing secrets are never regenerated; previous answers become
  the prompt defaults. Re-running is the normal way to add the bot later.
- **Explicit about terminals.** Prompts read from the terminal, not from stdin's
  data. `/dev/tty` is opened rather than tested with `-r`, because it exists but
  is unopenable without a controlling terminal (`ssh host 'bash bootstrap.sh'`).
  With no terminal and no `--non-interactive`, it fails instead of writing a
  half-configured `.env`.
- **Nothing is saved on failure.** A rejected bot token is not persisted.

`PUBLIC_HOSTNAME` is added to `.env` so re-runs can rebuild the dashboard and
webhook URLs without asking again.

## Consequences

Positive:

- Configuration written in the dashboard survives `git pull && up -d --build`.
- One `.env` instead of two divergent copies of the same keys.
- A fresh VPS reaches a working, HTTPS-reachable, bot-connected deployment from
  `git clone` plus one command.
- Secrets are generated rather than invented, and `LOCAL_ENCRYPTION_SECRET` is
  created once and reported as irreversible.
- `APP_AUTH_SECURE_COOKIE` follows from whether a public hostname exists, instead
  of being a separate thing to remember.

Tradeoffs:

- `.env` must exist before `docker compose up`, or Docker creates a directory in
  its place. The script guarantees this; the compose file and deploy guide say so.
- The bootstrap script is Ubuntu/Debian-specific for system preparation. Other
  hosts skip that phase and keep the `.env` and compose steps.
- Provisioning logic now lives in shell, outside the TypeScript test suite. It is
  kept shellcheck-clean and verified by running it.
- Mounting `.env` means the container can write a host file. Acceptable for a
  single-owner deployment where the dashboard is already trusted with secrets.

## Guardrails

- Never regenerate `LOCAL_ENCRYPTION_SECRET` for an existing deployment.
- Edit `.env` in place. Never `mv` a replacement over it while containers run.
- Keep `.env` gitignored and mode 600. Back it up separately from the database,
  and never commit it.
- Keep secrets out of `docker-compose.yml`; interpolate them from `.env`.
- Keep the script's `allowed_updates` in sync with
  `TelegramHttpClient.setWebhook`; reactions are not delivered otherwise.
- The script may configure and start. It must not create Cloudflare or Telegram
  resources on the owner's behalf beyond registering the webhook it was given.

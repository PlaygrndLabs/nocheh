# Local Compose operations

Local Docker Compose is the current target. It is used for normal unattended
operation, development and acceptance. No VPS is required.

## Start and develop

```bash
./scripts/nocheh up
./scripts/nocheh status
./scripts/nocheh dev
```

`up` builds pinned images, starts PostgreSQL before its dependents, and waits for
service health. Services restart automatically while the Docker engine is running.
Docker must itself be configured to start at login/boot for unattended operation.

`dev` overlays `docker-compose.dev.yml`. TypeScript source changes synchronize into
the development images, rebuild and restart affected services. Python integration
changes restart Hermes. Dependencies and Dockerfile changes rebuild images.
Both modes use the same persistent database, files, spool and Hermes state.
See Docker's [Compose Watch](https://docs.docker.com/compose/how-tos/file-watch/)
and [startup ordering](https://docs.docker.com/compose/how-tos/startup-order/) docs.

## Configuration and credentials

Bootstrap is idempotent: it creates missing secrets, never regenerates existing
ones. The old repository `.env` is not used by this stack.

| Path | Purpose |
| --- | --- |
| `data/local/compose.env` | UID/GID, host port, model and guard mode |
| `data/local/secrets/database_password` | PostgreSQL password |
| `data/local/secrets/service_token` | Internal service and owner API authentication |
| `data/local/hermes/` | Hermes-owned subscription login and native runtime state |
| `data/local/files/` | Original attachment bytes |
| `data/local/spool/` | Durable capture and retry data |
| `data/local/reports/` | Local validation reports |
| Compose `postgres_data` volume | Nocheh archive database |

The host port defaults to 8780, bound only to loopback. PostgreSQL has no host port,
so it can coexist with other local databases. Service credentials are Compose
secrets, not command-line arguments. Runtime data and credentials are ignored by Git.

The bootstrap transfers the dedicated Phase 1 login into the runtime once. It does
not share the Codex desktop application's token store. For a new login:

```bash
./scripts/nocheh login
./scripts/nocheh verify
```

If requested by OpenAI, enable device-code authorization in ChatGPT Security
settings, then restart login for a fresh code. Verification uses only synthetic
input; it consumes subscription quota. It exercises token refresh, native chat,
literal detection and Ogg/Opus transcription inside the running Hermes container.

## Daily commands

```bash
./scripts/nocheh test
./scripts/nocheh logs archive
./scripts/nocheh status
./scripts/nocheh down
./scripts/nocheh up
```

`down` retains all persistent state. Do not add `--volumes` unless intentionally
resetting the database. Direct Compose commands must use the generated env file:

```bash
docker compose --env-file data/local/compose.env ps
```

For an isolated rehearsal, set `NOCHEH_STATE_DIR` to a separate absolute directory
and `COMPOSE_PROJECT_NAME` to a separate project name. A fresh environment requires
its own login; do not duplicate a refresh token between concurrently running stacks.

## Later VPS deployment

Use the same Compose files and scripts on a Linux host with Docker and Python 3.
Transfer owned data using backup/restore, assign the proper host UID/GID, and run
container acceptance there before enabling the bot. Keep the API on loopback unless
an authenticated transport is intentionally configured. VPS provisioning and its
live checks are deferred until a server exists.

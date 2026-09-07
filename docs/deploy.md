# Local Compose operations

Local Docker Compose is the current target. It is used for normal unattended
operation, development and acceptance. No VPS is required.

## Start and develop

```bash
./scripts/nocheh up
./scripts/nocheh status
./scripts/nocheh diagnose
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
| `data/local/assistant.json` | Disabled by default; owner ID and selected Telegram groups |
| `data/local/secrets/database_password` | PostgreSQL password |
| `data/local/secrets/service_token` | Internal service and owner API authentication |
| `data/local/secrets/telegram_bot_token` | Bot token; empty until locally configured |
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

## Backup and restore

```sh
./scripts/nocheh backup --output data/backups/my-snapshot
./scripts/nocheh restore data/backups/my-snapshot \
  --state data/restored --project nocheh-restored --port 8795
```

Backup stops Telegram ingress first, then archive writers. It takes a PostgreSQL
custom-format dump and copies the file store, durable spool, native Hermes state,
configuration and credentials while those writers are stopped. It records file
checksums and deterministic fingerprints of all eight archive tables, then
restarts the previously running services. Backups are private local directories
under ignored `data/backups/`; they contain original data and credentials. Keep
their access permissions when copying them. Generated plugin symlinks are recorded
and recreated by the integration; unknown state symlinks fail the backup.

Restore requires a new state directory and a new Compose database volume. It
validates every saved file before extraction, restores the database, compares all
table fingerprints, and starts the same images. Unsafe archive paths, links,
missing files and checksum mismatches fail validation. A report is written under
the restored state's `reports/` directory. The restored Telegram policy is
disabled and the saved OAuth file is held as `hermes/auth.restore-pending.json`.
No second bot or refresh owner is activated by the rehearsal.

For a planned cutover, use `backup --leave-stopped` to keep the source writers
stopped after its final snapshot. On the restored project, obtain a fresh dedicated
login and re-enable the saved Telegram policy only after verifying the source is
stopped. Commands for the restored project use both environment variables:

```sh
NOCHEH_STATE_DIR="$PWD/data/restored" COMPOSE_PROJECT_NAME=nocheh-restored ./scripts/nocheh diagnose
NOCHEH_STATE_DIR="$PWD/data/restored" COMPOSE_PROJECT_NAME=nocheh-restored ./scripts/nocheh login
```

Review `restored-assistant-policy.json` before copying it to `assistant.json` and
running `up` with those same variables. When recovering an older backup, reconcile
pending replies/actions against what happened after that snapshot before enabling
Telegram. A backup cannot know about deliveries made after it was taken. Ordinary
restarts use durable delivery receipts and never automatically resend ambiguous
results. Restore is deliberately inactive until the owner resolves that gap.

## Pauses, backlogs and release checks

`diagnose` shows container health, subscription-login presence, Telegram state,
service heartbeats and archive job counts. `healthy` describes service availability;
it does not mean credentials are configured or a quota-limited model can answer.

Archive capture precedes inference. Database outages leave updates in the durable
spool; retries commit them idempotently after recovery. Attachment and transcription
failures retain their source and failure state. Quota failures pause work for retry;
they do not enable paid-provider fallback. Required guard failures send zero
requests to the protected destination. Unknown outbound outcomes stay ambiguous.
Action receipt polling backs off for 30 seconds after an uncertain RPC response.

Release evidence is tracked in [TASK.md](../TASK.md). The container tests cover
database recovery, duplicate delivery, quota pauses, guard failure, scoped reads,
replay suppression and approval boundaries. Actual Telegram DM/group/voice,
intentional silence, approved delivery and reconnect checks remain required before
cutover and merging. The Honcho live comparison is an optional separate experiment.

## Later VPS deployment

Use the same Compose files and scripts on a Linux host with Docker and Python 3.
Transfer owned data using backup/restore, assign the proper host UID/GID, and run
container acceptance there before enabling the bot. Keep the API on loopback unless
an authenticated transport is intentionally configured. VPS provisioning and its
live checks are deferred until a server exists.

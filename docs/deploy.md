# Local Compose operations

[SPECS.md](../SPECS.md) defines the product; [TASK.md](../TASK.md) records actual
activation and pending acceptance. This guide describes operating procedures.

Local Docker Compose is used for normal unattended operation, development, and
acceptance. An existing VPS checkout can receive the same app-service rollout;
remote acceptance remains a separate observation.

## Deploy an app revision

Use the full commit ID from integrated `main`. The default command prints a
read-only plan. `--apply` builds and replaces only `nocheh-app`, then waits for
its health check. The local checkout must be clean, contain its installation
`.env`, and own exactly one running app container.

```bash
./bin/nocheh deploy local --revision FULL_COMMIT_ID
./bin/nocheh deploy local --revision FULL_COMMIT_ID --apply
```

For an existing VPS checkout, supply its SSH destination and absolute checkout
path. The command requires a clean remote `main`, fetches `origin/main`, checks
that the revision is on it, fast forwards to exactly that revision, then runs
the same local app rollout there. It uses noninteractive SSH and does not copy
credentials or state. The target requires Git, Docker Compose, access to its
own `.env`, and a running Nocheh app in that checkout.

```bash
./bin/nocheh deploy vps --host USER@HOST --root /absolute/nocheh --revision FULL_COMMIT_ID
./bin/nocheh deploy vps --host USER@HOST --root /absolute/nocheh --revision FULL_COMMIT_ID --apply
```

After either apply, inspect health and the relevant read-only admin command
from that installation. Record the revision and evidence in `TASK.md`; service
health does not complete live release gates. See [ADR-0067](adr/0067-exact-revision-app-rollout.md).

See [service names, responsibilities, dashboards and workflow](services.md).
Host services require Node 24.x; set `NOCHEH_NODE` when selecting a non-default executable.

## Start and develop

```bash
./bin/nocheh up
./bin/nocheh status
./bin/nocheh diagnose
make dev
make dev-status
make dev-stop
```

`up` builds pinned images, starts PostgreSQL before its dependents, and waits for
service health. Services restart automatically while the Docker engine is running.
Docker must itself be configured to start at login/boot for unattended operation.

If a development checkout was archived while its `nocheh-dev` volumes remain,
stop its orphaned containers without deleting volumes. A replacement checkout
can use a copied, credential-free dev state after its database roles are checked
against that state. Record the exact absent former checkout path in the ignored
`data/dev/.adopted-volume-owner` file with mode 0600. The dev launcher then
accepts only volumes bearing that checkout label; it still rejects a present
former checkout or any other volume owner. When Compose offers to recreate a
retained volume, choose **No** to preserve its data. Keep the operating
installation's state and credentials separate.

Stop the operating Nocheh project before `make dev`; the command refuses to
run a second Nocheh stack. `make dev` uses the `nocheh-dev` project and normal
localhost ports, with checkout-owned images, networks, credentials, and state.
It starts PostgreSQL, app, dashboard, executor, security, Hermes, speech,
provider, monitor, workflow services, and Honcho. The existing app container
mounts source read-only and compiles changed TypeScript, React, CSS, and plugin
assets into shared volumes. Node watches generated code, the dashboard reloads
when its asset revision changes, and Python processes restart automatically on
mounted source edits. Ordinary source edits need no `make dev` rerun or Docker
image rebuild; dependency and Dockerfile edits still need one. Locally available
Hermes and provider base images must match the pinned revisions. Telegram stays
disabled and no installation login is imported. External model and embedding
calls require separate development credentials. `make dev-stop` stops only
the development project and retains its state. Release acceptance uses
`./bin/nocheh up` separately.
See Docker's [startup ordering](https://docs.docker.com/compose/how-tos/startup-order/)
documentation.

## Configuration and credentials

Run `./bin/nocheh init`, edit the root `.env`, then run `./bin/nocheh up`.
Initialization fills missing internal passwords; existing passwords stay unchanged.
Only variables explicitly listed in Compose enter each service. The wrapper reads
literal values without shell expansion and gives this file precedence over stale
shell exports. Keep values on one line; single quotes preserve `$` and `#`.

| Setting or path | Purpose |
| --- | --- |
| `.env` | Model, optional guard, port, Telegram settings and internal passwords |
| `.env.example` | Committed template without credentials |
| `data/local/hermes/` | Hermes profiles, memory and sessions; native login active before shared cutover and inactive afterward |
| `data/local/provider/auth/` | CLIProxyAPI-owned OAuth login; its only active refresh store after cutover |
| `data/local/provider/monitor/` | CPA Manager Plus request and usage history |
| `data/local/files/` | Original attachment bytes |
| `data/local/spool/` | Durable capture and retry data |
| `data/local/reports/` | Local validation reports |
| Compose `postgres_data` volume | Nocheh archive database |

`TELEGRAM_ENABLED` defaults to `false`. Configure `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_OWNER_ID` and comma-separated negative `TELEGRAM_GROUP_IDS` before enabling.
`NOCHEH_GUARD_MODE` is `on` (default) or `off`; legacy `auto` values convert to
`on`. Explicit trusted endpoints are a JSON array in `NOCHEH_GUARD_TRUSTED_ENDPOINTS`.
Trust does not bypass guarded representation selection when guarding is on. See
[guarded-copy operations](guard.md).
The API binds only to loopback; PostgreSQL has no host port.

The `.env` is ignored by Git, excluded from image builds and written with mode 0600.
Environment values are visible to someone who can inspect Docker containers. The
previous file-based Compose secrets were another storage choice, not encrypted
storage or an architectural requirement. CLIProxyAPI owns the only active OAuth
store after shared-provider cutover. See [ADR-0024](adr/0024-single-environment-configuration.md)
and [shared provider operations](provider.md).

The one-time configuration update preserves the old root `.env` privately in
`data/local/previous-configuration/legacy.env`; unrelated provider keys are not
imported. Existing rebuild database and service credentials are retained.

The bootstrap may retain the dedicated Phase 1 Hermes login as a rollback before
cutover. It does not share the Codex desktop application's token store. For the
single shared login and guarded cutover:

```bash
./bin/nocheh provider login
./bin/nocheh provider cutover
```

If requested by OpenAI, enable device-code authorization in ChatGPT Security
settings, then restart login for a fresh code. Verification uses only synthetic
input and consumes subscription quota. It checks single-owner refresh behavior,
Hermes and Honcho reasoning, literal detection, Ogg/Opus transcription, monitoring,
monitor failure isolation and restart recovery.

## Daily commands

```bash
./bin/nocheh test
./bin/nocheh logs nocheh-app
./bin/nocheh status
./bin/nocheh down
./bin/nocheh up
```

`down` retains all persistent state. Do not add `--volumes` unless intentionally
resetting the database. Direct Compose reads the root `.env` too; prefer the wrapper for validation and isolated state:

```bash
docker compose ps
```

For an isolated rehearsal, set `NOCHEH_STATE_DIR` to a separate absolute directory
and `COMPOSE_PROJECT_NAME` to a separate project name. A fresh environment requires
its own `.env` in that state directory and its own login; do not duplicate a refresh token between concurrently running stacks.

## Backup and restore

```sh
./bin/nocheh backup --output data/backups/my-snapshot
./bin/nocheh restore data/backups/my-snapshot \
  --state data/restored --project nocheh-restored --port 8795
```

Backup stops Telegram ingress first, then archive and provider writers. It takes a PostgreSQL
custom-format dump and copies the file store, durable spool, native Hermes state and
separate dashboard preferences,
provider OAuth/monitor state, configuration and credentials while those writers are stopped. It records file
checksums and deterministic fingerprints of archive, policy, receipt and workflow
tables. Version 5 also includes Honcho database fingerprints, a database dump,
protected configuration and the embedding spending ledger. Honcho cache is rebuildable. It then
restarts the previously running services. Backups are private local directories
under ignored `data/backups/`; they contain original data and credentials. Keep
their access permissions when copying them. Generated plugin symlinks are recorded
and recreated by the integration. Native `.cache/uv` dependency caches are recorded
as excluded and rebuilt when needed; other unknown state symlinks fail the backup.

Restore requires a new state directory and a new Compose database volume. It
validates every saved file before extraction, restores the database, compares all
table fingerprints, and starts the same images. Unsafe archive paths, links,
missing files and checksum mismatches fail validation. A report is written under
the restored state's `reports/` directory. The restored Telegram policy is
disabled; saved native and shared OAuth files are held outside their active paths.
`spool/.restore-inactive`, `admin/tools/inactive` and `hermes/scheduler-inactive`
hold archive workers, controlled tools and scheduled runs. No second bot, executor
or refresh owner is activated by the rehearsal. Diagnostics expose these holds.

For a planned cutover, use `backup --leave-stopped` to keep the source writers
stopped after its final snapshot. First reconcile pending work against deliveries
and receipts after the snapshot; verify the source is stopped. Commands for the
restored project use both environment variables:

```sh
NOCHEH_STATE_DIR="$PWD/data/restored" COMPOSE_PROJECT_NAME=nocheh-restored ./bin/nocheh diagnose
```

Only after reconciliation and an approved cutover should the operator remove the
execution holds, including `workflows/inactive`,, obtain a fresh dedicated login, review `restored.env`, enable
the intended policy and restart using those same variables. This is intentionally
not automated. A backup cannot know about deliveries made after it was taken. Ordinary
restarts use durable delivery receipts and never automatically resend ambiguous
results. Restore is deliberately inactive until the owner resolves that gap.

## Portable archive and memory

Maintenance → **Export archive and memory** creates an authenticated ZIP download.
The same export is available without the dashboard:

```sh
./bin/nocheh export --output data/exports/my-portable-copy
```

The destination must be new. `archive/` preserves the existing NDJSON/file replay
format with originals and derived provenance. `native/` contains registered
profiles' exact notes, scope markers and consistent SQLite copies, including
committed WAL state. The completion manifest includes sizes and SHA-256 hashes.
Operational auth/configuration files are excluded; secrets typed into conversations
remain part of those original conversations. This read-only export is not one
global snapshot and does not include every setting, policy or retired custom
profile. Use a full backup for installation recovery.

## Hermes updates and rollback

```sh
./bin/nocheh compatibility status
./bin/nocheh compatibility check
./bin/nocheh compatibility check --revision FULL_40_CHARACTER_COMMIT
```

Candidates build into separate image tags with no production state mounts or
provider credentials. Native contract tests run without network on a read-only
filesystem; the native dashboard must build against the candidate. Private reports
are under `data/local/reports/compatibility/`. These commands never update the pin
or activate an image. Native self-update is not an alternate update mechanism.

For an update, review upstream changes and compatibility anchors, update the saved
pin and adapter metadata together, run the full regression suite and the candidate
check, then rehearse a backup in a separate inactive project. Save the previous
code revision and image IDs before changing live images. Subscription and
[real Telegram acceptance](release-acceptance.md) still apply; an offline pass is
not permission to cut over. For rollback, use the matching prior code/images and
a verified snapshot in a new inactive project. Never downgrade a live database
in place or activate copied pending actions without reconciliation.

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
release. Git integration has its own verification gates.

## Later VPS deployment

Use the same Compose files and scripts on a Linux host with Docker, Python 3 and Node 24.x.
Transfer owned data using backup/restore, assign the proper host UID/GID, and run
container acceptance there before enabling the bot. Keep the API on loopback unless
an authenticated transport is intentionally configured. VPS provisioning and its
live checks are deferred until a server exists.

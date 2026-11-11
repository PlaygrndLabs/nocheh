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
Host services require Node 26.x; set `NOCHEH_NODE` when selecting a non-default executable.

## Start and develop

```bash
./bin/nocheh up
./bin/nocheh status
./bin/nocheh diagnose
make dev
make dev-build
make dev-status
make dev-stop
```

`up` builds pinned images, starts PostgreSQL before its dependents, and waits for
service health. Services restart automatically while the Docker engine is running.
Docker must itself be configured to start at login/boot for unattended operation.

`make dev` combines root `docker-compose.yml` with `docker-compose.dev.yml`.
The base file directly defines the archive, derived, control, and workflow stores.
Compose creates owned volumes on a clean installation; normal restarts retain
them. `./bin/nocheh init`, which `up` also runs, saves the Honcho volume names in
`.env`, and `make dev` refuses to start without them. Development uses the configured Telegram bot, model providers, and settings
in the single `nocheh` project on normal localhost ports. Stop unattended services
first and verify exclusive Telegram polling.
The launcher refuses another running Nocheh project or
an active unattended stack. It starts PostgreSQL, app, dashboard, executor,
machines, security, Hermes, workflow services, Honcho, and the mini app with its tunnel when set up.
The existing app container mounts source from the session checkout read-only
and compiles changed TypeScript, React, CSS, and plugin assets into separate
generated-code volumes. Node watches generated code, the dashboard reloads when
its asset revision changes, and Python processes restart automatically on
mounted source edits. PostgreSQL reruns store provisioning from each finished
app build, so new tables arrive with the code that reads them. Ordinary source
edits, including store schema changes, need no `make dev` rerun or Docker image
rebuild; `make dev-build` rebuilds images after dependency or Dockerfile edits. `make dev` builds only when its development images are absent. Pinned Hermes
and Honcho base image revisions are checked before startup; when a pin has moved,
`make dev` first runs `./bin/nocheh build` and then points its development tags at
the new pinned images. The watched services also come back by themselves after
Docker or the computer restarts; they keep running the last compiled code until
`make dev` runs again and resumes watching. `make dev-stop`
stops the watched project without deleting the operating volumes or state;
`./bin/nocheh up` from the operating checkout resumes unattended operation.
Development health does not replace live release acceptance.
See Docker's [startup ordering](https://docs.docker.com/compose/how-tos/startup-order/)
documentation.

<activation_verification>

Source watching compiles application code; it does not apply database schema or
view definitions. Activate a tested database change separately under the owned
installation's database owner role, preserve its previous definition in ignored
local evidence, and verify the actual catalog definition and affected read path.
Compiled source and a healthy service alone do not establish schema activation.
The database image runs its bundled store bootstrap again on startup. Rebuild
that image from the verified source after a schema or view change; otherwise a
later restart can restore an older definition over a manually activated repair.
Check both the image's bundled schema and the live catalog after restart.

Isolated native turns load code from the image selected when their launcher
starts. After changing a helper used inside those turns, verify the exact image
contains the tested helper and that the launcher has loaded that image. Mounted
parent source alone does not establish the child runtime's revision.

</activation_verification>

## Configuration and credentials

Run `./bin/nocheh init`, edit the root `.env`, then run `./bin/nocheh up`.
Initialization fills missing internal passwords; existing passwords stay unchanged.
Only variables explicitly listed in Compose enter each service. The wrapper reads
literal values without shell expansion and gives this file precedence over stale
shell exports. Keep values on one line; single quotes preserve `$` and `#`.

| Setting or path | Purpose |
| --- | --- |
| `.env` | Model providers and keys, optional guard, port, Telegram settings and internal passwords |
| `.env.example` | Committed template without credentials |
| `data/local/hermes/` | Hermes profiles, memory and sessions |
| `data/local/files/` | Original attachment bytes |
| `data/local/spool/` | Durable capture and retry data |
| `data/local/reports/` | Local validation reports |
| `data/local/machines/` | SSH keys and trusted host keys of the owner's machines; used only by `nocheh-machines`, never backed up, and erased by a reset with the machines |
| Compose `postgres_data` volume | Nocheh archive database |

`TELEGRAM_ENABLED` defaults to `false`. Configure `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_OWNER_ID` and comma-separated negative `TELEGRAM_GROUP_IDS` before enabling.
`NOCHEH_GUARD_MODE` is `on` (default) or `off`; legacy `auto` values convert to
`on`. See [guarded-copy operations](guard.md).
`NOCHEH_BOX_IMAGE`, `NOCHEH_BOX_LIMIT` and the generated `NOCHEH_BOX_TOKEN` set up
the sealed job box; see [the security service](security-service.md).
The generated `NOCHEH_MACHINE_TOKEN` lets `nocheh-app` ask `nocheh-machines` to run
jobs on the owner's machines; only those two services get it. It has at least 32
characters and differs from `SERVICE_TOKEN` and `NOCHEH_BOX_TOKEN`. `init`, `up` and
`make dev` generate it when it is missing. Without it, Settings › Machines says
machine control is unavailable and nothing else changes. `nocheh-machines` runs
from the management image, which carries the SSH client and a user for
`NOCHEH_UID`: `./bin/nocheh up` builds it, `make dev-build` rebuilds it for
`make dev`, and after `NOCHEH_UID` changes it needs a rebuild, or the service
reports unhealthy because `ssh` cannot run. On each machine, give Nocheh a login
of its own with bash as its shell and `ps` (procps) installed, so Stop can end its
programs. For a VM on the same computer, use `host.docker.internal`, not `localhost`:
`nocheh-machines` connects from its own container. On Linux, `host.docker.internal`
reaches the host through Docker's host gateway; a host firewall can still block it.
An address, port or login changes with Edit in Settings › Machines; the machine then
needs a new Test, and its key stays. See
[ADR-0231](adr/0231-owner-approved-jobs-work-on-the-owners-machines-over-ssh.md).
Settings › Telegram › Mini app saves the mini app address and tunnel token; with both set and Telegram on,
`up` also starts `nocheh-miniapp` and `nocheh-tunnel`. See [Telegram](telegram.md#mini-app).
The API binds only to loopback; PostgreSQL has no host port.

The `.env` is ignored by Git, excluded from image builds and written with mode 0600.
Environment values are visible to someone who can inspect Docker containers. The
previous file-based Compose secrets were another storage choice, not encrypted
storage or an architectural requirement. See [ADR-0024](adr/0024-single-environment-configuration.md)
and [model providers](provider.md).

The one-time configuration update preserves the old root `.env` privately in
`data/local/previous-configuration/legacy.env`; unrelated provider keys are not
imported. Existing rebuild database and service credentials are retained.

A new installation has no model provider. Add one in Settings › Models (an
OpenAI or Anthropic API key, or a custom OpenAI-compatible HTTPS provider) and
apply; until then replies and memory work wait with `provider_not_configured`.

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

Backup stops Telegram ingress first, then archive writers. It takes a PostgreSQL
custom-format dump and copies the file store, durable spool, native Hermes state and
separate dashboard preferences,
configuration and credentials while those writers are stopped. It records file
checksums and deterministic fingerprints of archive, policy, receipt and workflow
tables. Version 5 also includes Honcho database fingerprints, a database dump,
protected configuration and the embedding spending ledger. Honcho cache is rebuildable. It then
restarts the existing containers for previously running services, including
the executor, without recreating them from the current checkout's Compose
image tags. Backups are private local directories
under ignored `data/backups/`; they contain original data and credentials. Keep
their access permissions when copying them. Generated plugin symlinks are recorded
and recreated by the integration. Native `.cache/uv` dependency caches are recorded
as excluded and rebuilt when needed; other unknown state symlinks fail the backup.

Restore requires a new state directory and a new Compose database volume. It
validates every saved file before extraction, restores the database, compares all
table fingerprints, and starts the same images. Unsafe archive paths, links,
missing files and checksum mismatches fail validation. A report is written under
the restored state's `reports/` directory. The restored Telegram policy is
disabled; a saved native Hermes login is held outside its active path.
`spool/.restore-inactive`, `admin/tools/inactive` and `hermes/scheduler-inactive`
hold archive workers, controlled tools and scheduled runs. No second bot, executor
or login is activated by the rehearsal. Diagnostics expose these holds.
Backups leave out the machines' keys in `machines/`. A restored installation keeps
its machines in Settings › Machines but not their keys. They still show Ready from
their last Test, but the next Test, command or cleanup fails with "Nocheh has no key
for this machine" (`machine_key_missing`), and from then on the machine shows Test
failed, so no new job can ask for it: remove each machine, add it again and put its
new public key on the machine.

The dashboard also backs up automatically once a day, by default at 04:00 UTC,
through the same path as System › Backups › Back up now. Settings › Privacy &
data turns this off or sets the time, time zone and number of automatic backups
kept (default 7). Older automatic backups are deleted; backups started by hand
are never deleted. A machine that was off at the set time backs up at the
dashboard's next five-minute check, and a backup is skipped while free disk
space is under twice the newest automatic backup (at least 1 GiB). Copies stay
on the same disk. See [ADR-0187](adr/0187-daily-automatic-backups.md).

To survive losing the machine, turn on Off-site copies in the same settings.
Each new automatic backup is then encrypted on this machine with your
passphrase and sent to storage you choose; the storage only ever holds
scrambled data. Keep the passphrase somewhere other than this machine:
without it no copy can be opened.

Pick the storage under Storage:

- **Cloudflare** (R2, free up to 10 GB): press Open Cloudflare, which opens
  Cloudflare's token page with the permissions already chosen. Create the token,
  paste it and press Connect. Nocheh makes its own bucket (`nocheh-backups`, or
  that name plus a random ending when the account already has one), locks each
  copy for 7 days so it can't be deleted early, keeps a key for that bucket only,
  tests it and deletes the setup token. If connecting stops with an error, the
  setup token stays so you can try again; delete "Nocheh setup" in Cloudflare's
  API tokens once you are done with it. Turn on R2 in Cloudflare first if you
  never used it.
- **Backblaze** (B2, free up to 10 GB): create a private bucket, set its
  Lifecycle Settings to "Keep only the last version" so removed copies free their
  space, and create an application key with Read and Write access to that bucket
  only. Paste the key ID and the key and press Connect. Nocheh reads the address
  and bucket from Backblaze and tests the key.
- **Other S3**: fill in the storage address, bucket, region and keys yourself.

Then type the passphrase and Save. See
[ADR-0236](adr/0236-off-site-storage-from-one-pasted-credential.md).

System › Backups shows the last copy, sends
one now, and tests that the newest copy opens and checks out. A copy is
written to this disk before upload, so it is skipped while free space is under
the backup's size plus 1 GiB. On a new machine, install the Python
`cryptography` package (for example `pip install cryptography`), then get a
backup folder back and restore it; the passphrase is asked for:

```sh
export NOCHEH_OFFSITE_ENDPOINT=https://… NOCHEH_OFFSITE_BUCKET=… NOCHEH_OFFSITE_REGION=… \
  NOCHEH_OFFSITE_ACCESS_KEY_ID=… NOCHEH_OFFSITE_SECRET_ACCESS_KEY=…
./bin/nocheh offsite list
./bin/nocheh offsite fetch --output ./recovered-backup
./bin/nocheh restore ./recovered-backup --state ./data/restored --project nocheh-restored
```

For Cloudflare, create an R2 API token with Object Read for the bucket the dashboard
named (`nocheh-backups` unless it added an ending) in Cloudflare's R2 settings: it
shows the S3 address and both keys, and the region is `auto`. For Backblaze, use a key for the bucket; the region is the
part of the address after `s3.`, such as `us-west-004`.

`offsite list` shows the copies in the bucket, `offsite fetch` takes the newest one
unless `--key` names another, and `offsite decrypt COPY --output DIR` opens a copy you
downloaded yourself. See [ADR-0229](adr/0229-encrypted-off-site-backup-copies.md).

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

System › Backups › **Export archive and memory** creates an authenticated ZIP download.
The same export is available without the dashboard:

```sh
./bin/nocheh export --output data/exports/my-portable-copy
```

The destination must be new. `archive/` preserves the existing NDJSON/file replay
format with originals and derived provenance. `native/` contains registered
profiles' exact notes, scope markers and consistent SQLite copies, including
committed WAL state, plus each profile's scheduled jobs (`cron/jobs.json`), staged
inactive. `owner/` carries the owner's own records: tasks with their comments,
reminders, people, links, files and history, project assignments, sharing rules,
learning consent, hidden sources, topic names, edited built-in texts, Notion and
background-work settings and each chat's tool switches. On import, nothing acts by
itself: sharing rules arrive off, a switch that was on arrives inherited, and a
past-due reminder arrives skipped ([ADR-0230](adr/0230-portable-export-carries-owner-work.md)).
The completion manifest includes sizes and SHA-256 hashes.
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
code revision and image IDs before changing live images. Live model and
[real Telegram acceptance](release-acceptance.md) still apply; an offline pass is
not permission to cut over. For rollback, use the matching prior code/images and
a verified snapshot in a new inactive project. Never downgrade a live database
in place or activate copied pending actions without reconciliation.

## Pauses, backlogs and release checks

`diagnose` shows container health, model provider configuration, Telegram state,
service heartbeats and archive job counts. `healthy` describes service availability;
it does not mean credentials are configured or a quota-limited model can answer.

Archive capture precedes inference. Database outages leave updates in the durable
spool; retries commit them idempotently after recovery. Attachment extraction
failures retain their source and failure state. A reply waits for its voice note's
transcript; without a voice provider key the note is archived only. Quota failures pause work for retry;
they do not switch to another provider. Required guard failures send zero
requests to the protected destination. Unknown outbound outcomes stay ambiguous.
Action receipt polling backs off for 30 seconds after an uncertain RPC response.

Release evidence is tracked in [TASK.md](../TASK.md). The container tests cover
database recovery, duplicate delivery, quota pauses, guard failure, scoped reads,
replay suppression and approval boundaries. Actual Telegram DM/group/voice,
intentional silence, approved delivery and reconnect checks remain required before
release. Git integration has its own verification gates.

## Later VPS deployment

Use the same Compose files and scripts on a Linux host with Docker, Python 3 and Node 26.x.
Transfer owned data using backup/restore, assign the proper host UID/GID, and run
container acceptance there before enabling the bot. Keep the API on loopback unless
an authenticated transport is intentionally configured. VPS provisioning and its
live checks are deferred until a server exists.

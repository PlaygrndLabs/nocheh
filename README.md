# Nocheh

A personal AI brain with Hermes as its first replaceable runtime. Original messages,
events, files, and separately recorded transcripts stay in an owned, portable archive.

[SPECS.md](SPECS.md) defines the product. [AGENTS.md](AGENTS.md) explains the coding
workflow. [TASK.md](TASK.md) records implementation, activation, and outstanding
acceptance; [ADRs](docs/adr/README.md) preserve the decision history.
Agent skills for [admin inspection](.agent/skills/nocheh-admin-cli/SKILL.md),
[app deployment](.agent/skills/nocheh-deploy/SKILL.md), and
[Graphify](.agent/skills/graphify/SKILL.md) live in the shared `.agent/skills` directory.
[Repository layout and ignored local state](docs/repository-layout.md) lists the role of every top-level directory.

`./bin/nocheh` is the owner command. `tools/` holds CLI routing and operational,
runtime, acceptance, development, and build helpers. `services/hermes` is the
Hermes plugin, `services/honcho` holds Honcho integration, `src/` holds TypeScript
services, and `dashboard/` holds the owner UI. [Layout decision](docs/adr/0069-role-based-source-layout.md).

The reviewed deployment combines application responsibilities and uses clear tool
service names. See [the service map and workflow](docs/services.md).
[TASK.md](TASK.md) records actual activation, migration progress and release gates;
specifications and healthy containers do not establish release acceptance.

Legacy code is preserved on `archive/pre-hermes-nocheh`.

## Local development and automated startup

Install Docker with Compose, Python 3 and Node 24.x, then run:

```bash
npm ci                  # development/build dependencies; runtime tools are in Docker
./bin/nocheh init     # create .env with generated internal credentials
# Edit .env for Telegram, model and optional guarding settings.
make dev                  # source-watched operating Compose stack
make dev-build            # rebuild after dependency or Dockerfile changes
make dev-status           # inspect the development stack
make dev-stop             # stop it; retain operating data
./bin/nocheh status
./bin/nocheh diagnose # health, credentials presence, and archive job states
./bin/nocheh db       # optional read-only pgweb browser at 127.0.0.1:8782
./bin/nocheh test     # PostgreSQL, TypeScript and native Python integration tests
./bin/nocheh verify   # live synthetic subscription checks; consumes quota
./bin/nocheh provider status  # shared provider, login and monitor health
./bin/nocheh down     # stop services; retain data
```

Stop unattended services before `make dev`; the launcher refuses a competing
Nocheh stack and verifies the operating volume, source mount, port, and
project ownership. The root `docker-compose.dev.yml` mounts this checkout's source into
the operating `nocheh` project, using its configured Telegram bot and provider login. Root `docker-compose.yml`
defines the three-store layout directly. Compose creates fresh owned database
volumes on first startup and retains them across normal restarts. The existing app service compiles changed source into shared generated-code
volumes, and the running services reload without an image rebuild or another
`make dev`. Use `make dev-build` after dependency or Dockerfile edits, and
`make dev-stop` to stop development without deleting operating state. The
normal dashboard URL is `http://127.0.0.1:8783/`. Development health does not
complete release acceptance. See [the development procedure](docs/deploy.md).

The archive API is bound to `127.0.0.1:8780`; PostgreSQL and internal services are
not exposed on the host. Health checks use `/health`. Authenticated status uses
`/v1/status` and the generated service token.

Run `./bin/nocheh dashboard` for owner archive inspection, guarded editing,
memory and configuration. The optional database browser reuses pgweb for table
browsing, SQL queries and CSV/JSON export. See
[browsing the archive](docs/database-viewer.md) for readable message queries.

Configuration is in the ignored root `.env`; `.env.example` documents its fields.
Bootstrap generates missing internal passwords and creates writable state under
ignored `data/local/`. CLIProxyAPI owns the shared refreshable OAuth login under
`data/local/provider/auth/`; Hermes and Honcho use separate local client keys.
For a new installation, start the services, run `./bin/nocheh provider login`,
then `./bin/nocheh provider cutover`.
Reasoning uses subscription authentication. Optional Honcho activation additionally
requires a dedicated embeddings credential, capped at $5 for the pilot and then
$5 per month. No unrelated provider credentials or local models are used.

See [operations and configuration](docs/deploy.md),
[durable archive behavior](docs/archive.md), [portable import/export](docs/import-export.md),
[saved guarded copies](docs/guard.md),
[Telegram setup and scoped assistant](docs/telegram.md),
[guarded memory system and operating instructions](docs/guarded-memory-system.md),
[shared provider and monitoring](docs/provider.md),
[rebuild execution checkpoints](docs/rebuild-plan.md), and
[subscription evidence](docs/acceptance/subscription-findings.md). VPS provisioning is deferred;
an existing VPS checkout can receive [app rollouts](docs/deploy.md). Local
Compose is the development and acceptance target (ADR-0019).

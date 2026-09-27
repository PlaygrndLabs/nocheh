# Nocheh

A personal AI brain with Hermes as its first replaceable runtime. Original messages,
events, files, and separately recorded transcripts stay in an owned, portable archive.

[SPECS.md](SPECS.md) defines the product. [AGENTS.md](AGENTS.md) explains the coding
workflow. [TASK.md](TASK.md) records implementation, activation, and outstanding
acceptance; [ADRs](docs/adr/README.md) preserve the decision history.
Agent skills for [admin inspection](.agent/skills/nocheh-admin-cli/SKILL.md) and
[app deployment](.agent/skills/nocheh-deploy/SKILL.md) live in `.agent/skills`.


The reviewed deployment combines application responsibilities and uses clear tool
service names. See [the service map and workflow](docs/services.md).
[TASK.md](TASK.md) records actual activation, migration progress and release gates;
specifications and healthy containers do not establish release acceptance.

Legacy code is preserved on `codex/legacy-nocheh`.

## Local development and automated startup

Install Docker with Compose, Python 3 and Node 24.x, then run:

```bash
npm ci                  # development/build dependencies; runtime tools are in Docker
./bin/nocheh init     # create .env with generated internal credentials
# Edit .env for Telegram, model and optional guarding settings.
./bin/nocheh up       # build, start in the background, wait for health checks
make dev                  # one source-mounted full core development stack
make dev-status           # inspect that checkout's preview
make dev-stop             # stop it; retain its database and generated state
./bin/nocheh status
./bin/nocheh diagnose # health, credentials presence, and archive job states
./bin/nocheh db       # optional read-only pgweb browser at 127.0.0.1:8782
./bin/nocheh test     # PostgreSQL, TypeScript and native Python integration tests
./bin/nocheh verify   # live synthetic subscription checks; consumes quota
./bin/nocheh provider status  # shared provider, login and monitor health
./bin/nocheh down     # stop services; retain data
```

Stop the operating Nocheh stack before `make dev`; the command refuses to start
while another Nocheh project runs. `make dev` prints the dashboard URL and uses
generated credentials under that checkout's ignored `data/dev/`. The existing
`nocheh-app` container compiles changed source into shared volumes; the running
app, dashboard, executor, security, and Python services reload without a Docker
image rebuild or another `make dev`. Dependency and Dockerfile edits still need an
image build. Pinned Hermes and provider images must be available locally; the
command verifies their revisions and creates dev tags. The single Compose
project is `nocheh-dev`, with the normal dashboard URL `http://127.0.0.1:8783/`.
Honcho's five services run in that project with separate dev storage. Development
does not import an installation login or enable Telegram polling. External model
and embedding calls require separate development credentials. Run
`make dev-stop` when finished. Release acceptance uses the operating installation's
`up` workflow.
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
[subscription evidence](compatibility/findings.md). VPS provisioning is deferred;
an existing VPS checkout can receive [app rollouts](docs/deploy.md). Local
Compose is the development and acceptance target (ADR-0019).

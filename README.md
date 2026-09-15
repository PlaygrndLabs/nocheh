# Nocheh

A personal AI brain with Hermes as its first replaceable runtime. Original messages,
events, files, and separately recorded transcripts stay in an owned, portable archive.

[SPECS.md](SPECS.md) defines the product. [AGENTS.md](AGENTS.md) explains the coding
workflow. [TASK.md](TASK.md) records implementation, activation, and outstanding
acceptance; [ADRs](docs/adr/README.md) preserve the decision history.

The reviewed deployment combines application responsibilities and uses clear tool
service names. See [the service map and workflow](docs/services.md).
[TASK.md](TASK.md) records actual activation, migration progress and release gates;
specifications and healthy containers do not establish release acceptance.

Legacy code is preserved on `codex/legacy-nocheh`.

## Local development and automated startup

Install Docker with Compose, Python 3 and Node 24.x, then run:

```bash
npm ci                  # install the pinned host dashboard/build dependencies
./scripts/nocheh init     # create .env with generated internal credentials
# Edit .env for Telegram, model and optional guarding settings.
./scripts/nocheh up       # build, start in the background, wait for health checks
./scripts/nocheh dev      # the same services with source watching and restart
./scripts/nocheh status
./scripts/nocheh diagnose # health, credentials presence, and archive job states
./scripts/nocheh db       # optional read-only pgweb browser at 127.0.0.1:8782
./scripts/nocheh test     # PostgreSQL, TypeScript and native Python integration tests
./scripts/nocheh verify   # live synthetic subscription checks; consumes quota
./scripts/nocheh provider status  # shared provider, login and monitor health
./scripts/nocheh down     # stop services; retain data
```

`make up` and `make test` are working aliases. `make dev` has no recipe yet; use
`./scripts/nocheh dev` for the explicitly assigned local installation. Per-session
preview isolation is [follow-up work](TASK.md); a separate worktree alone does not
isolate Compose services, ports, credentials, or runtime state.
The archive API is bound to `127.0.0.1:8780`; PostgreSQL and internal services are
not exposed on the host. Health checks use `/health`. Authenticated status uses
`/v1/status` and the generated service token.

Run `./scripts/nocheh dashboard` for owner archive inspection, guarded editing,
memory and configuration. The optional database browser reuses pgweb for table
browsing, SQL queries and CSV/JSON export. See
[browsing the archive](docs/database-viewer.md) for readable message queries.

Configuration is in the ignored root `.env`; `.env.example` documents its fields.
Bootstrap generates missing internal passwords and creates writable state under
ignored `data/local/`. CLIProxyAPI owns the shared refreshable OAuth login under
`data/local/provider/auth/`; Hermes and Honcho use separate local client keys.
For a new installation, start the services, run `./scripts/nocheh provider login`,
then `./scripts/nocheh provider cutover`.
Reasoning uses subscription authentication. Optional Honcho activation additionally
requires a dedicated embeddings credential, capped at $5 for the pilot and then
$5 per month. No unrelated provider credentials or local models are used.

See [operations and configuration](docs/deploy.md),
[durable archive behavior](docs/archive.md), [portable import/export](docs/import-export.md),
[saved guarded copies](docs/guard.md),
[Telegram setup and scoped assistant](docs/telegram.md),
[guarded memory system and operating instructions](docs/guarded-memory-system.md),
[shared provider and monitoring](docs/provider.md),
[isolated Honcho acceptance](experiments/honcho/README.md),
[rebuild execution checkpoints](docs/rebuild-plan.md), and
[subscription evidence](compatibility/findings.md). VPS setup is deferred; local
Compose is the current development and acceptance target (ADR-0019).

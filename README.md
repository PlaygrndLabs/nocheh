# Nocheh

A personal assistant built around Hermes, with an independent archive of original
messages, events, files and separately recorded transcripts. Source data stays
portable when the agent or memory system changes.

**Status:** local runtime reset to an empty state at the owner's request.
The implementation is on `codex/hermes-rebuild`; real Telegram acceptance and
the merge to `main` remain pending fresh setup. See [TASK.md](TASK.md).
Legacy code is preserved on `codex/legacy-nocheh`.

## Local development and automated startup

Install Docker with Compose and Python 3, then run:

```bash
./scripts/nocheh init     # create .env with generated internal credentials
# Edit .env for Telegram, model and optional guarding settings.
./scripts/nocheh up       # build, start in the background, wait for health checks
./scripts/nocheh dev      # the same services with source watching and restart
./scripts/nocheh status
./scripts/nocheh diagnose # health, credentials presence, and archive job states
./scripts/nocheh test     # PostgreSQL, TypeScript and native Python integration tests
./scripts/nocheh verify   # live synthetic subscription checks; consumes quota
./scripts/nocheh down     # stop services; retain data
```

`make up`, `make dev`, `make test` and the other matching Make targets are aliases.
The archive API is bound to `127.0.0.1:8780`; PostgreSQL and internal services are
not exposed on the host. Health checks use `/health`. Authenticated status uses
`/v1/status` and the generated service token.

Configuration is in the ignored root `.env`; `.env.example` documents its fields.
Bootstrap generates missing internal passwords and creates writable state under
ignored `data/local/`. Hermes manages its refreshable OAuth login in its native
`data/local/hermes/auth.json` file.
It transfers an existing dedicated compatibility login into the runtime once.
For a new installation, start the services and run `./scripts/nocheh login`.
No production model-provider API keys or local inference models are required.

See [operations and configuration](docs/deploy.md),
[durable archive behavior](docs/archive.md), [portable import/export](docs/import-export.md),
[optional outgoing guarding](docs/guard.md),
[Telegram setup and scoped assistant](docs/telegram.md),
[isolated Honcho comparison](experiments/honcho/README.md),
[architecture and phase diagram](docs/rebuild-plan.md), and
[subscription evidence](compatibility/findings.md). VPS setup is deferred; local
Compose is the current development and acceptance target (ADR-0019).

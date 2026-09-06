# Nocheh

A personal assistant built around Hermes, with an independent archive of original
messages, events, files and separately recorded transcripts. Source data stays
portable when the agent or memory system changes.

**Status:** phased rebuild on `codex/hermes-rebuild`; see [TASK.md](TASK.md) for
completed behavior. Legacy code is preserved on `codex/legacy-nocheh`.

## Local development and automated startup

Install Docker with Compose and Python 3, then run:

```bash
./scripts/nocheh up       # build, start in the background, wait for health checks
./scripts/nocheh dev      # the same services with source watching and restart
./scripts/nocheh status
./scripts/nocheh test     # PostgreSQL, TypeScript and native Python integration tests
./scripts/nocheh verify   # live synthetic subscription checks; consumes quota
./scripts/nocheh down     # stop services; retain data
```

`make up`, `make dev`, `make test` and the other matching Make targets are aliases.
The archive API is bound to `127.0.0.1:8780`; PostgreSQL and internal services are
not exposed on the host. Health checks use `/health`. Authenticated status uses
`/v1/status` and the generated service token.

Bootstrap creates credentials and writable state under ignored `data/local/`.
It transfers an existing dedicated compatibility login into the runtime once.
For a new installation, start the services and run `./scripts/nocheh login`.
No production model-provider API keys or local inference models are required.

See [operations and configuration](docs/deploy.md),
[durable archive behavior](docs/archive.md), [portable import/export](docs/import-export.md),
[architecture and phase diagram](docs/rebuild-plan.md), and
[subscription evidence](compatibility/findings.md). VPS setup is deferred; local
Compose is the current development and acceptance target (ADR-0019).

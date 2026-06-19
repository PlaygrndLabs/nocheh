# ADR-0005: SQLite VPS Persistence

## Status

Accepted

## Context

The assistant is moving from local Phase 2 development toward a persistent VPS deployment. The existing encrypted JSON document store is simple, but it rewrites whole files, has weak concurrency characteristics, and does not match a long-running service with growing task, memory, audit, settings, and buffer data.

The app is already a Node HTTP service with Telegram webhook ingestion, live batching, structured memory, audit records, and optional Notion MCP sync. This fits a small VPS better than a full Cloudflare Workers rewrite because the service can keep normal Node process behavior, local disk persistence, and stdio MCP integration.

Persistence must continue to protect message-derived payloads at rest. Existing encrypted JSON data is considered local development data and will not be migrated.

## Decision

Use SQLite as the only runtime persistence backend.

Add a SQLite infrastructure layer with:

- one database file selected by `DATABASE_PATH`
- startup schema creation through an idempotent `schema_migrations` table
- plaintext query/index columns for ids, statuses, types, timestamps, project ids, and settings
- encrypted JSON payload columns for sensitive task, memory, audit, sync, and buffered-message records

Keep `LOCAL_ENCRYPTION_SECRET` as the application-level field encryption secret. Sensitive serialized payloads are encrypted with the existing AES-GCM encryption adapter before being stored in SQLite.

Replace runtime wiring so the dev server constructs SQLite repositories for:

- tasks
- memory records
- task sync mappings
- audit records
- group assistant settings
- live message buffer

Keep application and domain ports unchanged. JSON-backed repositories may remain in the codebase for reference or tests, but they are no longer used by the runtime startup path.

Deploy on a VPS with Docker Compose:

- `nocheh` runs the Node service continuously
- `/app/data` is mounted to persistent VPS storage
- SQLite lives at `/app/data/nocheh.sqlite`
- `cloudflared` exposes the service through Cloudflare Tunnel

## Consequences

Positive:

- The runtime has one durable local database instead of multiple whole-document JSON files.
- SQLite gives atomic writes, indexes, and simpler backup semantics for a small VPS.
- Queryable fields remain efficient without decrypting every record.
- Message-derived payloads are still encrypted at rest.
- The application layer remains storage-agnostic through existing ports.
- Docker Compose provides the persistent process model without introducing systemd units.

Tradeoffs:

- This is a single-writer local persistence design; it is not intended for multiple app containers writing to the same database.
- Operators must keep `LOCAL_ENCRYPTION_SECRET` stable or encrypted payloads become unreadable.
- SQLite backups need filesystem-level care, especially with WAL files.
- Existing encrypted JSON development data is not automatically migrated.
- Cloudflare Tunnel becomes part of production ingress.

## Guardrails

- Do not store raw Telegram chat history as long-term memory.
- Keep redaction before extraction, buffering, persistence, logs, and sync.
- Keep sensitive message-derived payloads encrypted in SQLite.
- Do not put secrets in `docker-compose.yml`; use `.env` or VPS secret management.
- Back up the full SQLite data directory, including WAL-related files.
- Do not run multiple writer containers against the same SQLite database file.

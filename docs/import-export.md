# Portable archive operations

Start Compose with `./scripts/nocheh up`. The CLI reads the ignored service token
and generated local port configuration; credentials never appear in arguments.

```sh
python3 scripts/archive.py import-telegram /absolute/export/result.json
python3 scripts/archive.py import-telegram /absolute/export/result.json --scope=-1001234567890
python3 scripts/archive.py export /absolute/new-export-directory
python3 scripts/archive.py import /absolute/new-export-directory
python3 scripts/archive.py replay EVENT_ID
```

Both a single-chat Telegram Desktop JSON file and `chats.list` exports are
supported. Original message/service-event JSON and chat metadata are retained.
Text entities are concatenated without normalization. Supplied photos, files and
thumbnails are copied with their bytes unchanged. Excluded/missing files remain
visible failures; absolute paths, traversal and escaping symlinks are rejected.

Unmapped Desktop chats use `desktop:TYPE:ID` scopes, available only to owner-wide
retrieval. Map a single export explicitly with `--scope`, or use `--scope-map`
with a JSON object mapping exported chat IDs to actual Telegram chat IDs. This
avoids guessing Telegram's different export/Bot API identifiers and accidentally
sharing imported private history with a group. The mapping is an owner operation.

Native exports contain `manifest.json`, `events.ndjson`, and content-addressed
files. Incomplete exports are marked and cannot be imported. Reimport verifies
hashes, preserves original versus derived content and provenance, and is
idempotent. Stored event origin is retained, but import transport suppresses
dispatch. Archive replay validates/re-ingests existing records and retries missing
Telegram attachments; it does not call an agent or send historical replies.

Exports paginate immutable sources and fetch files separately. Pause archive
writes if an exact point-in-time export is required. Database backup/restore is
the operational recovery mechanism; the portable format is for exchanging source
data with other agent or memory stacks.

## Interfaces

All `/v1/` routes require bearer authentication. Only the owner/service credential
may ingest, import, export, replay, upload files or inspect global status. Signed,
expiring read credentials bind the scope on the server; caller-supplied scope
arguments cannot broaden it. An owner DM can receive an archive-wide read
credential without receiving administrative API authority.

| Method / path | Behavior |
| --- | --- |
| POST `/v1/ingest` | Idempotent original event envelope |
| GET `/v1/search?q=...&limit=20` | Bounded PostgreSQL lexical search, no embeddings |
| GET `/v1/events/ID` | Original event, source reference, artifacts and derived text |
| GET `/v1/artifacts/ID/bytes` | Scoped, hash-verified original bytes |
| GET `/v1/export?after=ID&limit=20` | Owner-only portable record page |
| POST `/v1/import` | Portable record; no historical dispatch |
| POST `/v1/artifacts/ID/bytes` | Owner upload with required SHA-256 |
| POST `/v1/replay` | `{ "event_ids": [...] }`, archive-only replay |
| GET `/v1/status` | Service heartbeats, pending/failed archive work |

The `nocheh_archive_search` and `nocheh_archive_read` native Hermes tools carry
source references and bounded context. Their scope credential must be bound by
the trusted dispatcher; an unbound invocation fails before network access.

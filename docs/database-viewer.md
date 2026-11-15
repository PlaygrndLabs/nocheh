# Browse installation databases

For the ordinary owner workflow, run `./bin/nocheh dashboard`, open
**Archive**, and use the records table. Selecting **View / edit** opens the
immutable original beside its editable guarded version. Saves create a new
revision and never rewrite the source evidence.

For raw table inspection, open **Databases** in the owner dashboard. Use the
database and table selectors at the top of the page. The database selector shows
availability; selecting one shows its engine, service or file identity, table
count, size, and version below. Filter table names beside the selectors when the
table list is long. Click a column heading to sort,
or select a column and enter text to filter its rows. Pages contain up to 50 rows;
visible cell text is limited to 500 characters. The browser is read-only and does
not accept SQL or arbitrary
file paths. It includes the configured Nocheh PostgreSQL databases, Inngest
workflow PostgreSQL, enabled Honcho PostgreSQL, registered Hermes profile SQLite,
provider usage SQLite, and enabled Honcho budget SQLite databases. Unavailable
database services or files show an error state. Redis holds
operational keys rather than tables; Monitoring shows its service health, not
raw keys.

Use the optional pgweb browser below when raw SQL queries or exports are needed on
a legacy combined installation. It is read-only; product records must be changed through their
dashboard, API, or CLI commands so revision, authorization, invalidation, and
provenance rules still apply.

Run `./bin/nocheh db`, then open the address it prints: <http://127.0.0.1:8782> for
the `personal` workspace, two above its `NOCHEH_PORT` for another workspace. The
viewer asks for a login once, which the browser can save: the user `owner` and the
password `db` prints each time.
This starts the pinned pgweb image from the optional Compose `tools` profile.
It opens the `nocheh` database, which holds the archive only on a legacy combined
installation; browse the separate stores under **Databases**. It does not restart the assistant.
`./bin/nocheh down` also stops the viewer; run `db` to start it again. It comes
back by itself after Docker restarts, as before. `./bin/nocheh up` gives a viewer
still running from before it had a login its login, and prints it; after
`make dev`, run `db` once instead.

The owner can inspect all archive scopes here. The HTTP port is loopback-only,
and pgweb asks for its own web login on every page, so a web page on another site
cannot read it through that port. Do not publish this port. The viewer never
starts without its login, and it reports healthy only while it asks for it. The dedicated
`nocheh_viewer` PostgreSQL role has read access, with no source-write privileges.
pgweb also runs in read-only mode with connection switching and SSH disabled.
Its generated password lives in the ignored `.env` as `NOCHEH_VIEWER_PASSWORD`, and
the web login's as `NOCHEH_VIEWER_WEB_PASSWORD`; neither is on a command line.
Both are 64 lowercase hex characters: `db` and `up` refuse any other value and say
so, and `db` makes a new one once you clear it.
Hermes receives neither this credential nor this interface.

Click a table to inspect rows/structure, or use Query:

```sql
SELECT received_at, scope, origin, kind, search_text AS message_text
FROM events
WHERE kind IN ('telegram_update', 'assistant_result') AND search_text <> ''
ORDER BY received_at DESC LIMIT 100;
```

`search_text` is the readable search index. Exact originals remain in the binary
`original_text`, `payload`, and `wire` columns; the index is not an export format.
For a source's exact UTF-8 bytes (including otherwise undisplayable NULs), select
`encode(original_text, 'hex')`. Use the portable archive export to preserve all
bytes and provenance across stacks.

| Table | Contains |
| --- | --- |
| `events` | Original updates and separately identified generated replies/action events |
| `artifacts` | Original attachment metadata, stored file hashes and retrieval status |
| `derived_artifacts` | Transcripts/extracted text with provenance |
| `dispatches` | Assistant queue, attempts, completion/failure states |
| `transcription_jobs` | Voice processing/retry state |
| `action_requests` | Proposed actions and owner approvals |
| `guarded_cache` | Versioned guarded views, when required |
| `spool_failures` | Capture problems requiring attention |
| `service_heartbeats` | Worker/service health timestamps |

Attachment bytes live in the file store, not PostgreSQL. Hermes's native memory
and session SQLite databases remain in its isolated profile directories and are
visible through the owner dashboard's Databases page, but not through pgweb.

The read role uses PostgreSQL's built-in `pg_read_all_data` role, so archive dumps
do not acquire references to a custom grantee on each table. After restoring into
a fresh database, run `db` to recreate the optional login. Stop another local
viewer first if port 8782 is occupied.

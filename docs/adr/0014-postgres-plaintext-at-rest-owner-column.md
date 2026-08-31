# ADR-0014: Postgres, Plaintext At Rest, And An Owner Column

## Status

Accepted. Supersedes ADR-0005 on the storage engine and on encrypted payload columns;
extends ADR-0011 on where vectors live.

## Context

ADR-0005 chose SQLite with AES-256-GCM payload columns, and ADR-0011 put base64 float32
vectors inside one of those encrypted columns rather than in a vector index. Both
decisions were correct for the phase that made them. Three things have since become
measurable and one has become a requirement.

**The encryption boundary, not SQLite, is what makes the hot read path O(n).**
`source.messageId` lives inside the encrypted `source` column, so
`findNodesBySourceMessageId` cannot be a `WHERE` clause: it runs `listNodes()` over the
whole table, decrypts four columns per node, and filters in JavaScript.
`AssistantContextBuilder` calls it up to 16 times per window and then calls `listNodes()`
again for graph expansion — roughly **17 full decrypted scans of the graph per analysed
window**. Moving the same schema to Postgres would not fix a single one of them.
`findBySourceMessageId` on tasks and `findAll()` on records and embeddings have the same
shape.

**The at-rest guarantee is already partial.** `memory_nodes.label` is plaintext.
`suggestions.title` is plaintext. Node ids are mandated by the analysis prompt to be slugs
like `project:acme-site`. `SELECT kind, label FROM memory_nodes` reads out every person,
project and goal the owner has, without the key. The ciphertext protects the detail and
leaks the shape.

**The key lives on the same box as the ciphertext.** `LOCAL_ENCRYPTION_SECRET` is read
from `.env` on the VPS and derived once at startup with a hardcoded scrypt salt. That
defends against exactly four things — a stolen backup or snapshot, a read-only exfil, the
host reading a decommissioned disk, and accident — and against nothing at all once someone
has root, because the key is in process memory. Worse, `dev-server.ts` falls back to the
literal string `"local-development-secret-change-me"` when the variable is unset, so an
unconfigured install is "encrypted" with a public key.

**Anything that searches text needs the text.** pgvector cannot index a vector inside
AES-GCM ciphertext. Postgres full-text cannot tokenise an encrypted string. Any external
memory service — Honcho self-hosted stores message content, conclusions and embeddings in
plaintext Postgres, with no encryption anywhere in its repo — receives plaintext by
definition. The current posture is only coherent for a system that never searches and
never integrates.

Ten Postgres-specific breakages were found in the 13 SQLite repositories. Four matter:

- `SELECT DISTINCT conversation_id AS conversationId` — Postgres folds unquoted
  identifiers to lowercase, so `row.conversationId` becomes `undefined` and the flush
  sweep silently stops finding conversations. **Fails silently, not loudly.**
- `row.encrypted === 1` on `app_config` — boolean-as-integer.
- `database.transaction(() => …)` — a synchronous callback in the buffer repository and
  around the schema bootstrap.
- The schema is not versioned. `schema_migrations` holds a single version row, but four
  functions run `CREATE TABLE IF NOT EXISTS` on every open and are not versioned at all.

## Decision

**Postgres is the only runtime store.** `pg` becomes the second runtime dependency. The
one-runtime-dependency discipline was a proxy for "few moving parts"; a real migration
path, a real index, and a vector store that works are worth one dependency. `better-sqlite3`
is removed once the export path has run.

**Payload columns become plaintext `jsonb`.** The threat model is written down and
accepted: *root on the VPS, or a copy of the running database, is total loss.* Encryption
at rest bought protection against snapshot theft; that protection is surrendered
deliberately in exchange for indexed reads, real SQL, pgvector, and the ability to search
the owner's own memory.

**AES-GCM survives for exactly one thing: credentials.** `app_config` values marked
secret — provider API keys, the bot token, the tunnel token — stay encrypted, because those
are credentials rather than content, and a leaked key is a different class of harm than a
leaked note. The `"local-development-secret-change-me"` fallback is deleted: unset means
fail closed.

**Every filter the code performs in JavaScript today becomes a column.**
`source_message_id`, `conversation_id`, `occurred_at`, `owner_id`, `kind`, `relation`,
`status`, `confidence`, `project_id`, `due_at` are plaintext and indexed. The 17 scans per
window collapse to indexed lookups, and that number is asserted in a test rather than
assumed.

**Vectors go into pgvector**, one row per record, with the model id and dimension stored
alongside. Dimension is not pinned by the schema, because the message log (ADR-0013) makes
re-embedding a replay rather than a migration — the constraint that is permanent inside
Honcho does not exist here.

**Migrations become forward-only numbered SQL files** with one applied-migrations table
and no `IF NOT EXISTS` bootstrap functions. The schema stops being whatever accumulated.

**`owner_id` is added to every table and to `SourceReference`**, with one value today, no
auth changes, and no UI changes. This is not multi-tenancy; it is the column that makes
multi-tenancy possible later. Retrofitting it afterwards means touching every primary key,
all eight indexes, twelve port interfaces, the most-copied domain shape in the codebase,
and three bugs that fail silently rather than loudly: the hardcoded `person:mak` node id
overwriting under `ON CONFLICT`, the `flushing` set colliding on shared conversation ids,
and the process-global vector cache serving one owner's vectors to another. During this
rewrite it is a day. Afterwards it is weeks.

**Migration is one-shot and offline.** A script reads the SQLite file, decrypts every
payload with the existing key, and writes plaintext `jsonb` into Postgres. It runs once,
verifies row counts and a sample of decoded payloads, and is then deleted. No dual-write,
no dual-read, no sync period — the corpus is small enough that a five-minute outage is
cheaper than a consistency protocol.

## Consequences

- Backups become the primary at-rest control: `pg_dump` on a schedule, to an encrypted
  destination, and **a restore rehearsal recorded in `docs/deploy.md`**. An unrehearsed
  backup is not a backup, and it is now the only thing standing between a bad day and
  total loss.
- Volume-level encryption on the VPS is the only remaining defence for content, and its
  key is the host's problem. If the owner later wants more, the escalation is handing
  `LOCAL_ENCRYPTION_SECRET` to the container at boot from outside the box rather than from
  `.env` — that survives theft of a powered-off disk, and still not root.
- Roughly 30 tests that assert encrypted payloads change or go away. Every repository body
  is rewritten to `await`; the port signatures already return `Promise` and do not change,
  which is what makes this mechanical rather than architectural.
- Ops surface grows from one file to one container plus a volume plus a backup job. That is
  the real, unglamorous cost, and it is smaller than Postgres + Redis + an API + a worker
  would have been.
- `EncryptedJsonCodec` is deleted from every repository except `app_config`.
  `AesGcmEncryption` stays, with the fixed salt replaced by a per-install random salt
  stored alongside the ciphertext version prefix.

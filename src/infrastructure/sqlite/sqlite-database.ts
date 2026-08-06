import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";

export type SqliteDatabase = BetterSqliteDatabase;

export function openSqliteDatabase(databasePath: string): SqliteDatabase {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  applyMigrations(database);
  applyMemoryGraphSchema(database);
  applyAppConfigSchema(database);
  applyMediaUnderstandingSchema(database);
  applyMemoryEmbeddingSchema(database);
  applyIncrementalColumns(database);
  return database;
}

/** Idempotent additive column migrations that are safe to run on every open. */
function applyIncrementalColumns(database: SqliteDatabase): void {
  addColumnIfMissing(database, "group_settings", "project_hint", "TEXT NOT NULL DEFAULT 'single'");
}

function addColumnIfMissing(database: SqliteDatabase, table: string, column: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as { readonly name: string }[];
  if (columns.some((entry) => entry.name === column)) {
    return;
  }
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function applyMigrations(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const hasV1 = database
    .prepare("SELECT version FROM schema_migrations WHERE version = 1")
    .get() !== undefined;
  if (hasV1) {
    return;
  }

  const migrate = database.transaction(() => {
    database.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        due_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE INDEX idx_tasks_open ON tasks(status, updated_at);

      CREATE TABLE memory_records (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        project_id TEXT,
        timestamp TEXT NOT NULL,
        confidence REAL NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE INDEX idx_memory_type ON memory_records(type, timestamp);
      CREATE INDEX idx_memory_project ON memory_records(project_id, timestamp);

      CREATE TABLE task_sync (
        task_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE audit_records (
        id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE INDEX idx_audit_processed ON audit_records(processed_at);

      CREATE TABLE group_settings (
        conversation_id TEXT PRIMARY KEY,
        analysis_mode TEXT NOT NULL,
        reply_mode TEXT NOT NULL,
        analysis_interval_seconds INTEGER NOT NULL,
        max_messages_per_batch INTEGER NOT NULL,
        max_ai_context_tokens INTEGER NOT NULL,
        max_retrieved_memories INTEGER NOT NULL,
        max_recent_messages INTEGER NOT NULL,
        summary_every_messages INTEGER NOT NULL,
        summary_every_minutes INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE live_message_buffer (
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        buffered_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (conversation_id, message_id)
      );

      CREATE INDEX idx_live_buffer_conversation ON live_message_buffer(conversation_id, buffered_at);
    `);

    database
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(1, new Date().toISOString());
  });

  migrate();
}

function applyMemoryGraphSchema(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_nodes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      scope TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source TEXT NOT NULL,
      aliases TEXT NOT NULL,
      summary TEXT,
      payload TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_nodes_kind_scope_status
      ON memory_nodes(kind, scope, status);

    CREATE TABLE IF NOT EXISTS memory_edges (
      id TEXT PRIMARY KEY,
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      valid_from TEXT,
      valid_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source TEXT NOT NULL,
      fact TEXT NOT NULL,
      payload TEXT NOT NULL,
      FOREIGN KEY(from_node_id) REFERENCES memory_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY(to_node_id) REFERENCES memory_nodes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_memory_edges_relation_status
      ON memory_edges(relation, status);
    CREATE INDEX IF NOT EXISTS idx_memory_edges_from_status
      ON memory_edges(from_node_id, status);
    CREATE INDEX IF NOT EXISTS idx_memory_edges_to_status
      ON memory_edges(to_node_id, status);

    CREATE TABLE IF NOT EXISTS suggestions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      confidence REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source TEXT NOT NULL,
      rationale TEXT NOT NULL,
      payload TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_suggestions_status_updated
      ON suggestions(status, updated_at);
  `);
}

/**
 * Global application configuration as an encrypted-capable key/value store.
 * Values are JSON strings; when `encrypted = 1` the value is an AES-GCM payload.
 */
function applyAppConfigSchema(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      encrypted INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
}

/**
 * Derived text for attachments, keyed by the platform's stable file identity.
 *
 * Only the description and transcript are stored, always encrypted. Media bytes are
 * never persisted: they are fetched, turned into text, and dropped.
 */
function applyMediaUnderstandingSchema(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS media_understanding (
      file_unique_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

/**
 * Vectors for memory records, used for associative recall.
 *
 * The vector is an encrypted payload like every other derived content column. An
 * embedding can be partially inverted back towards its source text, so it is treated as
 * derived content under the redaction-first rule rather than as opaque numbers. That also
 * settles the storage question: an encrypted blob is invisible to a vector index, so
 * scoring happens in process and no native extension is involved.
 *
 * `model` is stored because vectors from different models share no space and must never
 * be compared; `dimensions` makes a mismatch cheap to detect without decrypting.
 */
function applyMemoryEmbeddingSchema(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      record_id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (record_id) REFERENCES memory_records(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model ON memory_embeddings(model);
  `);
}

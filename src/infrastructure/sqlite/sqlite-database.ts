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
  return database;
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

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AesGcmEncryption } from "../src/infrastructure/security/aes-gcm-encryption.js";
import { openSqliteDatabase, type SqliteDatabase } from "../src/infrastructure/sqlite/sqlite-database.js";
import { SqliteAuditRepository } from "../src/infrastructure/sqlite/sqlite-audit-repository.js";
import { SqliteGroupAssistantSettingsRepository } from "../src/infrastructure/sqlite/sqlite-group-assistant-settings-repository.js";
import { SqliteLiveMessageBufferRepository } from "../src/infrastructure/sqlite/sqlite-live-message-buffer-repository.js";
import { SqliteMemoryRecordRepository } from "../src/infrastructure/sqlite/sqlite-memory-record-repository.js";
import { SqliteTaskRepository } from "../src/infrastructure/sqlite/sqlite-task-repository.js";
import { SqliteTaskSyncRepository } from "../src/infrastructure/sqlite/sqlite-task-sync-repository.js";
import { createGroupAssistantSettings } from "../src/domain/assistant/group-assistant-settings.js";
import type { MemoryRecord } from "../src/domain/memory/memory-record.js";
import type { ProcessingAuditRecord } from "../src/domain/observability/audit.js";
import { Task } from "../src/domain/tasks/task.js";

const encryption = new AesGcmEncryption("sqlite-test-secret-value");
const now = new Date("2026-06-19T12:00:00.000Z");
const source = {
  platform: "telegram",
  conversationId: "chat-1",
  messageId: "msg-1",
  occurredAt: new Date("2026-06-19T11:59:00.000Z"),
};

test("SQLite repositories persist and rehydrate app state", async () => {
  const database = await testDatabase();
  try {
    const taskRepository = new SqliteTaskRepository(database, encryption);
    const memoryRepository = new SqliteMemoryRecordRepository(database, encryption);
    const syncRepository = new SqliteTaskSyncRepository(database, encryption);
    const auditRepository = new SqliteAuditRepository(database, encryption);
    const settingsRepository = new SqliteGroupAssistantSettingsRepository(database);
    const bufferRepository = new SqliteLiveMessageBufferRepository(database, encryption);

    const task = Task.create({
      title: "Rotate production secret",
      description: "Use token sk_live_abcdefghijklmnopqrstuvwxyz",
      priority: "urgent",
      source,
    }, now);
    await taskRepository.save(task);
    await syncRepository.save({ provider: "notion", externalId: "page-1", taskId: task.id });

    const memory: MemoryRecord = {
      id: "memory-1",
      type: "Task",
      source,
      timestamp: now,
      confidence: 0.94,
      project: { id: "project:atlas", name: "Atlas" },
      task,
    };
    await memoryRepository.save(memory);

    const settings = createGroupAssistantSettings({
      conversationId: "chat-1",
      analysisMode: "immediate",
      maxMessagesPerBatch: 7,
    }, now);
    await settingsRepository.save(settings);

    await bufferRepository.append({
      platform: "telegram",
      conversationId: "chat-1",
      messageId: "msg-2",
      senderId: "7",
      text: "Decision: ship SQLite",
      occurredAt: source.occurredAt,
      bufferedAt: now,
    });

    const audit = auditRecord(task.id);
    await auditRepository.save(audit);

    assert.equal((await taskRepository.findById(task.id))?.title, "Rotate production secret");
    assert.equal((await taskRepository.findOpen()).length, 1);
    assert.equal((await syncRepository.findByTaskId(task.id))?.externalId, "page-1");
    assert.equal((await memoryRepository.findByType("Task"))[0]?.project?.name, "Atlas");
    assert.equal((await memoryRepository.findByProjectId("project:atlas")).length, 1);
    assert.equal((await settingsRepository.findByConversationId("chat-1"))?.maxMessagesPerBatch, 7);
    assert.equal((await bufferRepository.findByConversationId("chat-1"))[0]?.text, "Decision: ship SQLite");
    assert.equal((await auditRepository.findRecent(1))[0]?.id, "audit-1");

    await bufferRepository.remove("chat-1", ["msg-2"]);
    assert.equal((await bufferRepository.findByConversationId("chat-1")).length, 0);
  } finally {
    database.close();
  }
});

test("SQLite migrations are idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nocheh-sqlite-"));
  const path = join(dir, "nocheh.sqlite");
  const first = openSqliteDatabase(path);
  first.close();

  const second = openSqliteDatabase(path);
  try {
    const row = second.prepare("SELECT version FROM schema_migrations WHERE version = 1").get() as { version: number } | undefined;
    assert.equal(row?.version, 1);
  } finally {
    second.close();
  }
});

test("SQLite sensitive payload columns are encrypted", async () => {
  const database = await testDatabase();
  try {
    const repository = new SqliteTaskRepository(database, encryption);
    const task = Task.create({
      title: "Do not store this title as plaintext",
      description: "Contains token sk_live_abcdefghijklmnopqrstuvwxyz",
      source,
    }, now);

    await repository.save(task);

    const row = database.prepare("SELECT payload FROM tasks WHERE id = ?").get(task.id) as { payload: string };
    assert.match(row.payload, /^v1\./);
    assert.doesNotMatch(row.payload, /Do not store this title/);
    assert.doesNotMatch(row.payload, /sk_live/);
  } finally {
    database.close();
  }
});

async function testDatabase(): Promise<SqliteDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "nocheh-sqlite-"));
  return openSqliteDatabase(join(dir, "nocheh.sqlite"));
}

function auditRecord(taskId: string): ProcessingAuditRecord {
  return {
    id: "audit-1",
    platform: "telegram",
    conversationId: "chat-1",
    messageId: "msg-1",
    senderId: "7",
    receivedAt: source.occurredAt,
    processedAt: now,
    redactedContentPreview: "Task: [REDACTED:api_key]",
    redactionFindingCount: 1,
    steps: [{
      name: "persistence",
      status: "succeeded",
      startedAt: now,
      completedAt: now,
      durationMs: 0,
      metadata: {},
    }],
    extractedTasks: [{
      title: "Rotate production secret",
      confidence: 0.95,
      extractionReason: "test",
      sourceMessageId: "msg-1",
      processingTimestamp: now,
      accepted: true,
      warnings: [],
      taskId,
      syncStatus: "succeeded",
    }],
    errorLogs: [],
    totalLatencyMs: 1,
  };
}

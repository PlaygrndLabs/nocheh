import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "../src/application/dto/incoming-message.js";
import type { ClockPort } from "../src/application/ports/clock.js";
import type { LoggerPort } from "../src/application/ports/logger.js";
import type { MemoryRecordRepositoryPort } from "../src/application/ports/memory-record-repository.js";
import type { AuditRepositoryPort } from "../src/application/ports/audit-repository.js";
import type { SecretDetectorPort } from "../src/application/ports/secret-detector.js";
import type { TaskExtractorPort } from "../src/application/ports/task-extractor.js";
import type { ExternalTask, TaskProviderPort } from "../src/application/ports/task-provider.js";
import type { TaskRepositoryPort } from "../src/application/ports/task-repository.js";
import type { TaskSyncRepositoryPort } from "../src/application/ports/task-sync-repository.js";
import type { MemoryRecord, MemoryRecordType } from "../src/domain/memory/memory-record.js";
import type { ProcessingAuditRecord } from "../src/domain/observability/audit.js";
import type { ExtractedTaskCandidate } from "../src/domain/tasks/task-extraction.js";
import type { Task, TaskId } from "../src/domain/tasks/task.js";
import { RegexSecretDetector } from "../src/infrastructure/security/regex-secret-detector.js";
import { ProcessIncomingMessageUseCase } from "../src/application/use-cases/process-incoming-message.js";
import { InMemoryMetricsCollector } from "../src/infrastructure/observability/in-memory-metrics-collector.js";
import { RuleBasedMemoryExtractor } from "../src/infrastructure/reasoning/rule-based-memory-extractor.js";

class FixedClock implements ClockPort {
  public now(): Date {
    return new Date("2026-06-19T12:00:00.000Z");
  }
}

class SilentLogger implements LoggerPort {
  public info(): void {}
  public warn(): void {}
  public error(): void {}
}

class InMemoryTaskRepository implements TaskRepositoryPort {
  public readonly tasks = new Map<TaskId, Task>();

  public async save(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
  }

  public async findById(id: TaskId): Promise<Task | undefined> {
    return this.tasks.get(id);
  }

  public async findOpen(): Promise<readonly Task[]> {
    return [...this.tasks.values()].filter((task) => task.status === "open" || task.status === "in_progress");
  }
}

class InMemoryMemoryRepository implements MemoryRecordRepositoryPort {
  public readonly records: MemoryRecord[] = [];

  public async save(record: MemoryRecord): Promise<void> {
    this.records.push(record);
  }

  public async findAll(): Promise<readonly MemoryRecord[]> {
    return this.records;
  }

  public async findByType(type: MemoryRecordType): Promise<readonly MemoryRecord[]> {
    return this.records.filter((record) => record.type === type);
  }

  public async findByProjectId(projectId: string): Promise<readonly MemoryRecord[]> {
    return this.records.filter((record) => record.project?.id === projectId);
  }
}

class InMemorySyncRepository implements TaskSyncRepositoryPort {
  public readonly records = new Map<TaskId, ExternalTask>();

  public async findByTaskId(taskId: TaskId): Promise<ExternalTask | undefined> {
    return this.records.get(taskId);
  }

  public async save(externalTask: ExternalTask): Promise<void> {
    this.records.set(externalTask.taskId, externalTask);
  }
}

class InMemoryAuditRepository implements AuditRepositoryPort {
  public readonly records: ProcessingAuditRecord[] = [];

  public async save(record: ProcessingAuditRecord): Promise<void> {
    this.records.push(record);
  }

  public async findRecent(limit: number): Promise<readonly ProcessingAuditRecord[]> {
    return this.records.slice(-limit).reverse();
  }
}

class RecordingTaskProvider implements TaskProviderPort {
  public readonly synced: Task[] = [];

  public async upsertTask(task: Task): Promise<ExternalTask> {
    this.synced.push(task);
    return {
      provider: "notion",
      externalId: `notion-${task.id}`,
      taskId: task.id,
    };
  }
}

class FailingTaskProvider implements TaskProviderPort {
  public async upsertTask(): Promise<ExternalTask> {
    throw new Error("Notion unavailable");
  }
}

class RecordingExtractor implements TaskExtractorPort {
  public seenText = "";

  public async extractTasks(message: IncomingMessage): Promise<readonly ExtractedTaskCandidate[]> {
    this.seenText = message.text;
    return [{
      title: "Rotate production secret",
      confidence: 0.95,
      priority: "high",
      extractionReason: "Matched test candidate.",
    }];
  }
}

test("processes sanitized messages into tasks, memory records, and provider sync state", async () => {
  const secretDetector: SecretDetectorPort = new RegexSecretDetector();
  const extractor = new RecordingExtractor();
  const taskRepository = new InMemoryTaskRepository();
  const memoryRepository = new InMemoryMemoryRepository();
  const syncRepository = new InMemorySyncRepository();
  const provider = new RecordingTaskProvider();
  const auditRepository = new InMemoryAuditRepository();
  const metrics = new InMemoryMetricsCollector();
  const useCase = new ProcessIncomingMessageUseCase(
    secretDetector,
    extractor,
    taskRepository,
    memoryRepository,
    syncRepository,
    provider,
    new FixedClock(),
    new SilentLogger(),
    auditRepository,
    metrics,
  );

  const result = await useCase.execute({
    platform: "telegram",
    conversationId: "chat-1",
    messageId: "42",
    senderId: "7",
    text: "Task: rotate this key sk_live_abcdefghijklmnopqrstuvwxyz",
    occurredAt: new Date("2026-06-19T11:59:00.000Z"),
  });

  assert.equal(result.createdTaskIds.length, 1);
  assert.equal(result.redactedFindingCount, 1);
  assert.match(extractor.seenText, /\[REDACTED:api_key\]/);
  assert.doesNotMatch(extractor.seenText, /sk_live/);
  assert.equal(taskRepository.tasks.size, 1);
  assert.equal(memoryRepository.records.length, 1);
  assert.equal(memoryRepository.records[0]?.type, "Task");
  assert.equal(memoryRepository.records[0]?.source.messageId, "42");
  assert.equal(memoryRepository.records[0]?.confidence, 0.95);
  assert.equal(syncRepository.records.size, 1);
  assert.equal(provider.synced[0]?.title, "Rotate production secret");
  assert.equal(auditRepository.records.length, 1);
  assert.equal(auditRepository.records[0]?.extractedTasks[0]?.confidence, 0.95);
  assert.equal(auditRepository.records[0]?.extractedTasks[0]?.extractionReason, "Matched test candidate.");
  assert.match(auditRepository.records[0]?.redactedContentPreview ?? "", /\[REDACTED:api_key\]/);
  assert.equal(metrics.snapshot().messagesProcessed, 1);
  assert.equal(metrics.snapshot().syncSuccessRate, 1);
});

test("extracts structured memory after redaction and links task memory to project context", async () => {
  const taskRepository = new InMemoryTaskRepository();
  const memoryRepository = new InMemoryMemoryRepository();
  const syncRepository = new InMemorySyncRepository();
  const useCase = new ProcessIncomingMessageUseCase(
    new RegexSecretDetector(),
    new RecordingExtractor(),
    taskRepository,
    memoryRepository,
    syncRepository,
    new RecordingTaskProvider(),
    new FixedClock(),
    new SilentLogger(),
    new InMemoryAuditRepository(),
    new InMemoryMetricsCollector(),
    new RuleBasedMemoryExtractor(),
  );

  const result = await useCase.execute({
    platform: "telegram",
    conversationId: "chat-1",
    messageId: "44",
    senderId: "7",
    text: [
      "Project: Atlas - migration launch",
      "Decision: use Cloudflare Workers for the API sk_live_abcdefghijklmnopqrstuvwxyz",
      "Blocker: waiting on legal review",
      "Deadline: launch by 2026-07-01",
      "Task: rotate production secret",
    ].join("\n"),
    occurredAt: new Date("2026-06-19T11:59:00.000Z"),
  });

  assert.equal(result.createdTaskIds.length, 1);
  assert.equal(result.createdMemoryRecordIds.length, 5);
  assert.equal(memoryRepository.records.some((record) => record.type === "Project"), true);
  assert.equal(memoryRepository.records.some((record) => record.type === "Decision"), true);
  assert.equal(memoryRepository.records.some((record) => record.type === "Blocker"), true);
  assert.equal(memoryRepository.records.some((record) => record.type === "Deadline"), true);
  assert.equal(memoryRepository.records.every((record) => record.source.messageId === "44"), true);
  assert.equal(memoryRepository.records.every((record) => record.timestamp.toISOString() === "2026-06-19T12:00:00.000Z"), true);
  assert.equal(memoryRepository.records.every((record) => record.confidence > 0), true);
  assert.equal(memoryRepository.records.find((record) => record.type === "Task")?.project?.name, "Atlas");
  assert.doesNotMatch(JSON.stringify(memoryRepository.records), /sk_live/);
  assert.match(JSON.stringify(memoryRepository.records), /\[REDACTED:api_key\]/);
});

test("records failed Notion syncs without rolling back local persistence", async () => {
  const extractor = new RecordingExtractor();
  const taskRepository = new InMemoryTaskRepository();
  const memoryRepository = new InMemoryMemoryRepository();
  const syncRepository = new InMemorySyncRepository();
  const auditRepository = new InMemoryAuditRepository();
  const metrics = new InMemoryMetricsCollector();
  const useCase = new ProcessIncomingMessageUseCase(
    new RegexSecretDetector(),
    extractor,
    taskRepository,
    memoryRepository,
    syncRepository,
    new FailingTaskProvider(),
    new FixedClock(),
    new SilentLogger(),
    auditRepository,
    metrics,
  );

  const result = await useCase.execute({
    platform: "telegram",
    conversationId: "chat-1",
    messageId: "43",
    senderId: "7",
    text: "Task: rotate production secret",
    occurredAt: new Date("2026-06-19T11:59:00.000Z"),
  });

  assert.equal(result.createdTaskIds.length, 1);
  assert.equal(result.failedSyncCount, 1);
  assert.equal(taskRepository.tasks.size, 1);
  assert.equal(memoryRepository.records.length, 1);
  assert.equal(syncRepository.records.size, 0);
  assert.equal(auditRepository.records[0]?.extractedTasks[0]?.syncStatus, "failed");
  assert.match(auditRepository.records[0]?.errorLogs[0] ?? "", /Notion sync failed/);
  assert.equal(metrics.snapshot().syncSuccessRate, 0);
});

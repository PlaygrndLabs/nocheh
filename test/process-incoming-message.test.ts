import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "../src/application/dto/incoming-message.js";
import type { ClockPort } from "../src/application/ports/clock.js";
import type { LoggerPort } from "../src/application/ports/logger.js";
import type { MemoryRecordRepositoryPort } from "../src/application/ports/memory-record-repository.js";
import type { SecretDetectorPort } from "../src/application/ports/secret-detector.js";
import type { TaskExtractorPort } from "../src/application/ports/task-extractor.js";
import type { ExternalTask, TaskProviderPort } from "../src/application/ports/task-provider.js";
import type { TaskRepositoryPort } from "../src/application/ports/task-repository.js";
import type { TaskSyncRepositoryPort } from "../src/application/ports/task-sync-repository.js";
import type { MemoryRecord } from "../src/domain/memory/memory-record.js";
import type { ExtractedTaskCandidate } from "../src/domain/tasks/task-extraction.js";
import type { Task, TaskId } from "../src/domain/tasks/task.js";
import { RegexSecretDetector } from "../src/infrastructure/security/regex-secret-detector.js";
import { ProcessIncomingMessageUseCase } from "../src/application/use-cases/process-incoming-message.js";

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

class RecordingExtractor implements TaskExtractorPort {
  public seenText = "";

  public async extractTasks(message: IncomingMessage): Promise<readonly ExtractedTaskCandidate[]> {
    this.seenText = message.text;
    return [{ title: "Rotate production secret", confidence: 0.95, priority: "high" }];
  }
}

test("processes sanitized messages into tasks, memory records, and provider sync state", async () => {
  const secretDetector: SecretDetectorPort = new RegexSecretDetector();
  const extractor = new RecordingExtractor();
  const taskRepository = new InMemoryTaskRepository();
  const memoryRepository = new InMemoryMemoryRepository();
  const syncRepository = new InMemorySyncRepository();
  const provider = new RecordingTaskProvider();
  const useCase = new ProcessIncomingMessageUseCase(
    secretDetector,
    extractor,
    taskRepository,
    memoryRepository,
    syncRepository,
    provider,
    new FixedClock(),
    new SilentLogger(),
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
  assert.equal(syncRepository.records.size, 1);
  assert.equal(provider.synced[0]?.title, "Rotate production secret");
});

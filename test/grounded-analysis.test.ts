import test from "node:test";
import assert from "node:assert/strict";
import { ProcessIncomingMessageUseCase } from "../src/application/use-cases/process-incoming-message.js";
import { AssistantContextBuilder } from "../src/application/services/assistant-context-builder.js";
import { RegexSecretDetector } from "../src/infrastructure/security/regex-secret-detector.js";
import { createGroupAssistantSettings } from "../src/domain/assistant/group-assistant-settings.js";
import type { ClockPort } from "../src/application/ports/clock.js";
import type { LoggerPort } from "../src/application/ports/logger.js";
import type { AuditRepositoryPort } from "../src/application/ports/audit-repository.js";
import type { MemoryRecordRepositoryPort } from "../src/application/ports/memory-record-repository.js";
import type { MemoryQuery, MemoryRetrievalPort, MemorySearchResult } from "../src/application/ports/memory-retrieval.js";
import type { TaskRepositoryPort } from "../src/application/ports/task-repository.js";
import type { TaskSyncRepositoryPort } from "../src/application/ports/task-sync-repository.js";
import type { ExternalTask, TaskProviderPort } from "../src/application/ports/task-provider.js";
import type { ConversationAnalysisInput, MemoryGraphAnalysis, MemoryGraphAnalyzerPort } from "../src/application/ports/memory-graph-analyzer.js";
import type { MemoryRecord, MemoryRecordType } from "../src/domain/memory/memory-record.js";
import type { ProcessingAuditRecord } from "../src/domain/observability/audit.js";
import type { Task, TaskId } from "../src/domain/tasks/task.js";

const occurredAt = new Date("2026-06-21T10:00:00.000Z");

const EMPTY_ANALYSIS: MemoryGraphAnalysis = {
  memories: [],
  nodes: [],
  edges: [],
  suggestions: [],
  tasks: [],
  statusUpdates: [],
  warnings: [],
};

/**
 * The read path, end to end at the use-case level.
 *
 * Phase 3 wrote embeddings and never read them. These tests pin the thing that closed
 * that loop: what the brain is told about a window now includes what is already known.
 */
test("a window is analysed with recalled memory in its grounding context", async () => {
  const retrieval = new RecordingRetrieval([
    memoryRecord("memory-1", "Decision", "Charge the retainer monthly, not per hour"),
  ]);
  const analyzer = new StubAnalyzer(() => EMPTY_ANALYSIS);
  const useCase = buildUseCase({ analyzer, contextBuilder: new AssistantContextBuilder(retrieval) });

  await useCase.executeWindow({
    platform: "telegram",
    conversationId: "chat-1",
    messages: [message("m-1", "Should I quote this new client hourly?")],
  });

  const context = analyzer.lastInput?.contextText ?? "";
  assert.match(context, /Charge the retainer monthly/);
  // The analyzer already receives the window as structured messages; grounding it with
  // the message text again would pay for every message twice.
  assert.doesNotMatch(context, /quote this new client hourly/);
  // The query is the window, so recall is about this conversation and not the whole corpus.
  assert.match(retrieval.queries[0]?.text ?? "", /quote this new client hourly/);
});

test("recall queries the sanitized window, never the raw one", async () => {
  // The query text leaves the process for an embedding provider, so it is an external
  // call and sits behind the same gate the analyzer does.
  const retrieval = new RecordingRetrieval([]);
  const analyzer = new StubAnalyzer(() => EMPTY_ANALYSIS);
  const useCase = buildUseCase({ analyzer, contextBuilder: new AssistantContextBuilder(retrieval) });

  await useCase.executeWindow({
    platform: "telegram",
    conversationId: "chat-1",
    messages: [message("m-1", "deploy key is sk_live_abcdefghijklmnopqrstuvwxyz")],
  });

  assert.equal(retrieval.queries.length, 1);
  assert.doesNotMatch(retrieval.queries[0]?.text ?? "", /sk_live/);
  assert.match(retrieval.queries[0]?.text ?? "", /\[REDACTED:api_key\]/);
});

test("resolved conversation settings bound the context instead of domain defaults", async () => {
  const retrieval = new RecordingRetrieval([]);
  const analyzer = new StubAnalyzer(() => EMPTY_ANALYSIS);
  const useCase = buildUseCase({ analyzer, contextBuilder: new AssistantContextBuilder(retrieval) });

  await useCase.executeWindow(
    {
      platform: "telegram",
      conversationId: "chat-1",
      messages: [message("m-1", "first"), message("m-2", "second")],
    },
    createGroupAssistantSettings({
      conversationId: "chat-1",
      maxRetrievedMemories: 3,
      maxRecentMessages: 1,
    }, occurredAt),
  );

  assert.equal(retrieval.queries[0]?.limit, 3);
  // maxRecentMessages trimmed the query to the newest message only.
  assert.equal(retrieval.queries[0]?.text, "second");
});

test("a recall failure costs grounding, not the window", async () => {
  const analyzer = new StubAnalyzer(() => EMPTY_ANALYSIS);
  const audit = new InMemoryAuditRepository();
  const useCase = buildUseCase({
    analyzer,
    audit,
    contextBuilder: new AssistantContextBuilder(new FailingRetrieval()),
  });

  await useCase.executeWindow({
    platform: "telegram",
    conversationId: "chat-1",
    messages: [message("m-1", "keep this window")],
  });

  assert.equal(analyzer.lastInput?.contextText, undefined);
  assert.match(analyzer.seenText, /keep this window/);
  const record = audit.records[0];
  const contextStep = record?.steps.find((entry) => entry.name === "context_build");
  assert.equal(contextStep?.status, "failed");
  assert.equal(record?.errorLogs.some((line) => line.includes("Context build failed")), true);
});

test("with no context builder the brain analyses the window alone", async () => {
  const analyzer = new StubAnalyzer(() => EMPTY_ANALYSIS);
  const audit = new InMemoryAuditRepository();
  const useCase = buildUseCase({ analyzer, audit });

  await useCase.executeWindow({
    platform: "telegram",
    conversationId: "chat-1",
    messages: [message("m-1", "no memory configured")],
  });

  assert.equal(analyzer.lastInput?.contextText, undefined);
  assert.equal(audit.records[0]?.steps.some((entry) => entry.name === "context_build"), false);
});

function buildUseCase(options: {
  readonly analyzer: MemoryGraphAnalyzerPort;
  readonly contextBuilder?: AssistantContextBuilder;
  readonly audit?: AuditRepositoryPort;
}): ProcessIncomingMessageUseCase {
  return new ProcessIncomingMessageUseCase(
    new RegexSecretDetector(),
    options.analyzer,
    new InMemoryTaskRepository(),
    new InMemoryMemoryRepository(),
    new InMemorySyncRepository(),
    new RecordingTaskProvider(),
    new FixedClock(),
    new SilentLogger(),
    options.audit ?? new InMemoryAuditRepository(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.contextBuilder,
  );
}

function message(messageId: string, text: string) {
  return {
    platform: "telegram",
    conversationId: "chat-1",
    messageId,
    senderId: "7",
    text,
    occurredAt,
  };
}

function memoryRecord(id: string, type: MemoryRecordType, title: string): MemoryRecord {
  return {
    id,
    type,
    source: { platform: "telegram", conversationId: "chat-1", messageId: "m-old", occurredAt },
    timestamp: occurredAt,
    confidence: 0.9,
    decision: { title, outcome: title },
  };
}

class StubAnalyzer implements MemoryGraphAnalyzerPort {
  public lastInput: ConversationAnalysisInput | undefined;
  public seenText = "";

  public constructor(private readonly build: () => MemoryGraphAnalysis) {}

  public async analyze(input: ConversationAnalysisInput): Promise<MemoryGraphAnalysis> {
    this.lastInput = input;
    this.seenText = input.window.messages.map((entry) => entry.text).join("\n");
    return this.build();
  }
}

class RecordingRetrieval implements MemoryRetrievalPort {
  public readonly queries: MemoryQuery[] = [];

  public constructor(private readonly records: readonly MemoryRecord[]) {}

  public async query(query: MemoryQuery): Promise<readonly MemorySearchResult[]> {
    this.queries.push(query);
    return this.records.map((record) => ({ record, score: 1 }));
  }
}

class FailingRetrieval implements MemoryRetrievalPort {
  public async query(): Promise<readonly MemorySearchResult[]> {
    throw new Error("embedding endpoint unreachable");
  }
}

class FixedClock implements ClockPort {
  public now(): Date {
    return new Date("2026-06-21T10:05:00.000Z");
  }
}

class SilentLogger implements LoggerPort {
  public info(): void {}
  public warn(): void {}
  public error(): void {}
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

class InMemoryTaskRepository implements TaskRepositoryPort {
  private readonly tasks = new Map<TaskId, Task>();

  public async save(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
  }

  public async findById(id: TaskId): Promise<Task | undefined> {
    return this.tasks.get(id);
  }

  public async findOpen(): Promise<readonly Task[]> {
    return [...this.tasks.values()];
  }

  public async findBySourceMessageId(): Promise<readonly Task[]> {
    return [];
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

  public async findByProjectId(): Promise<readonly MemoryRecord[]> {
    return [];
  }
}

class InMemorySyncRepository implements TaskSyncRepositoryPort {
  public async findByTaskId(): Promise<ExternalTask | undefined> {
    return undefined;
  }

  public async save(): Promise<void> {}
}

class RecordingTaskProvider implements TaskProviderPort {
  public async upsertTask(task: Task): Promise<ExternalTask> {
    return { provider: "notion", externalId: `notion-${task.id}`, taskId: task.id };
  }
}

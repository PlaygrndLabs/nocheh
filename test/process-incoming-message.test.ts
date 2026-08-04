import test from "node:test";
import assert from "node:assert/strict";
import type { ConversationAnalysisInput, MemoryGraphAnalysis, MemoryGraphAnalyzerPort } from "../src/application/ports/memory-graph-analyzer.js";
import type { ClockPort } from "../src/application/ports/clock.js";
import type { LoggerPort } from "../src/application/ports/logger.js";
import type { MemoryRecordRepositoryPort } from "../src/application/ports/memory-record-repository.js";
import type { AuditRepositoryPort } from "../src/application/ports/audit-repository.js";
import type { ExternalTask, TaskProviderPort } from "../src/application/ports/task-provider.js";
import type { TaskRepositoryPort } from "../src/application/ports/task-repository.js";
import type { TaskSyncRepositoryPort } from "../src/application/ports/task-sync-repository.js";
import type { MemoryRecord, MemoryRecordType } from "../src/domain/memory/memory-record.js";
import { projectIdFromName } from "../src/domain/memory/memory-record.js";
import type { ProcessingAuditRecord } from "../src/domain/observability/audit.js";
import type { Task, TaskId } from "../src/domain/tasks/task.js";
import type { SecretDetectorPort } from "../src/application/ports/secret-detector.js";
import { RegexSecretDetector } from "../src/infrastructure/security/regex-secret-detector.js";
import { ProcessIncomingMessageUseCase } from "../src/application/use-cases/process-incoming-message.js";
import { InMemoryMetricsCollector } from "../src/infrastructure/observability/in-memory-metrics-collector.js";
import type { MemoryGraphRepositoryPort } from "../src/application/ports/memory-graph-repository.js";
import type { MemoryEdge, MemoryNode } from "../src/domain/memory/memory-graph.js";
import { createMemoryEdge, createMemoryNode } from "../src/domain/memory/memory-graph.js";

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

  public async findBySourceMessageId(messageId: string): Promise<readonly Task[]> {
    return [...this.tasks.values()].filter((task) => task.source.messageId === messageId);
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

const EMPTY_ANALYSIS: MemoryGraphAnalysis = {
  memories: [],
  nodes: [],
  edges: [],
  suggestions: [],
  tasks: [],
  statusUpdates: [],
  warnings: [],
};

/** A test double for the brain that records its input and returns a scripted analysis. */
class StubAnalyzer implements MemoryGraphAnalyzerPort {
  public lastInput: ConversationAnalysisInput | undefined;
  public seenText = "";

  public constructor(private readonly build: (input: ConversationAnalysisInput) => MemoryGraphAnalysis) {}

  public async analyze(input: ConversationAnalysisInput): Promise<MemoryGraphAnalysis> {
    this.lastInput = input;
    this.seenText = input.window.messages.map((message) => message.text).join("\n");
    return this.build(input);
  }
}

test("redacts before analysis, then persists tasks, memory, and provider sync state", async () => {
  const analyzer = new StubAnalyzer((input) => ({
    ...EMPTY_ANALYSIS,
    tasks: [{
      title: "Rotate production secret",
      confidence: 0.95,
      priority: "high",
      extractionReason: "Matched test candidate.",
      sourceMessageId: input.window.messages[0]?.messageId ?? "unknown",
    }],
  }));
  const taskRepository = new InMemoryTaskRepository();
  const memoryRepository = new InMemoryMemoryRepository();
  const syncRepository = new InMemorySyncRepository();
  const provider = new RecordingTaskProvider();
  const auditRepository = new InMemoryAuditRepository();
  const metrics = new InMemoryMetricsCollector();
  const useCase = new ProcessIncomingMessageUseCase(
    new RegexSecretDetector(),
    analyzer,
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
    text: "Please rotate this key sk_live_abcdefghijklmnopqrstuvwxyz",
    occurredAt: new Date("2026-06-19T11:59:00.000Z"),
  });

  assert.equal(result.createdTaskIds.length, 1);
  assert.equal(result.redactedFindingCount, 1);
  assert.match(analyzer.seenText, /\[REDACTED:api_key\]/);
  assert.doesNotMatch(analyzer.seenText, /sk_live/);
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
  assert.equal(auditRepository.records[0]?.extractedTasks[0]?.sourceMessageId, "42");
  assert.match(auditRepository.records[0]?.redactedContentPreview ?? "", /\[REDACTED:api_key\]/);
  assert.equal(metrics.snapshot().messagesProcessed, 1);
  assert.equal(metrics.snapshot().syncSuccessRate, 1);
});

test("persists structured memory candidates and links task memory to project context", async () => {
  const analyzer = new StubAnalyzer(() => ({
    ...EMPTY_ANALYSIS,
    memories: [
      {
        sourceMessageId: "44",
        candidate: {
          type: "Project",
          confidence: 0.9,
          extractionReason: "Project named.",
          project: { id: projectIdFromName("Atlas"), name: "Atlas" },
          projectMemory: { name: "Atlas", description: "migration launch" },
        },
      },
      {
        sourceMessageId: "44",
        candidate: {
          type: "Decision",
          confidence: 0.85,
          extractionReason: "Decision made.",
          decision: { title: "API platform", outcome: "Use Cloudflare Workers" },
        },
      },
      {
        sourceMessageId: "44",
        candidate: {
          type: "Blocker",
          confidence: 0.8,
          extractionReason: "Blocker raised.",
          blocker: { description: "waiting on legal review", status: "open" },
        },
      },
      {
        sourceMessageId: "44",
        candidate: {
          type: "Deadline",
          confidence: 0.82,
          extractionReason: "Deadline stated.",
          deadline: { title: "launch", dueAt: new Date("2026-07-01T00:00:00.000Z") },
        },
      },
    ],
    tasks: [{
      title: "rotate production secret",
      confidence: 0.9,
      extractionReason: "Task requested.",
      sourceMessageId: "44",
    }],
  }));
  const taskRepository = new InMemoryTaskRepository();
  const memoryRepository = new InMemoryMemoryRepository();
  const useCase = new ProcessIncomingMessageUseCase(
    new RegexSecretDetector(),
    analyzer,
    taskRepository,
    memoryRepository,
    new InMemorySyncRepository(),
    new RecordingTaskProvider(),
    new FixedClock(),
    new SilentLogger(),
    new InMemoryAuditRepository(),
    new InMemoryMetricsCollector(),
  );

  const result = await useCase.execute({
    platform: "telegram",
    conversationId: "chat-1",
    messageId: "44",
    senderId: "7",
    text: "Atlas migration: pick a platform, watch legal, launch by July.",
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
  assert.equal(memoryRepository.records.find((record) => record.type === "Task")?.project?.name, "Atlas");
});

test("records failed Notion syncs without rolling back local persistence", async () => {
  const analyzer = new StubAnalyzer((input) => ({
    ...EMPTY_ANALYSIS,
    tasks: [{
      title: "rotate production secret",
      confidence: 0.95,
      extractionReason: "Task requested.",
      sourceMessageId: input.window.messages[0]?.messageId ?? "43",
    }],
  }));
  const taskRepository = new InMemoryTaskRepository();
  const memoryRepository = new InMemoryMemoryRepository();
  const syncRepository = new InMemorySyncRepository();
  const auditRepository = new InMemoryAuditRepository();
  const metrics = new InMemoryMetricsCollector();
  const useCase = new ProcessIncomingMessageUseCase(
    new RegexSecretDetector(),
    analyzer,
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
    text: "rotate production secret",
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

test("analyzes a multi-message window and attributes each task to its source message", async () => {
  const analyzer = new StubAnalyzer((input) => ({
    ...EMPTY_ANALYSIS,
    tasks: input.window.messages.map((message, index) => ({
      title: `task from message ${message.messageId}`,
      confidence: 0.9,
      extractionReason: "Derived from window.",
      sourceMessageId: message.messageId,
      priority: index === 0 ? "high" : "medium",
    })),
  }));
  const taskRepository = new InMemoryTaskRepository();
  const useCase = new ProcessIncomingMessageUseCase(
    new RegexSecretDetector(),
    analyzer,
    taskRepository,
    new InMemoryMemoryRepository(),
    new InMemorySyncRepository(),
    new RecordingTaskProvider(),
    new FixedClock(),
    new SilentLogger(),
  );

  const result = await useCase.executeWindow({
    platform: "telegram",
    conversationId: "chat-9",
    messages: [
      { platform: "telegram", conversationId: "chat-9", messageId: "100", senderId: "a", text: "let's ship the beta", occurredAt: new Date("2026-06-19T11:50:00.000Z") },
      { platform: "telegram", conversationId: "chat-9", messageId: "101", senderId: "b", text: "and write release notes", occurredAt: new Date("2026-06-19T11:52:00.000Z"), replyToMessageId: "100" },
    ],
  });

  assert.equal(analyzer.lastInput?.window.messages.length, 2);
  assert.equal(result.createdTaskIds.length, 2);
  const sources = [...taskRepository.tasks.values()].map((task) => task.source.messageId).sort();
  assert.deepEqual(sources, ["100", "101"]);
});

test("applies an inferred status update to an existing task from the same source message", async () => {
  const taskRepository = new InMemoryTaskRepository();
  const createAnalyzer = new StubAnalyzer(() => ({
    ...EMPTY_ANALYSIS,
    tasks: [{ title: "prepare release notes", confidence: 0.9, extractionReason: "requested", sourceMessageId: "200" }],
  }));
  const closeAnalyzer = new StubAnalyzer(() => ({
    ...EMPTY_ANALYSIS,
    statusUpdates: [{ targetMessageId: "200", status: "completed", reason: "done reaction", confidence: 0.9 }],
  }));
  const shared = {
    memory: new InMemoryMemoryRepository(),
    sync: new InMemorySyncRepository(),
    provider: new RecordingTaskProvider(),
    clock: new FixedClock(),
    logger: new SilentLogger(),
  };

  const createUseCase = new ProcessIncomingMessageUseCase(
    new RegexSecretDetector(), createAnalyzer, taskRepository, shared.memory, shared.sync, shared.provider, shared.clock, shared.logger,
  );
  await createUseCase.execute({
    platform: "telegram", conversationId: "chat-2", messageId: "200", senderId: "7",
    text: "prepare release notes", occurredAt: new Date("2026-06-19T11:59:00.000Z"),
  });
  assert.equal([...taskRepository.tasks.values()][0]?.status, "open");

  const closeUseCase = new ProcessIncomingMessageUseCase(
    new RegexSecretDetector(), closeAnalyzer, taskRepository, shared.memory, shared.sync, shared.provider, shared.clock, shared.logger,
  );
  const result = await closeUseCase.execute({
    platform: "telegram", conversationId: "chat-2", messageId: "200", senderId: "7",
    text: "(done reaction)", occurredAt: new Date("2026-06-19T12:05:00.000Z"),
  });

  assert.equal(result.statusUpdateCount, 1);
  assert.equal([...taskRepository.tasks.values()][0]?.status, "completed");
});

test("executeReaction interprets a reaction and closes the task derived from that message", async () => {
  const taskRepository = new InMemoryTaskRepository();
  const memory = new InMemoryMemoryRepository();
  const sync = new InMemorySyncRepository();
  const provider = new RecordingTaskProvider();
  const clock = new FixedClock();
  const logger = new SilentLogger();

  const createAnalyzer = new StubAnalyzer(() => ({
    ...EMPTY_ANALYSIS,
    tasks: [{ title: "prepare release notes", confidence: 0.9, extractionReason: "requested", sourceMessageId: "300" }],
  }));
  await new ProcessIncomingMessageUseCase(
    new RegexSecretDetector(), createAnalyzer, taskRepository, memory, sync, provider, clock, logger,
  ).execute({
    platform: "mock", conversationId: "chat-3", messageId: "300", senderId: "a",
    text: "can someone prepare the release notes?", occurredAt: new Date("2026-06-19T11:59:00.000Z"),
  });
  assert.equal([...taskRepository.tasks.values()][0]?.status, "open");

  // The reaction analyzer should see the candidate target and the reaction emoji, then decide to complete it.
  const reactionAnalyzer = new StubAnalyzer((input) => {
    assert.equal(input.candidateTargets?.[0]?.kind, "task");
    assert.equal(input.window.messages[0]?.reactions?.[0]?.emoji, "\u2705");
    return { ...EMPTY_ANALYSIS, statusUpdates: [{ targetMessageId: "300", status: "completed", reason: "done reaction", confidence: 0.95 }] };
  });
  const reactionUseCase = new ProcessIncomingMessageUseCase(
    new RegexSecretDetector(), reactionAnalyzer, taskRepository, memory, sync, provider, clock, logger,
  );

  const result = await reactionUseCase.executeReaction({
    platform: "mock",
    conversationId: "chat-3",
    targetMessageId: "300",
    reactorId: "b",
    reactions: [{ emoji: "\u2705", reactorId: "b" }],
    occurredAt: new Date("2026-06-19T12:10:00.000Z"),
  });

  assert.equal(result.statusUpdateCount, 1);
  assert.equal([...taskRepository.tasks.values()][0]?.status, "completed");
  assert.ok(reactionAnalyzer.lastInput !== undefined);
});

test("executeReaction is a no-op when no prior knowledge exists for the message", async () => {
  const taskRepository = new InMemoryTaskRepository();
  const analyzer = new StubAnalyzer(() => EMPTY_ANALYSIS);
  const useCase = new ProcessIncomingMessageUseCase(
    new RegexSecretDetector(), analyzer, taskRepository, new InMemoryMemoryRepository(),
    new InMemorySyncRepository(), new RecordingTaskProvider(), new FixedClock(), new SilentLogger(),
  );

  const result = await useCase.executeReaction({
    platform: "mock",
    conversationId: "chat-x",
    targetMessageId: "999",
    reactorId: "b",
    reactions: [{ emoji: "\u{1F44D}", reactorId: "b" }],
    occurredAt: new Date("2026-06-19T12:10:00.000Z"),
  });

  assert.equal(result.statusUpdateCount, 0);
  assert.equal(analyzer.lastInput, undefined);
});

test("executeNote treats a note as an authoritative window and offers open tasks as candidates", async () => {
  const taskRepository = new InMemoryTaskRepository();
  const memory = new InMemoryMemoryRepository();
  const graphNodes = new Map<string, unknown>();

  // Seed an open task so the note has a candidate target.
  const seedAnalyzer = new StubAnalyzer(() => ({
    ...EMPTY_ANALYSIS,
    tasks: [{ title: "draft the pitch", confidence: 0.9, extractionReason: "seed", sourceMessageId: "500" }],
  }));
  await new ProcessIncomingMessageUseCase(
    new RegexSecretDetector(), seedAnalyzer, taskRepository, memory,
    new InMemorySyncRepository(), new RecordingTaskProvider(), new FixedClock(), new SilentLogger(),
  ).execute({
    platform: "mock", conversationId: "chat-note", messageId: "500", senderId: "a",
    text: "someone should draft the pitch", occurredAt: new Date("2026-06-19T11:00:00.000Z"),
  });

  const noteAnalyzer = new StubAnalyzer((input) => {
    assert.equal(input.window.note, "Remember: our launch date moved to August.");
    assert.equal(input.window.platform, "note");
    assert.ok((input.candidateTargets?.length ?? 0) >= 1);
    assert.equal(input.candidateTargets?.[0]?.kind, "task");
    return {
      ...EMPTY_ANALYSIS,
      memories: [{
        sourceMessageId: input.window.messages[0]?.messageId ?? "note",
        candidate: {
          type: "Deadline",
          confidence: 0.9,
          extractionReason: "note",
          deadline: { title: "Launch", dueAt: new Date("2026-08-01T00:00:00.000Z") },
        },
      }],
    };
  });
  const result = await new ProcessIncomingMessageUseCase(
    new RegexSecretDetector(), noteAnalyzer, taskRepository, memory,
    new InMemorySyncRepository(), new RecordingTaskProvider(), new FixedClock(), new SilentLogger(),
  ).executeNote({ conversationId: "chat-note", text: "Remember: our launch date moved to August." });

  void graphNodes;
  assert.equal(result.createdMemoryRecordIds.length, 1);
  assert.equal(memory.records.some((record) => record.type === "Deadline"), true);
  assert.ok(noteAnalyzer.lastInput !== undefined);
});

test("fails closed when the secret guard is unavailable: nothing is analysed or persisted", async () => {
  const analyzer = new StubAnalyzer(() => EMPTY_ANALYSIS);
  const taskRepository = new InMemoryTaskRepository();
  const memoryRepository = new InMemoryMemoryRepository();
  const auditRepository = new InMemoryAuditRepository();
  const failingGuard: SecretDetectorPort = {
    redact: async () => {
      throw guardError();
    },
    redactMany: async () => {
      throw guardError();
    },
  };
  const useCase = new ProcessIncomingMessageUseCase(
    failingGuard,
    analyzer,
    taskRepository,
    memoryRepository,
    new InMemorySyncRepository(),
    new RecordingTaskProvider(),
    new FixedClock(),
    new SilentLogger(),
    auditRepository,
    new InMemoryMetricsCollector(),
  );

  await assert.rejects(useCase.execute({
    platform: "telegram",
    conversationId: "chat-1",
    messageId: "42",
    senderId: "7",
    text: "the wifi password is bluebird77",
    occurredAt: new Date("2026-06-19T11:59:00.000Z"),
  }), /Secret guard model call failed/);

  // The analysis model never saw the text, and no knowledge was written.
  assert.equal(analyzer.lastInput, undefined);
  assert.equal(taskRepository.tasks.size, 0);
  assert.equal(memoryRepository.records.length, 0);

  // The stall is audited, so a stuck conversation is visible rather than silent.
  assert.equal(auditRepository.records.length, 1);
  const record = auditRepository.records[0];
  assert.equal(record?.steps.find((step) => step.name === "secret_detection")?.status, "failed");
  assert.equal(record?.steps.find((step) => step.name === "redaction")?.status, "skipped");
  assert.equal(record?.steps.some((step) => step.name === "analysis"), false);
  // The preview must not leak the unredacted text it failed to guard.
  assert.doesNotMatch(record?.redactedContentPreview ?? "", /bluebird77/);
});

test("attachment descriptions reach the analysis model and are redacted first", async () => {
  const analyzer = new StubAnalyzer(() => EMPTY_ANALYSIS);
  const useCase = new ProcessIncomingMessageUseCase(
    new RegexSecretDetector(),
    analyzer,
    new InMemoryTaskRepository(),
    new InMemoryMemoryRepository(),
    new InMemorySyncRepository(),
    new RecordingTaskProvider(),
    new FixedClock(),
    new SilentLogger(),
    new InMemoryAuditRepository(),
    new InMemoryMetricsCollector(),
  );

  await useCase.execute({
    platform: "telegram",
    conversationId: "chat-1",
    messageId: "42",
    senderId: "7",
    text: "",
    occurredAt: new Date("2026-06-19T11:59:00.000Z"),
    attachments: [{
      kind: "image",
      fileUniqueId: "u-1",
      fileId: "file-1",
      understanding: {
        description: "A screenshot with sk_live_abcdefghijklmnopqrstuvwxyz visible.",
        confidence: 0.9,
        provider: "stub",
        model: "stub",
      },
    }],
  });

  const described = analyzer.lastInput?.window.messages[0]?.attachments?.[0]?.understanding?.description ?? "";
  assert.match(described, /\[REDACTED:api_key\]/);
  assert.doesNotMatch(described, /sk_live/);
});

test("a media-only message is still processed instead of being treated as empty", async () => {
  const analyzer = new StubAnalyzer((input) => ({
    ...EMPTY_ANALYSIS,
    tasks: [{
      title: "Follow up on the whiteboard plan",
      confidence: 0.8,
      extractionReason: "From the image description.",
      sourceMessageId: input.window.messages[0]?.messageId ?? "unknown",
    }],
  }));
  const taskRepository = new InMemoryTaskRepository();
  const useCase = new ProcessIncomingMessageUseCase(
    new RegexSecretDetector(),
    analyzer,
    taskRepository,
    new InMemoryMemoryRepository(),
    new InMemorySyncRepository(),
    new RecordingTaskProvider(),
    new FixedClock(),
    new SilentLogger(),
  );

  const result = await useCase.execute({
    platform: "telegram",
    conversationId: "chat-1",
    messageId: "42",
    senderId: "7",
    text: "",
    occurredAt: new Date("2026-06-19T11:59:00.000Z"),
    attachments: [{
      kind: "image",
      fileUniqueId: "u-1",
      fileId: "file-1",
      understanding: {
        description: "A whiteboard listing next steps for the partner deal.",
        confidence: 0.9,
        provider: "stub",
        model: "stub",
      },
    }],
  });

  assert.equal(result.createdTaskIds.length, 1);
  assert.equal(taskRepository.tasks.size, 1);
});

function guardError(): Error {
  const error = new Error("Secret guard model call failed: provider down");
  error.name = "SecretGuardUnavailableError";
  return error;
}

/**
 * A graph store that mimics the real SQLite foreign key on `memory_edges`: an edge
 * whose endpoints are not present throws, exactly as `foreign_keys = ON` makes it.
 */
class ForeignKeyMemoryGraphRepository implements MemoryGraphRepositoryPort {
  public readonly nodes = new Map<string, MemoryNode>();
  public readonly edges = new Map<string, MemoryEdge>();

  public async saveNode(node: MemoryNode): Promise<void> {
    this.nodes.set(node.id, node);
  }

  public async saveEdge(edge: MemoryEdge): Promise<void> {
    if (!this.nodes.has(edge.fromNodeId) || !this.nodes.has(edge.toNodeId)) {
      throw new Error("FOREIGN KEY constraint failed");
    }
    this.edges.set(edge.id, edge);
  }

  public async findNodeById(id: string): Promise<MemoryNode | undefined> {
    return this.nodes.get(id);
  }

  public async findEdgeById(id: string): Promise<MemoryEdge | undefined> {
    return this.edges.get(id);
  }

  public async listNodes(): Promise<readonly MemoryNode[]> {
    return [...this.nodes.values()];
  }

  public async listEdgesForNode(nodeId: string): Promise<readonly MemoryEdge[]> {
    return [...this.edges.values()].filter((edge) => edge.fromNodeId === nodeId || edge.toNodeId === nodeId);
  }

  public async listEdgesByRelation(relation: MemoryEdge["relation"]): Promise<readonly MemoryEdge[]> {
    return [...this.edges.values()].filter((edge) => edge.relation === relation);
  }

  public async findNodesBySourceMessageId(messageId: string): Promise<readonly MemoryNode[]> {
    return [...this.nodes.values()].filter((node) => node.source.messageId === messageId);
  }
}

const graphSource = {
  platform: "telegram",
  conversationId: "chat-1",
  messageId: "77",
  occurredAt: new Date("2026-06-19T11:59:00.000Z"),
};

function graphMessage() {
  return {
    platform: "telegram",
    conversationId: "chat-1",
    messageId: "77",
    senderId: "7",
    text: "Acme needs a launch decision this week.",
    occurredAt: graphSource.occurredAt,
  };
}

function graphUseCase(
  analyzer: StubAnalyzer,
  graphRepository: MemoryGraphRepositoryPort,
  auditRepository: AuditRepositoryPort,
): ProcessIncomingMessageUseCase {
  return new ProcessIncomingMessageUseCase(
    new RegexSecretDetector(),
    analyzer,
    new InMemoryTaskRepository(),
    new InMemoryMemoryRepository(),
    new InMemorySyncRepository(),
    new RecordingTaskProvider(),
    new FixedClock(),
    new SilentLogger(),
    auditRepository,
    new InMemoryMetricsCollector(),
    graphRepository,
  );
}

test("analysis warnings reach the audit trail, not just a count", async () => {
  const analyzer = new StubAnalyzer(() => ({
    ...EMPTY_ANALYSIS,
    warnings: [
      "Dropped graph node: node kind must be one of: person, project. Received \"startup\".",
      "Could not tell which project the deadline belongs to.",
    ],
  }));
  const auditRepository = new InMemoryAuditRepository();
  await graphUseCase(analyzer, new ForeignKeyMemoryGraphRepository(), auditRepository)
    .execute(graphMessage());

  const record = auditRepository.records[0];
  assert.equal(record?.steps.find((entry) => entry.name === "analysis")?.metadata.warningCount, 2);
  assert.deepEqual(record?.errorLogs, [
    "Analysis warning: Dropped graph node: node kind must be one of: person, project. Received \"startup\".",
    "Analysis warning: Could not tell which project the deadline belongs to.",
  ]);
});

test("an edge pointing at a node nobody created is dropped, and the window still audits", async () => {
  const project = createMemoryNode({
    id: "project:acme",
    kind: "project",
    label: "Acme site",
    scope: "project",
    source: graphSource,
    confidence: 0.9,
  });
  const goodEdge = createMemoryEdge({
    id: "edge:acme-decision",
    fromNodeId: "project:acme",
    toNodeId: "project:acme",
    relation: "PROJECT_HAS_DECISION",
    fact: "Acme has a launch decision",
    source: graphSource,
    confidence: 0.9,
  });
  const danglingEdge = createMemoryEdge({
    id: "edge:acme-ghost",
    fromNodeId: "project:acme",
    toNodeId: "person:ghost",
    relation: "CLIENT_OWNS_PROJECT",
    fact: "A person nobody described owns Acme",
    source: graphSource,
    confidence: 0.9,
  });
  const analyzer = new StubAnalyzer(() => ({
    ...EMPTY_ANALYSIS,
    nodes: [project],
    // Order matters: the dangling edge comes first, so a thrown error would abort
    // before the good edge and before the audit record was written.
    edges: [danglingEdge, goodEdge],
  }));
  const graphRepository = new ForeignKeyMemoryGraphRepository();
  const auditRepository = new InMemoryAuditRepository();

  const result = await graphUseCase(analyzer, graphRepository, auditRepository).execute(graphMessage());

  assert.deepEqual(result.createdMemoryGraphNodeIds, ["project:acme"]);
  assert.deepEqual(result.createdMemoryGraphEdgeIds, ["edge:acme-decision"]);
  assert.equal(graphRepository.edges.has("edge:acme-ghost"), false);
  const record = auditRepository.records[0];
  assert.equal(auditRepository.records.length, 1, "the audit record survives a bad edge");
  const graphStep = record?.steps.find((entry) => entry.name === "graph_persistence");
  assert.equal(graphStep?.status, "succeeded");
  assert.equal(graphStep?.metadata.edgeCount, 1);
  assert.equal(graphStep?.metadata.droppedEdgeCount, 1);
  assert.match(record?.errorLogs.join("\n") ?? "", /Graph edge edge:acme-ghost dropped: unknown node person:ghost\./);
});

test("an edge onto a node stored by an earlier window is kept", async () => {
  const graphRepository = new ForeignKeyMemoryGraphRepository();
  await graphRepository.saveNode(createMemoryNode({
    id: "person:mak",
    kind: "person",
    label: "Mak",
    scope: "user",
    source: graphSource,
    confidence: 1,
  }));
  const project = createMemoryNode({
    id: "project:acme",
    kind: "project",
    label: "Acme site",
    scope: "project",
    source: graphSource,
    confidence: 0.9,
  });
  const analyzer = new StubAnalyzer(() => ({
    ...EMPTY_ANALYSIS,
    nodes: [project],
    edges: [createMemoryEdge({
      id: "edge:mak-acme",
      fromNodeId: "person:mak",
      toNodeId: "project:acme",
      relation: "PERSON_WORKS_ON_PROJECT",
      fact: "Mak works on the Acme site",
      source: graphSource,
      confidence: 0.9,
    })],
  }));
  const auditRepository = new InMemoryAuditRepository();

  const result = await graphUseCase(analyzer, graphRepository, auditRepository).execute(graphMessage());

  assert.deepEqual(result.createdMemoryGraphEdgeIds, ["edge:mak-acme"]);
  assert.deepEqual(auditRepository.records[0]?.errorLogs, []);
});

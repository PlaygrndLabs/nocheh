import test from "node:test";
import assert from "node:assert/strict";
import type { ConversationWindow } from "../src/application/dto/conversation-window.js";
import type { ConversationWindowProcessorPort } from "../src/application/ports/incoming-message-processor.js";
import type { MemoryGraphRepositoryPort } from "../src/application/ports/memory-graph-repository.js";
import type { MemoryRecordRepositoryPort } from "../src/application/ports/memory-record-repository.js";
import type { SuggestionRepositoryPort } from "../src/application/ports/suggestion-repository.js";
import type { TaskRepositoryPort } from "../src/application/ports/task-repository.js";
import type { AuditRepositoryPort } from "../src/application/ports/audit-repository.js";
import { InMemoryMetricsCollector } from "../src/infrastructure/observability/in-memory-metrics-collector.js";
import type { MemoryRecord, MemoryRecordType } from "../src/domain/memory/memory-record.js";
import type { MemoryEdge, MemoryEdgeId, MemoryNode, MemoryNodeId, MemoryRelation } from "../src/domain/memory/memory-graph.js";
import type { Suggestion, SuggestionId, SuggestionStatus } from "../src/domain/memory/strategic-suggestion.js";
import type { Task, TaskId } from "../src/domain/tasks/task.js";
import type { ProcessingAuditRecord } from "../src/domain/observability/audit.js";
import type { AssistantContext } from "../src/application/services/assistant-context-builder.js";
import type {
  MemoryBenchmarkManifest,
  MemoryBenchmarkMessage,
  MemoryBenchmarkQuestion,
} from "../src/domain/evaluation/memory-benchmark.js";
import {
  NochehMemoryBenchmarkBackend,
} from "../src/infrastructure/evaluation/nocheh-memory-benchmark-backend.js";
import {
  HonchoMemoryBenchmarkBackend,
  SdkHonchoBenchmarkClient,
  type HonchoBenchmarkClientPort,
  type HonchoBenchmarkStoredMessage,
} from "../src/infrastructure/evaluation/honcho-memory-benchmark-backend.js";

class Records implements MemoryRecordRepositoryPort {
  public readonly values: MemoryRecord[] = [];
  public async save(record: MemoryRecord): Promise<void> { this.values.push(record); }
  public async findAll(): Promise<readonly MemoryRecord[]> { return this.values; }
  public async findByType(type: MemoryRecordType): Promise<readonly MemoryRecord[]> {
    return this.values.filter((record) => record.type === type);
  }
  public async findByProjectId(): Promise<readonly MemoryRecord[]> { return []; }
}

class Graph implements MemoryGraphRepositoryPort {
  public readonly nodes: MemoryNode[] = [];
  public readonly edges: MemoryEdge[] = [];
  public async saveNode(node: MemoryNode): Promise<void> { this.nodes.push(node); }
  public async saveEdge(edge: MemoryEdge): Promise<void> { this.edges.push(edge); }
  public async findNodeById(id: MemoryNodeId): Promise<MemoryNode | undefined> {
    return this.nodes.find((node) => node.id === id);
  }
  public async findEdgeById(id: MemoryEdgeId): Promise<MemoryEdge | undefined> {
    return this.edges.find((edge) => edge.id === id);
  }
  public async listNodes(): Promise<readonly MemoryNode[]> { return this.nodes; }
  public async listEdgesForNode(id: MemoryNodeId): Promise<readonly MemoryEdge[]> {
    return this.edges.filter((edge) => edge.fromNodeId === id || edge.toNodeId === id);
  }
  public async listEdgesByRelation(relation: MemoryRelation): Promise<readonly MemoryEdge[]> {
    return this.edges.filter((edge) => edge.relation === relation);
  }
  public async findNodesBySourceMessageId(messageId: string): Promise<readonly MemoryNode[]> {
    return this.nodes.filter((node) => node.source.messageId === messageId);
  }
}

class Suggestions implements SuggestionRepositoryPort {
  public readonly values: Suggestion[] = [];
  public async save(value: Suggestion): Promise<void> { this.values.push(value); }
  public async findById(id: SuggestionId): Promise<Suggestion | undefined> {
    return this.values.find((value) => value.id === id);
  }
  public async findByStatus(status: SuggestionStatus): Promise<readonly Suggestion[]> {
    return this.values.filter((value) => value.status === status);
  }
  public async findPending(): Promise<readonly Suggestion[]> { return this.findByStatus("pending"); }
}

class Tasks implements TaskRepositoryPort {
  public readonly values: Task[] = [];
  public async save(task: Task): Promise<void> { this.values.push(task); }
  public async findById(id: TaskId): Promise<Task | undefined> { return this.values.find((task) => task.id === id); }
  public async findOpen(): Promise<readonly Task[]> { return this.values.filter((task) => task.status !== "completed"); }
  public async findBySourceMessageId(messageId: string): Promise<readonly Task[]> {
    return this.values.filter((task) => task.source.messageId === messageId);
  }
}

class Audits implements AuditRepositoryPort {
  public readonly values: ProcessingAuditRecord[] = [];
  public async save(value: ProcessingAuditRecord): Promise<void> { this.values.push(value); }
  public async findRecent(limit: number): Promise<readonly ProcessingAuditRecord[]> { return this.values.slice(-limit); }
}

class WindowProcessor implements ConversationWindowProcessorPort {
  public readonly windows: ConversationWindow[] = [];
  public constructor(private readonly records: Records, private readonly metrics: InMemoryMetricsCollector) {}
  public async executeWindow(window: ConversationWindow): Promise<void> {
    this.windows.push(window);
    const source = window.messages[0];
    if (source !== undefined) {
      await this.records.save({
        id: `record-${source.messageId}`,
        type: "Summary",
        source: {
          platform: source.platform,
          conversationId: source.conversationId,
          messageId: source.messageId,
          occurredAt: source.occurredAt,
        },
        timestamp: source.occurredAt,
        confidence: 1,
        summary: { title: "Launch color", summary: "The launch color is cobalt", coveredRecordIds: [] },
      });
    }
    this.metrics.recordAiTokenUsage({
      provider: "test",
      model: "analysis-v1",
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
      reasoningTokens: 2,
    });
  }
}

test("Nocheh adapter preserves chronological source ids and recalls rendered structured evidence", async () => {
  const records = new Records();
  const graph = new Graph();
  const suggestions = new Suggestions();
  const tasks = new Tasks();
  const audits = new Audits();
  const metrics = new InMemoryMetricsCollector();
  const processor = new WindowProcessor(records, metrics);
  const contextBuilder = {
    async build(): Promise<AssistantContext> {
      const memory = records.values[0];
      assert.ok(memory);
      return {
        conversationId: "query",
        currentMessages: [],
        memories: [memory],
        graphNodes: [],
        graphEdges: [],
        acceptedRules: [],
        pendingSuggestions: [],
        tokenBudget: 200,
        text: "Relevant structured memory:\n- Summary: Launch color The launch color is cobalt",
        groundingText: "Relevant structured memory:\n- Summary: Launch color The launch color is cobalt",
      };
    },
  };
  const times = numberSequence(0, 100, 110, 125);
  const backend = new NochehMemoryBenchmarkBackend({
    externalEffects: "disabled",
    processor,
    contextBuilder,
    memoryRecords: records,
    graph,
    suggestions,
    tasks,
    audits,
    metrics,
    storage: { async measure() { return { databaseBytes: 2_000, indexBytes: 500 }; } },
  }, { id: "owned", version: "1", windowMessageCount: 2, nowMs: times });

  const messages = [message("m1", "c1", 1), message("m2", "c1", 2), message("m3", "c2", 3), message("m4", "c1", 4)];
  const prepared = await backend.prepare(messages, manifest("owned", "1"));
  assert.deepEqual(processor.windows.flatMap((window) => window.messages.map((entry) => entry.messageId)), ["m1", "m2", "m3", "m4"]);
  assert.equal(processor.windows.length, 3, "conversation boundaries must not be reordered to make bigger batches");
  assert.equal(prepared.observations.windows, 3);
  assert.equal(prepared.observations.memoryRecords, 3);
  assert.equal(prepared.observations.reasoningTokens, 6);
  assert.equal(prepared.databaseBytes, 2_000);

  const recall = await backend.recall(question(), 200);
  assert.deepEqual(recall.evidence, [{
    evidenceId: "memory:record-m1",
    sourceId: "m1",
    text: "Launch color The launch color is cobalt",
  }]);
  assert.ok(recall.contextTokens <= 200);
});

class FakeHonchoClient implements HonchoBenchmarkClientPort {
  public readonly batches: string[][] = [];
  public queueChecks = 0;
  public empty = true;
  public searchResults: readonly HonchoBenchmarkStoredMessage[] = [];
  public async isEmpty() { return { empty: this.empty, apiCalls: 1 }; }
  public async addMessages(_conversationId: string, messages: readonly MemoryBenchmarkMessage[]) {
    this.batches.push(messages.map((message) => message.id));
    return { storedMessages: messages.length, inputTokens: messages.length * 4, apiCalls: 2 };
  }
  public async search() { return { messages: this.searchResults, apiCalls: 1 }; }
  public async queueStatus() {
    this.queueChecks += 1;
    return {
      status: {
        totalWorkUnits: 2,
        completedWorkUnits: this.queueChecks > 1 ? 2 : 0,
        inProgressWorkUnits: this.queueChecks > 1 ? 0 : 1,
        pendingWorkUnits: this.queueChecks > 1 ? 0 : 1,
      },
      apiCalls: 1,
    };
  }
  public async chat() { return { answer: "native answer", apiCalls: 1 }; }
}

test("Honcho adapter waits for derivation, preserves source metadata, and caps context", async () => {
  const client = new FakeHonchoClient();
  client.searchResults = [
    { id: "remote-1", sourceId: "m1", text: "cobalt ".repeat(100), tokenCount: 100 },
    { id: "remote-2", sourceId: "m2", text: "second result", tokenCount: 3 },
  ];
  const times = numberSequence(0, 10, 20, 30, 40, 50, 60);
  const backend = new HonchoMemoryBenchmarkBackend(client, {
    id: "honcho",
    version: "3",
    ingestBatchSize: 2,
    queuePollIntervalMs: 1,
    nowMs: times,
    sleep: async () => {},
  });
  const prepared = await backend.prepare(
    [message("m1", "c1", 1), message("m2", "c1", 2), message("m3", "c2", 3)],
    manifest("honcho", "3"),
  );

  assert.deepEqual(client.batches, [["m1", "m2"], ["m3"]]);
  assert.equal(client.queueChecks, 2);
  assert.equal(prepared.observations.usageTelemetryMissing, 1);
  assert.equal(prepared.ingestedMessages, 3);

  const recall = await backend.recall(question(), 20);
  assert.equal(recall.evidence[0]?.evidenceId, "remote-1");
  assert.equal(recall.evidence[0]?.sourceId, "m1");
  assert.ok(recall.contextTokens <= 20);
  assert.equal(recall.evidence.length, 1, "a truncated first result must consume the fixed budget");

  const native = await backend.nativeRecall(question());
  assert.equal(native.answer, "native answer");
});

test("Honcho SDK client is loopback-only for private corpora unless explicitly approved", () => {
  assert.throws(
    () => new SdkHonchoBenchmarkClient({ baseUrl: "https://api.honcho.dev", workspaceId: "private" }),
    /loopback Honcho host/,
  );
  assert.doesNotThrow(
    () => new SdkHonchoBenchmarkClient({ baseUrl: "http://127.0.0.1:8000", workspaceId: "private" }),
  );
});

function message(id: string, conversationId: string, minute: number): MemoryBenchmarkMessage {
  return {
    id,
    conversationId,
    senderId: "owner",
    senderDisplayName: "Owner",
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
    text: `guarded ${id}`,
    language: "en",
  };
}

function question(): MemoryBenchmarkQuestion {
  return {
    id: "q1",
    prompt: "What is the launch color?",
    categories: ["factual_recall"],
    expectedSourceIds: ["m1"],
    expectedFacts: ["cobalt"],
  };
}

function manifest(systemId: string, version: string): MemoryBenchmarkManifest {
  return {
    schemaVersion: 1,
    id: "test",
    frozenAt: "2026-01-01T00:00:00.000Z",
    corpus: {
      id: "test",
      kind: "synthetic_scale",
      messageCount: 1,
      occurredAtStart: "2026-01-01T00:00:00.000Z",
      occurredAtEnd: "2026-01-01T00:00:00.000Z",
      saltedSha256: "a".repeat(64),
      hashSalt: "1234567890abcdef",
    },
    systems: [
      { id: systemId, version, configuration: {}, modelIds: {}, networkDestinations: ["none"], backgroundJobs: [] },
      { id: "comparison", version: "1", configuration: {}, modelIds: {}, networkDestinations: ["none"], backgroundJobs: [] },
    ],
    answerModel: { provider: "test", modelId: "test", version: "1" },
    contextTokenBudget: 200,
    qualityTieMargin: 0.01,
    maximumAcceptableMonthlyCostUsd: 10,
    thresholds: {
      minimumSourceValidRecall: 0,
      minimumAnswerAccuracy: 0,
      minimumPersianRecall: 0,
      minimumMultiHopRecall: 0,
      maximumStaleFactRate: 1,
      maximumDuplicateRate: 1,
      maximumP95RetrievalLatencyMs: 1_000,
      maximumContextTokens: 200,
      maximumQueueLagMs: 1_000,
    },
  };
}

function numberSequence(...values: readonly number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

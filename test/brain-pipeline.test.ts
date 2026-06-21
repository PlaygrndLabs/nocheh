import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ClockPort } from "../src/application/ports/clock.js";
import type { LoggerPort } from "../src/application/ports/logger.js";
import type { TaskExtractorPort } from "../src/application/ports/task-extractor.js";
import type { ExternalTask, TaskProviderPort } from "../src/application/ports/task-provider.js";
import { ProcessIncomingMessageUseCase } from "../src/application/use-cases/process-incoming-message.js";
import type { Task } from "../src/domain/tasks/task.js";
import { RuleBasedMemoryGraphAnalyzer } from "../src/infrastructure/reasoning/rule-based-memory-graph-analyzer.js";
import { RuleBasedMemoryExtractor } from "../src/infrastructure/reasoning/rule-based-memory-extractor.js";
import { AesGcmEncryption } from "../src/infrastructure/security/aes-gcm-encryption.js";
import { RegexSecretDetector } from "../src/infrastructure/security/regex-secret-detector.js";
import { openSqliteDatabase } from "../src/infrastructure/sqlite/sqlite-database.js";
import { SqliteAuditRepository } from "../src/infrastructure/sqlite/sqlite-audit-repository.js";
import { SqliteMemoryGraphRepository } from "../src/infrastructure/sqlite/sqlite-memory-graph-repository.js";
import { SqliteMemoryRecordRepository } from "../src/infrastructure/sqlite/sqlite-memory-record-repository.js";
import { SqliteSuggestionRepository } from "../src/infrastructure/sqlite/sqlite-suggestion-repository.js";
import { SqliteTaskRepository } from "../src/infrastructure/sqlite/sqlite-task-repository.js";
import { SqliteTaskSyncRepository } from "../src/infrastructure/sqlite/sqlite-task-sync-repository.js";
import { createBrainRoutes } from "../src/interfaces/http/api/create-brain-routes.js";
import type { RequestContext } from "../src/interfaces/http/router.js";

const now = new Date("2026-06-21T12:00:00.000Z");

class FixedClock implements ClockPort {
  public now(): Date {
    return now;
  }
}

class SilentLogger implements LoggerPort {
  public info(): void {}
  public warn(): void {}
  public error(): void {}
}

class NoopTaskExtractor implements TaskExtractorPort {
  public async extractTasks(): Promise<readonly []> {
    return [];
  }
}

class NoopTaskProvider implements TaskProviderPort {
  public async upsertTask(task: Task): Promise<ExternalTask> {
    return { provider: "noop", externalId: task.id, taskId: task.id };
  }
}

test("processing pipeline persists live memory graph and pending suggestions", async () => {
  const database = openSqliteDatabase(join(await mkdtemp(join(tmpdir(), "nocheh-brain-")), "brain.sqlite"));
  try {
    const encryption = new AesGcmEncryption("brain-pipeline-test-secret");
    const graphRepository = new SqliteMemoryGraphRepository(database, encryption);
    const suggestionRepository = new SqliteSuggestionRepository(database, encryption);
    const useCase = new ProcessIncomingMessageUseCase(
      new RegexSecretDetector(),
      new NoopTaskExtractor(),
      new SqliteTaskRepository(database, encryption),
      new SqliteMemoryRecordRepository(database, encryption),
      new SqliteTaskSyncRepository(database, encryption),
      new NoopTaskProvider(),
      new FixedClock(),
      new SilentLogger(),
      new SqliteAuditRepository(database, encryption),
      undefined,
      new RuleBasedMemoryExtractor(),
      new RuleBasedMemoryGraphAnalyzer(),
      graphRepository,
      suggestionRepository,
    );

    const result = await useCase.execute({
      platform: "telegram",
      conversationId: "chat-1",
      messageId: "message-1",
      senderId: "mak",
      text: "I want English routine, X content ideas, startup partner goals, and crypto thesis but do not trade.",
      occurredAt: now,
    });

    assert.equal(result.createdTaskIds.length, 0);
    assert.ok(result.createdMemoryGraphNodeIds.length >= 1);
    assert.ok(result.createdMemoryGraphEdgeIds.length >= 1);
    assert.ok(result.createdSuggestionIds.includes("suggestion:block-auto-trade"));
    assert.equal((await graphRepository.findNodeById("goal:english-growth"))?.label, "English growth");
    assert.equal((await graphRepository.listEdgesByRelation("GOAL_HAS_ROUTINE")).length, 1);
    assert.equal((await suggestionRepository.findPending()).some((suggestion) => suggestion.id === "suggestion:block-auto-trade"), true);

    const routes = createBrainRoutes(graphRepository, suggestionRepository);
    const graph = await routes.graph(context({ method: "GET" }));
    assert.equal(graph.status, 200);
    assert.ok(((graph.body as { nodes: readonly unknown[] }).nodes.length) >= 1);

    const approved = await routes.approveSuggestion(context({
      method: "POST",
      params: { id: "suggestion:english-routine" },
    }));
    assert.equal(approved.status, 200);
    assert.equal((await suggestionRepository.findById("suggestion:english-routine"))?.status, "accepted");
  } finally {
    database.close();
  }
});

function context(overrides: Partial<RequestContext>): RequestContext {
  return {
    method: "POST",
    path: "/",
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    raw: undefined as never,
    ...overrides,
  };
}

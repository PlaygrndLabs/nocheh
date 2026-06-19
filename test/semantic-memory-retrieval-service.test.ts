import test from "node:test";
import assert from "node:assert/strict";
import type { MemoryRecord, MemoryRecordType } from "../src/domain/memory/memory-record.js";
import { projectIdFromName } from "../src/domain/memory/memory-record.js";
import type { MemoryRecordRepositoryPort } from "../src/application/ports/memory-record-repository.js";
import { SemanticMemoryRetrievalService } from "../src/infrastructure/memory/semantic-memory-retrieval-service.js";
import { MemoryQueryService } from "../src/application/services/memory-query-service.js";

class InMemoryMemoryRepository implements MemoryRecordRepositoryPort {
  public constructor(private readonly records: readonly MemoryRecord[]) {}

  public async save(): Promise<void> {}

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

const source = {
  platform: "telegram",
  conversationId: "chat-1",
  messageId: "1",
  occurredAt: new Date("2026-06-19T10:00:00.000Z"),
};

test("queries structured memory by semantic token overlap", async () => {
  const project = { id: projectIdFromName("Atlas"), name: "Atlas" };
  const repository = new InMemoryMemoryRepository([
    {
      id: "decision-1",
      type: "Decision",
      source,
      timestamp: new Date("2026-06-19T11:00:00.000Z"),
      confidence: 0.9,
      project,
      decision: { title: "Use Workers", outcome: "Use Cloudflare Workers for the API" },
    },
    {
      id: "blocker-1",
      type: "Blocker",
      source,
      timestamp: new Date("2026-06-19T12:00:00.000Z"),
      confidence: 0.8,
      project,
      blocker: { description: "Waiting on legal review", status: "open" },
    },
  ]);
  const retrieval = new SemanticMemoryRetrievalService(repository);

  const results = await retrieval.query({ text: "Cloudflare API decision", limit: 1 });

  assert.equal(results[0]?.record.id, "decision-1");
  assert.ok((results[0]?.score ?? 0) > 0);
});

test("answers decision, blocker, and project status queries", async () => {
  const project = { id: projectIdFromName("Atlas"), name: "Atlas" };
  const repository = new InMemoryMemoryRepository([
    {
      id: "decision-1",
      type: "Decision",
      source,
      timestamp: new Date("2026-06-19T11:00:00.000Z"),
      confidence: 0.9,
      project,
      decision: { title: "Use Workers", outcome: "Use Cloudflare Workers for the API" },
    },
    {
      id: "blocker-1",
      type: "Blocker",
      source,
      timestamp: new Date("2026-06-19T12:00:00.000Z"),
      confidence: 0.8,
      project,
      blocker: { description: "Waiting on legal review", status: "open" },
    },
  ]);
  const service = new MemoryQueryService(repository, new SemanticMemoryRetrievalService(repository));

  assert.deepEqual((await service.decisions("Atlas")).map((record) => record.id), ["decision-1"]);
  assert.deepEqual((await service.openBlockers()).map((record) => record.id), ["blocker-1"]);
  assert.deepEqual((await service.projectStatus("Atlas")).map((record) => record.id), ["blocker-1", "decision-1"]);
});

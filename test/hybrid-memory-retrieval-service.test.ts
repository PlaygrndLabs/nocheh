import test from "node:test";
import assert from "node:assert/strict";
import type { EmbeddingPort, EmbeddingRequest, EmbeddingResult } from "../src/application/ports/embedding.js";
import type {
  MemoryEmbedding,
  MemoryEmbeddingRepositoryPort,
} from "../src/application/ports/memory-embedding-repository.js";
import type { MemoryRecordRepositoryPort } from "../src/application/ports/memory-record-repository.js";
import type { LoggerPort } from "../src/application/ports/logger.js";
import type { MemoryRecord, MemoryRecordType } from "../src/domain/memory/memory-record.js";
import { memoryRecordSummary, memoryRecordText } from "../src/domain/memory/memory-record.js";
import { HybridMemoryRetrievalService } from "../src/infrastructure/memory/hybrid-memory-retrieval-service.js";
import { EmbeddingIndexingMemoryRecordRepository } from "../src/application/services/memory-embedding-indexer.js";
import { normalizeVector } from "../src/shared/vector.js";

const source = {
  platform: "telegram",
  conversationId: "chat-1",
  messageId: "m-1",
  occurredAt: new Date("2026-03-04T10:00:00.000Z"),
};

class InMemoryMemoryRecordRepository implements MemoryRecordRepositoryPort {
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

class InMemoryEmbeddingRepository implements MemoryEmbeddingRepositoryPort {
  public readonly embeddings = new Map<string, MemoryEmbedding>();

  public async save(embedding: MemoryEmbedding): Promise<void> {
    this.embeddings.set(embedding.recordId, embedding);
  }

  public async findAll(): Promise<readonly MemoryEmbedding[]> {
    return [...this.embeddings.values()];
  }

  public async indexedRecordIds(): Promise<readonly string[]> {
    return [...this.embeddings.keys()];
  }
}

class SilentLogger implements LoggerPort {
  public readonly warnings: string[] = [];
  public info(): void {}
  public warn(message: string): void {
    this.warnings.push(message);
  }
  public error(): void {}
}

/**
 * A stand-in for a real embedding model.
 *
 * Maps text onto a fixed set of topic axes by keyword, which is exactly what a real model
 * does continuously. That makes it possible to test the thing that matters — recall of a
 * memory that shares no words with the question — without a network call.
 */
const TOPICS = ["language", "money", "health"] as const;
const TOPIC_WORDS: Readonly<Record<typeof TOPICS[number], readonly string[]>> = {
  language: ["english", "vocabulary", "fluency", "speaking", "grammar", "practise", "practice"],
  money: ["invoice", "payment", "client", "billing", "rate", "budget"],
  health: ["sleep", "gym", "running", "energy", "diet"],
};

class TopicEmbedding implements EmbeddingPort {
  public calls: EmbeddingRequest[] = [];
  public failing = false;

  public constructor(public readonly model = "test-embed-v1") {}

  public async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    this.calls.push(request);
    if (this.failing) {
      throw new Error("embedding provider unavailable");
    }
    return {
      model: this.model,
      vectors: request.texts.map((text) => vectorFor(text)),
    };
  }
}

function vectorFor(text: string): readonly number[] {
  const words = text.toLowerCase().split(/[^a-z]+/);
  const raw = TOPICS.map((topic) => {
    const hits = words.filter((word) => TOPIC_WORDS[topic].includes(word)).length;
    // A constant keeps unrelated pairs at a realistic non-zero cosine, which is the whole
    // reason the service rescales similarity instead of thresholding it directly.
    return 0.35 + hits;
  });
  return normalizeVector(raw);
}

function summary(id: string, title: string, text: string, confidence = 1): MemoryRecord {
  return {
    id,
    type: "Summary",
    source,
    timestamp: new Date("2026-03-04T10:00:00.000Z"),
    confidence,
    summary: { title, summary: text, coveredRecordIds: [] },
  };
}

async function seed(): Promise<{
  readonly records: InMemoryMemoryRecordRepository;
  readonly embeddings: InMemoryEmbeddingRepository;
  readonly embedder: TopicEmbedding;
  readonly logger: SilentLogger;
  readonly retrieval: HybridMemoryRetrievalService;
  readonly indexer: EmbeddingIndexingMemoryRecordRepository;
}> {
  const records = new InMemoryMemoryRecordRepository();
  const embeddings = new InMemoryEmbeddingRepository();
  const embedder = new TopicEmbedding();
  const logger = new SilentLogger();
  const retrieval = new HybridMemoryRetrievalService(records, embeddings, embedder, logger);
  const indexer = new EmbeddingIndexingMemoryRecordRepository(
    records,
    embeddings,
    embedder,
    logger,
    () => { retrieval.invalidate(); },
  );
  return { records, embeddings, embedder, logger, retrieval, indexer };
}

test("recalls a memory that shares no words with the question", async () => {
  const { indexer, retrieval } = await seed();
  await indexer.save(summary("mem:fluency", "Speaking goal", "Wants fluency by speaking daily"));
  await indexer.save(summary("mem:invoice", "Billing", "Client invoice payment terms are net 30"));

  // "vocabulary" appears in neither record. Word overlap scores both at zero.
  const results = await retrieval.query({ text: "vocabulary", minimumScore: 0.01 });

  assert.equal(results[0]?.record.id, "mem:fluency", "the related memory must come first");
  assert.ok(
    (results[0]?.score ?? 0) > (results[1]?.score ?? 0),
    "the unrelated memory must score lower, not merely appear later",
  );
});

test("word overlap alone cannot do it, which is why embeddings exist", async () => {
  const { records, embeddings, logger } = await seed();
  // Same corpus, no embedding provider.
  const lexicalOnly = new HybridMemoryRetrievalService(records, embeddings, undefined, logger);
  await records.save(summary("mem:fluency", "Speaking goal", "Wants fluency by speaking daily"));

  assert.deepEqual(await lexicalOnly.query({ text: "vocabulary", minimumScore: 0.01 }), []);
});

test("exact tokens still win, because embeddings blur names and slugs", async () => {
  const { indexer, retrieval } = await seed();
  await indexer.save(summary("mem:acme", "Acme", "Acme launch checklist"));
  await indexer.save(summary("mem:zenith", "Zenith", "Zenith launch checklist"));

  // Both are the same topic to the model; only the literal name separates them.
  const results = await retrieval.query({ text: "Zenith launch", minimumScore: 0.01 });
  assert.equal(results[0]?.record.id, "mem:zenith");
});

test("a provider outage degrades to word overlap instead of failing the query", async () => {
  const { indexer, retrieval, embedder, logger } = await seed();
  await indexer.save(summary("mem:fluency", "Speaking goal", "Wants fluency by speaking daily"));

  embedder.failing = true;
  const results = await retrieval.query({ text: "speaking fluency", minimumScore: 0.01 });

  assert.equal(results.length, 1, "the lexical path still answers");
  assert.match(logger.warnings.join("\n"), /falling back to word overlap/);
});

test("a record with no vector still competes lexically, so a partial index degrades gently", async () => {
  const { records, indexer, retrieval } = await seed();
  await indexer.save(summary("mem:indexed", "Sleep", "Sleep and energy routine"));
  // Written straight to storage, bypassing the indexer: the pre-embedding backlog.
  await records.save(summary("mem:unindexed", "Invoice", "Client invoice payment terms"));

  const results = await retrieval.query({ text: "invoice payment", minimumScore: 0.01 });
  assert.ok(results.some((result) => result.record.id === "mem:unindexed"));
});

test("query and stored text are embedded with different input kinds", async () => {
  const { indexer, retrieval, embedder } = await seed();
  await indexer.save(summary("mem:1", "Sleep", "Sleep and energy routine"));
  await retrieval.query({ text: "sleep" });

  // Retrieval models are asymmetric; mixing the two kinds quietly degrades recall.
  assert.deepEqual(embedder.calls.map((call) => call.kind), ["document", "query"]);
});

test("indexing failure never costs the memory record itself", async () => {
  const { records, embeddings, embedder, indexer, logger } = await seed();
  embedder.failing = true;

  await indexer.save(summary("mem:1", "Sleep", "Sleep and energy routine"));

  assert.equal(records.records.length, 1, "the record is durable");
  assert.equal(embeddings.embeddings.size, 0, "the vector is not");
  assert.match(logger.warnings.join("\n"), /saved without an embedding/);
});

test("backfill indexes only what is missing and reports the split", async () => {
  const { records, embeddings, indexer } = await seed();
  await indexer.save(summary("mem:1", "Sleep", "Sleep and energy routine"));
  await records.save(summary("mem:2", "Invoice", "Client invoice terms"));
  await records.save(summary("mem:3", "English", "Daily english practice"));

  const result = await indexer.backfill();

  assert.deepEqual(result, { alreadyIndexed: 1, indexed: 2, failed: 0 });
  assert.equal(embeddings.embeddings.size, 3);

  // Running again costs nothing, so it is safe to retry after a partial failure.
  assert.deepEqual(await indexer.backfill(), { alreadyIndexed: 3, indexed: 0, failed: 0 });
});

test("a failing batch does not abandon the rest of the backfill", async () => {
  const { records, embeddings, embedder, indexer, logger } = await seed();
  for (let index = 0; index < 5; index += 1) {
    await records.save(summary(`mem:${index}`, "Sleep", "Sleep and energy routine"));
  }

  let call = 0;
  const original = embedder.embed.bind(embedder);
  embedder.embed = async (request) => {
    call += 1;
    if (call === 1) {
      throw new Error("rate limited");
    }
    return original(request);
  };

  const result = await indexer.backfill(2);

  assert.equal(result.failed, 2);
  assert.equal(result.indexed, 3);
  assert.equal(embeddings.embeddings.size, 3);
  assert.match(logger.warnings.join("\n"), /batch failed during backfill/);
});

test("vectors from another model are ignored rather than compared", async () => {
  const { records, embeddings, embedder, logger } = await seed();
  await records.save(summary("mem:1", "Sleep", "Sleep and energy routine"));
  await embeddings.save({ recordId: "mem:1", model: "test-embed-v1", vector: vectorFor("sleep energy") });
  await embeddings.save({ recordId: "mem:2", model: "some-other-model", vector: [1, 0, 0] });

  const retrieval = new HybridMemoryRetrievalService(records, embeddings, embedder, logger);
  await retrieval.query({ text: "sleep" });

  assert.match(logger.warnings.join("\n"), /different model and were ignored/);
});

test("confidence still scales relevance", async () => {
  const { indexer, retrieval } = await seed();
  await indexer.save(summary("mem:sure", "Sleep", "Sleep and energy routine", 1));
  await indexer.save(summary("mem:unsure", "Sleep", "Sleep and energy routine", 0.3));

  const results = await retrieval.query({ text: "sleep energy", minimumScore: 0.01 });
  assert.equal(results[0]?.record.id, "mem:sure");
  assert.ok((results[0]?.score ?? 0) > (results[1]?.score ?? 0) * 2);
});

test("limit and type filters are honoured", async () => {
  const { indexer, retrieval } = await seed();
  await indexer.save(summary("mem:1", "Sleep", "Sleep and energy routine"));
  await indexer.save(summary("mem:2", "Gym", "Gym and running plan"));
  await indexer.save(summary("mem:3", "Diet", "Diet and energy notes"));

  assert.equal((await retrieval.query({ text: "energy", limit: 2, minimumScore: 0.01 })).length, 2);
  assert.deepEqual(await retrieval.query({ text: "energy", type: "Decision", minimumScore: 0.01 }), []);
});

test("the embedded text is the type followed by the summary, and stays that way", () => {
  // memoryRecordText is what every stored vector was computed from, so its composition is
  // a storage format. Splitting the summary out for rendering must not change it, or the
  // whole index silently points at a different space and only a reindex fixes it.
  const record: MemoryRecord = {
    id: "memory-1",
    type: "Decision",
    source: { platform: "telegram", conversationId: "chat-1", messageId: "m-1", occurredAt: new Date("2026-06-21T10:00:00.000Z") },
    timestamp: new Date("2026-06-21T10:00:00.000Z"),
    confidence: 0.9,
    decision: { title: "API platform", outcome: "Use Cloudflare Workers" },
  };

  assert.equal(memoryRecordText(record), "Decision API platform Use Cloudflare Workers");
  assert.equal(memoryRecordSummary(record), "API platform Use Cloudflare Workers");
  assert.equal(memoryRecordText(record), `${record.type} ${memoryRecordSummary(record)}`);
});

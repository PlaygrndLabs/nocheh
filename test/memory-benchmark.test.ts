import test from "node:test";
import assert from "node:assert/strict";
import type { MemoryBenchmarkBackendPort } from "../src/application/ports/memory-benchmark-backend.js";
import { MemoryBenchmarkService } from "../src/application/services/memory-benchmark-service.js";
import type {
  MemoryBenchmarkManifest,
  MemoryBenchmarkMessage,
  MemoryBenchmarkPreparation,
  MemoryBenchmarkQuestion,
  MemoryBenchmarkRecall,
} from "../src/domain/evaluation/memory-benchmark.js";
import { validateMemoryBenchmarkManifest } from "../src/domain/evaluation/memory-benchmark.js";
import {
  createSyntheticMemoryBenchmarkFixture,
  saltedMemoryBenchmarkCorpusSha256,
} from "../src/infrastructure/evaluation/memory-benchmark-fixture.js";
import { RegexSecretDetector } from "../src/infrastructure/security/regex-secret-detector.js";

const zeroUsage = { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } as const;

class CapturedBackend implements MemoryBenchmarkBackendPort {
  public readonly id = "owned";
  public readonly version = "0.1.0";
  public preparedIds: readonly string[] = [];

  public async prepare(messages: readonly MemoryBenchmarkMessage[]): Promise<MemoryBenchmarkPreparation> {
    this.preparedIds = messages.map((message) => message.id);
    return {
      ingestedMessages: messages.length,
      durationMs: 20,
      databaseBytes: 1_024,
      indexBytes: 512,
      usage: zeroUsage,
      projectedMonthlyCostUsd: 4,
    };
  }

  public async recall(question: MemoryBenchmarkQuestion): Promise<MemoryBenchmarkRecall> {
    return {
      questionId: question.id,
      evidence: [
        { sourceId: "m-current", text: "بودجه فعلی 20000 USD است و گزارش باید کوتاه و فارسی باشد." },
        { sourceId: "m-current", text: "duplicate transport result" },
        { sourceId: "invented", text: "untraceable but otherwise harmless" },
      ],
      context: "not copied into report",
      contextTokens: 120,
      retrievalLatencyMs: 30,
      queueLagMs: 5,
      usage: { calls: 1, inputTokens: 20, outputTokens: 5, estimatedCostUsd: 0.01 },
      answer: { text: "بودجه فعلی 20000 USD است.", sourceIds: ["m-current"] },
    };
  }
}

test("synthetic scale fixtures are deterministic and include all required question families", () => {
  const first = createSyntheticMemoryBenchmarkFixture(1_000);
  const second = createSyntheticMemoryBenchmarkFixture(1_000);

  assert.equal(first.messages.length, 1_000);
  assert.equal(first.questions.length, 80);
  assert.deepEqual(first, second);
  assert.deepEqual(
    new Set(first.questions.flatMap((question) => question.categories)),
    new Set([
      "factual_recall",
      "persian",
      "temporal_correction",
      "contradiction",
      "multi_hop",
      "task_deadline",
      "preference",
      "long_range_coaching",
    ]),
  );
  assert.throws(() => createSyntheticMemoryBenchmarkFixture(999), /1,000, 10,000, or 100,000/);
});

test("salted aggregate corpus hashes are stable and bind the salt and order", () => {
  const messages = baseMessages();
  const original = saltedMemoryBenchmarkCorpusSha256(messages, "1234567890abcdef");

  assert.equal(original, saltedMemoryBenchmarkCorpusSha256(messages, "1234567890abcdef"));
  assert.notEqual(original, saltedMemoryBenchmarkCorpusSha256(messages, "fedcba0987654321"));
  assert.notEqual(original, saltedMemoryBenchmarkCorpusSha256([...messages].reverse(), "1234567890abcdef"));
});

test("manifest validation rejects movable gates, placeholders, and secret-bearing configuration", () => {
  const manifest = baseManifest();
  const invalid: MemoryBenchmarkManifest = {
    ...manifest,
    systems: [
      { ...manifest.systems[0]!, version: "PIN_BEFORE_RUN", configuration: { apiKey: "sk-abcdefghijklmnopqrstuvwxyz" } },
      manifest.systems[1]!,
    ],
    thresholds: { ...manifest.thresholds, maximumContextTokens: manifest.contextTokenBudget + 1 },
  };

  assert.match(validateMemoryBenchmarkManifest(invalid).join("\n"), /placeholder/);
  assert.match(validateMemoryBenchmarkManifest(invalid).join("\n"), /secret-bearing/);
  assert.match(validateMemoryBenchmarkManifest(invalid).join("\n"), /must equal contextTokenBudget/);
});

test("runner keeps raw private content out of its report and scores provenance separately", async () => {
  const backend = new CapturedBackend();
  const messages = baseMessages();
  const privatePrompt = "PRIVATE QUESTION: بودجه فعلی چیست؟";
  const privateFact = "20000 USD";
  const report = await new MemoryBenchmarkService(new RegexSecretDetector()).run({
    manifest: baseManifest(),
    manifestSha256: "a".repeat(64),
    messages,
    questions: [{
      id: "q-budget",
      prompt: privatePrompt,
      categories: ["persian", "temporal_correction"],
      expectedSourceIds: ["m-current"],
      expectedFacts: [privateFact, "گزارش باید کوتاه و فارسی باشد"],
      forbiddenFacts: ["10000 USD"],
    }],
    backend,
    now: sequenceClock("2026-08-01T00:00:00.000Z", "2026-08-01T00:00:01.000Z"),
  });

  assert.deepEqual(backend.preparedIds, ["m-old", "m-current"]);
  assert.equal(report.sourceValidRecall, 1, "duplicate expected ids must not lift recall above one");
  assert.equal(report.retrievedSourceValidity, 2 / 3, "invented provenance is measured independently");
  assert.equal(report.duplicateRate, 1 / 3);
  assert.equal(report.expectedFactRecall, 1);
  assert.equal(report.projectedMonthlyCostUsd, 4);
  assert.equal(report.gates.monthlyCost, true);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /PRIVATE QUESTION/);
  assert.doesNotMatch(serialized, /بودجه فعلی چیست/);
  assert.doesNotMatch(serialized, /گزارش باید کوتاه/);
  assert.doesNotMatch(serialized, /not copied into report/);
});

test("runner stops before a backend sees corpus text that fails the local secret gate", async () => {
  const backend = new CapturedBackend();
  const messages = baseMessages().map((message, index) => index === 0
    ? { ...message, text: "token sk_live_abcdefghijklmnopqrstuvwxyz" }
    : message);
  const manifest = {
    ...baseManifest(),
    corpus: {
      ...baseManifest().corpus,
      saltedSha256: saltedMemoryBenchmarkCorpusSha256(messages, "1234567890abcdef"),
    },
  };

  await assert.rejects(
    new MemoryBenchmarkService(new RegexSecretDetector()).run({
      manifest,
      manifestSha256: "b".repeat(64),
      messages,
      questions: [{
        id: "q-1",
        prompt: "safe",
        categories: ["factual_recall"],
        expectedSourceIds: ["m-current"],
        expectedFacts: ["safe"],
      }],
      backend,
    }),
    /ids: message:m-old/,
  );
  assert.deepEqual(backend.preparedIds, [], "prepare must not run before the gate passes");
});

function baseMessages(): readonly MemoryBenchmarkMessage[] {
  return [
    {
      id: "m-old",
      conversationId: "private-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      text: "old private text",
      language: "en",
    },
    {
      id: "m-current",
      conversationId: "private-1",
      occurredAt: "2026-02-01T00:00:00.000Z",
      text: "current private text",
      language: "mixed",
    },
  ];
}

function baseManifest(): MemoryBenchmarkManifest {
  const messages = baseMessages();
  return {
    schemaVersion: 1,
    id: "memory-gate-2026-08",
    frozenAt: "2026-08-01T00:00:00.000Z",
    corpus: {
      id: "private-quality-v1",
      kind: "private_quality",
      messageCount: messages.length,
      occurredAtStart: messages[0]!.occurredAt,
      occurredAtEnd: messages[1]!.occurredAt,
      saltedSha256: saltedMemoryBenchmarkCorpusSha256(messages, "1234567890abcdef"),
      hashSalt: "1234567890abcdef",
    },
    systems: [
      {
        id: "owned",
        version: "0.1.0",
        configuration: { lexicalWeight: 0.25 },
        modelIds: { embedding: "test-v1" },
        networkDestinations: ["none"],
        backgroundJobs: ["none"],
      },
      {
        id: "honcho",
        version: "3.0.0",
        configuration: { reasoning: true },
        modelIds: { dialectic: "test-v1" },
        networkDestinations: ["http://127.0.0.1:8000"],
        backgroundJobs: ["representation"],
      },
    ],
    answerModel: { provider: "test", modelId: "answer-v1", version: "1" },
    contextTokenBudget: 500,
    qualityTieMargin: 0.03,
    maximumAcceptableMonthlyCostUsd: 5,
    thresholds: {
      minimumSourceValidRecall: 0.8,
      minimumAnswerAccuracy: 0.8,
      minimumPersianRecall: 0.8,
      minimumMultiHopRecall: 0.8,
      maximumStaleFactRate: 0.05,
      maximumDuplicateRate: 0.4,
      maximumP95RetrievalLatencyMs: 500,
      maximumContextTokens: 500,
      maximumQueueLagMs: 1_000,
    },
  };
}

function sequenceClock(...timestamps: readonly string[]): () => Date {
  let index = 0;
  return () => new Date(timestamps[Math.min(index++, timestamps.length - 1)]!);
}

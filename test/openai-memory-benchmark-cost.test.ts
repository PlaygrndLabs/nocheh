import test from "node:test";
import assert from "node:assert/strict";
import {
  maximumOpenAiBenchmarkRunCostUsd,
  openAiMiniBenchmarkCostModel,
} from "../src/infrastructure/evaluation/openai-memory-benchmark-cost.js";
import type { MemoryBenchmarkMessage } from "../src/domain/evaluation/memory-benchmark.js";

test("the 161-message pilot has a conservative OpenAI maximum below two dollars", () => {
  const messages = Array.from({ length: 161 }, (_, index): MemoryBenchmarkMessage => ({
    id: `m${index}`,
    conversationId: "pilot",
    senderId: "owner",
    occurredAt: new Date(index * 1000).toISOString(),
    text: "guarded",
    language: "en",
  }));
  assert.equal(maximumOpenAiBenchmarkRunCostUsd(messages, 20, 8000), 1.044);
});

test("the OpenAI pilot cost model uses the pinned published token prices", () => {
  const model = openAiMiniBenchmarkCostModel("gpt-5-mini-2025-08-07");
  assert.equal(model.estimate({ calls: 1, inputTokens: 1_000_000, outputTokens: 1_000_000 }), 2.25);
  assert.throws(() => openAiMiniBenchmarkCostModel("gpt-5-mini"), /only supports pinned/);
});

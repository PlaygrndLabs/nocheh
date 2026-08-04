import test from "node:test";
import assert from "node:assert/strict";
import { validateAiAnalysisOutput, validateAiAnalysisOutputDetailed } from "../src/application/services/ai-analysis-contract.js";
import type { MemoryGraphSource } from "../src/domain/memory/memory-graph.js";

const source: MemoryGraphSource = {
  platform: "telegram",
  conversationId: "chat-1",
  messageId: "message-1",
  occurredAt: new Date("2026-06-21T10:00:00.000Z"),
};

test("validates provider-neutral AI analysis arrays before persistence", () => {
  const output = validateAiAnalysisOutput({
    memories: [envelope({ type: "insight", insight: "Mak needs a routine coach." })],
    nodes: [envelope({
      id: "goal:growth",
      kind: "goal",
      label: "Growth goal",
      scope: "user",
      source,
      confidence: 0.8,
    })],
    edges: [],
    strategicSuggestions: [],
    actionSuggestions: [],
    warnings: [{
      idempotencyKey: "warning:1",
      source,
      confidence: 0.9,
      reason: "Risk statement found.",
      message: "Crypto advice must stay decision support only.",
    }],
  });

  assert.equal(output.ok, true);
});

test("rejects partial, missing-source, and low-confidence AI analysis output", () => {
  assert.equal(validateAiAnalysisOutput({ memories: [] }).ok, false);
  const missingSource = validateAiAnalysisOutput({
    memories: [{
      idempotencyKey: "memory:1",
      confidence: 0.8,
      reason: "Missing source.",
      value: {},
    }],
    nodes: [],
    edges: [],
    strategicSuggestions: [],
    actionSuggestions: [],
    warnings: [],
  });
  assert.equal(missingSource.ok, false);
  assert.match(missingSource.ok ? "" : missingSource.error.message, /source reference/);

  const lowConfidence = validateAiAnalysisOutput({
    memories: [envelope({ type: "insight" }, 0.2)],
    nodes: [],
    edges: [],
    strategicSuggestions: [],
    actionSuggestions: [],
    warnings: [],
  }, { minimumConfidence: 0.6 });
  assert.equal(lowConfidence.ok, false);
  assert.match(lowConfidence.ok ? "" : lowConfidence.error.message, /confidence/);
});

function envelope(value: Readonly<Record<string, unknown>>, confidence = 0.8) {
  return {
    idempotencyKey: `item:${JSON.stringify(value)}`,
    source,
    confidence,
    reason: "Structured extraction with source support.",
    value,
  };
}

test("skip mode keeps good items and names every dropped one", () => {
  const result = validateAiAnalysisOutputDetailed({
    memories: [],
    nodes: [
      envelope({ id: "goal:english", kind: "goal", label: "English growth" }),
      "not an envelope",
      { source, confidence: 0.9, reason: "No key.", value: {} },
      { idempotencyKey: "k", source, confidence: 0.2, reason: "Too unsure.", value: {} },
      { idempotencyKey: "k", source, confidence: 0.9, reason: "No value.", value: "a string" },
    ],
    edges: [],
    strategicSuggestions: [],
    actionSuggestions: [],
    warnings: [],
  }, { minimumConfidence: 0.55, onInvalidItem: "skip" });

  assert.ok(result.ok);
  assert.equal(result.value.output.nodes.length, 1);
  assert.deepEqual(result.value.skipped, [
    "AI analysis nodes item must be an object.",
    "AI analysis nodes item requires idempotencyKey.",
    "AI analysis nodes item confidence must be between 0.55 and 1.",
    "AI analysis nodes item requires value.",
  ]);
});

test("skip mode still rejects a structural problem, because the window shape is not negotiable", () => {
  const result = validateAiAnalysisOutputDetailed(
    { memories: [], nodes: {}, edges: [], strategicSuggestions: [], actionSuggestions: [], warnings: [] },
    { onInvalidItem: "skip" },
  );

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error.message, /nodes must be an array/);
});

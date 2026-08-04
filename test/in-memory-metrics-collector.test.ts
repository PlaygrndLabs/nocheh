import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryMetricsCollector } from "../src/infrastructure/observability/in-memory-metrics-collector.js";

test("collects processing metrics for operator visibility", () => {
  const metrics = new InMemoryMetricsCollector();

  metrics.recordMessageProcessed(100);
  metrics.recordMessageProcessed(300);
  metrics.recordTasksExtracted(3);
  metrics.recordExtractionOutcome(true);
  metrics.recordExtractionOutcome(false);
  metrics.recordSyncOutcome(true);
  metrics.recordSyncOutcome(false);
  metrics.recordConfidence(0.5);
  metrics.recordConfidence(1);
  metrics.recordRedactionEvents(2);

  assert.deepEqual(metrics.snapshot(), {
    messagesProcessed: 2,
    tasksExtracted: 3,
    extractionSuccessRate: 0.5,
    syncSuccessRate: 0.5,
    averageConfidence: 0.75,
    redactionEvents: 2,
    averageProcessingLatencyMs: 200,
    aiCalls: 0,
    aiInputTokens: 0,
    aiOutputTokens: 0,
    aiReasoningTokens: 0,
    aiTotalTokens: 0,
  });
});

test("token usage accumulates across roles so spend is visible without reading audits", () => {
  const metrics = new InMemoryMetricsCollector();

  metrics.recordAiTokenUsage({
    provider: "nvidia",
    model: "z-ai/glm-5.2",
    inputTokens: 1534,
    outputTokens: 3194,
    totalTokens: 4728,
    reasoningTokens: 2100,
  });
  // Perception has no reasoning trace, so the thinking counter must not move.
  metrics.recordAiTokenUsage({
    provider: "nvidia",
    model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    inputTokens: 900,
    outputTokens: 1298,
    totalTokens: 2198,
  });

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.aiCalls, 2);
  assert.equal(snapshot.aiInputTokens, 2434);
  assert.equal(snapshot.aiOutputTokens, 4492);
  assert.equal(snapshot.aiReasoningTokens, 2100);
  assert.equal(snapshot.aiTotalTokens, 6926);
});

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
  });
});

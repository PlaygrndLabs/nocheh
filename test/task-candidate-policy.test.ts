import test from "node:test";
import assert from "node:assert/strict";
import { TaskCandidatePolicy } from "../src/domain/tasks/task-extraction.js";

test("filters low-confidence and invalid task candidates", () => {
  const policy = new TaskCandidatePolicy(0.7);

  const actionable = policy.actionable([
    { title: "Ship webhook", confidence: 0.9, extractionReason: "test" },
    { title: "No", confidence: 0.9, extractionReason: "test" },
    { title: "Maybe update docs", confidence: 0.4, extractionReason: "test" },
  ]);

  assert.deepEqual(actionable.map((candidate) => candidate.title), ["Ship webhook"]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { Task } from "../src/domain/tasks/task.js";
import { TaskValidationService } from "../src/domain/tasks/task-validation.js";
import type { ExtractedTaskCandidate } from "../src/domain/tasks/task-extraction.js";

const source = {
  platform: "telegram",
  conversationId: "chat-1",
  messageId: "message-1",
  occurredAt: new Date("2026-06-19T10:00:00.000Z"),
};

test("flags duplicate tasks, empty tasks, low confidence tasks, and invalid deadlines", () => {
  const service = new TaskValidationService(0.7);
  const existing = [
    Task.create({
      title: "Prepare release notes",
      source,
    }, new Date("2026-06-19T10:00:00.000Z")),
  ];
  const candidates: ExtractedTaskCandidate[] = [
    { title: "Prepare release notes", confidence: 0.95, extractionReason: "duplicate" },
    { title: " ", confidence: 0.95, extractionReason: "empty" },
    { title: "Update roadmap", confidence: 0.3, extractionReason: "weak" },
    {
      title: "Ship yesterday",
      confidence: 0.95,
      dueAt: new Date("2026-06-18T23:59:59.000Z"),
      extractionReason: "past due",
    },
  ];

  const results = service.validate(candidates, existing, new Date("2026-06-19T12:00:00.000Z"));
  const codes = results.flatMap((result) => result.warnings.map((warning) => warning.code));

  assert.deepEqual(codes, ["duplicate_task", "empty_task", "low_confidence", "invalid_deadline"]);
  assert.equal(results.every((result) => !result.accepted), true);
});

test("detects duplicates within a single extraction batch", () => {
  const service = new TaskValidationService();

  const results = service.validate([
    { title: "Update docs", confidence: 0.8, extractionReason: "first" },
    { title: "update docs!", confidence: 0.8, extractionReason: "second" },
  ], [], new Date("2026-06-19T12:00:00.000Z"));

  assert.equal(results[0]?.accepted, true);
  assert.equal(results[1]?.accepted, false);
  assert.equal(results[1]?.warnings[0]?.code, "duplicate_task");
});

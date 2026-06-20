import { expect, test } from "vitest";
import { STEP_TO_NODE, buildTimeline, botReplyText } from "./pipeline.js";
import type { AuditRecord, AuditStep } from "../api/client.js";

function step(name: string, status: AuditStep["status"], durationMs = 1): AuditStep {
  return { name, status, durationMs, metadata: {} };
}

function record(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: "audit-1",
    platform: "mock",
    conversationId: "chat-1",
    messageId: "mock:1",
    processedAt: "2026-06-20T00:00:00.000Z",
    redactedContentPreview: "Task: ship it",
    redactionFindingCount: 0,
    steps: [
      step("telegram_message", "succeeded"),
      step("secret_detection", "succeeded"),
      step("task_extraction", "succeeded"),
      step("validation", "succeeded"),
    ],
    extractedTasks: [
      { title: "ship it", confidence: 0.8, extractionReason: "imperative", accepted: true, syncStatus: "not_attempted", warnings: [] },
    ],
    errorLogs: [],
    totalLatencyMs: 5,
    ...overrides,
  };
}

test("STEP_TO_NODE maps all nine canonical pipeline steps", () => {
  const names = [
    "telegram_message", "secret_detection", "redaction", "memory_extraction",
    "memory_persistence", "task_extraction", "validation", "persistence", "notion_sync",
  ];
  for (const name of names) {
    expect(STEP_TO_NODE[name]).toBeTruthy();
  }
});

test("buildTimeline maps steps to nodes and appends audit + simulated ai + suggestion frames", () => {
  const frames = buildTimeline(record());

  // Real steps -> nodes
  expect(frames.find((f) => f.nodeId === "webhook")).toBeTruthy(); // telegram_message
  expect(frames.find((f) => f.nodeId === "task_extract")).toBeTruthy();

  // Tail: audit then the two simulated stages, in order.
  const tail = frames.slice(-3).map((f) => f.nodeId);
  expect(tail).toEqual(["audit", "ai", "bot_reply"]);
  expect(frames.at(-1)?.simulated).toBe(true);
  expect(frames.at(-2)?.simulated).toBe(true);
});

test("buildTimeline derives data labels from extracted tasks and redactions", () => {
  const frames = buildTimeline(record({ redactionFindingCount: 2 }));
  const labels = frames.map((f) => f.dataLabel).filter(Boolean);
  expect(labels.some((l) => l?.includes("redacted"))).toBe(true);
  expect(labels.some((l) => l?.includes("candidate"))).toBe(true);
  expect(labels.some((l) => l?.includes("accepted"))).toBe(true);
});

test("botReplyText summarizes accepted tasks as a suggestion, or says nothing actionable", () => {
  expect(botReplyText(record())).toMatch(/Suggestion: log 1 task: ship it/);
  expect(botReplyText(record({ extractedTasks: [] }))).toMatch(/nothing actionable/);
});

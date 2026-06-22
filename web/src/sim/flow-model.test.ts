import { expect, test } from "vitest";
import { STAGE_ORDER, STEP_TO_STAGE, botReplyText, buildFlow } from "./flow-model.js";
import { buildBrainPreview } from "./brain-preview.js";
import type { AuditRecord, AuditStep } from "../api/client.js";

function step(name: string, status: AuditStep["status"], durationMs = 1, metadata: AuditStep["metadata"] = {}): AuditStep {
  return { name, status, durationMs, metadata };
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

const emptyPreview = buildBrainPreview([]);

test("STEP_TO_STAGE maps all canonical pipeline steps", () => {
  const names = [
    "telegram_message", "secret_detection", "redaction", "memory_extraction",
    "memory_persistence", "graph_analysis", "graph_persistence", "suggestion_persistence",
    "task_extraction", "validation", "persistence", "notion_sync",
  ];
  for (const name of names) {
    expect(STEP_TO_STAGE[name]).toBeTruthy();
  }
});

test("buildFlow returns nine frames in canonical stage order", () => {
  const frames = buildFlow(record(), emptyPreview);
  expect(frames).toHaveLength(STAGE_ORDER.length);
  expect(frames.map((frame) => frame.stageId)).toEqual([...STAGE_ORDER]);
  expect(frames.at(-1)?.stageId).toBe("audit");
});

test("buildFlow resolves status: chat/receive succeed, missing stages skip, failures surface", () => {
  const frames = buildFlow(record({
    steps: [step("graph_analysis", "succeeded"), step("graph_persistence", "failed")],
  }), emptyPreview);
  expect(frames.find((frame) => frame.stageId === "chat")?.status).toBe("succeeded");
  expect(frames.find((frame) => frame.stageId === "knowledge")?.status).toBe("failed");
  expect(frames.find((frame) => frame.stageId === "memory")?.status).toBe("skipped");
});

test("protect headline reflects redaction count", () => {
  expect(buildFlow(record(), emptyPreview).find((f) => f.stageId === "protect")?.headline).toBe("clean");
  expect(buildFlow(record({ redactionFindingCount: 2 }), emptyPreview).find((f) => f.stageId === "protect")?.headline).toBe("2 redacted");
});

test("ai_brain and knowledge headlines derive from graph metadata", () => {
  const frames = buildFlow(record({
    steps: [
      step("graph_analysis", "succeeded", 3, { nodeCount: 2, edgeCount: 1, suggestionCount: 1 }),
      step("graph_persistence", "succeeded", 2, { nodeCount: 2, edgeCount: 1 }),
      step("suggestion_persistence", "succeeded", 1, { suggestionCount: 1 }),
    ],
  }), emptyPreview);
  expect(frames.find((f) => f.stageId === "ai_brain")?.headline).toBe("2 facts, 1 links");
  expect(frames.find((f) => f.stageId === "knowledge")?.headline).toBe("2 nodes, 1 links");
  expect(frames.find((f) => f.stageId === "ideas")?.headline).toBe("1 idea");
});

test("tasks frame carries accepted/total metrics and notion sync skipped", () => {
  const frame = buildFlow(record(), emptyPreview).find((f) => f.stageId === "tasks");
  expect(frame?.headline).toBe("1/1 accepted");
  expect(frame?.metrics.some((metric) => metric.label === "Notion sync" && metric.value === "skipped")).toBe(true);
});

test("ideas stage carries the approval property", () => {
  const frame = buildFlow(record(), emptyPreview).find((f) => f.stageId === "ideas");
  expect(frame?.property).toMatch(/approval/i);
});

test("botReplyText summarizes accepted tasks or says nothing actionable", () => {
  expect(botReplyText(record())).toMatch(/Suggestion: log 1 task: ship it/);
  expect(botReplyText(record({ extractedTasks: [] }))).toMatch(/nothing actionable/);
});

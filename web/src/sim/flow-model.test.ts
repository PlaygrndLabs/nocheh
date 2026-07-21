import { expect, test } from "vitest";
import { STAGE_ORDER, STEP_TO_STAGE, botReplyText, buildFlow, type FlowInsights } from "./flow-model.js";
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
    redactedContentPreview: "ship it",
    redactionFindingCount: 0,
    steps: [
      step("telegram_message", "succeeded", 1, { messageCount: 1 }),
      step("secret_detection", "succeeded"),
      step("redaction", "succeeded"),
      step("analysis", "succeeded", 3, { nodeCount: 1, edgeCount: 0, memoryCount: 1, suggestionCount: 0, taskCount: 1, warningCount: 0 }),
      step("memory_persistence", "succeeded", 1, { recordCount: 1 }),
      step("graph_persistence", "succeeded", 1, { nodeCount: 1, edgeCount: 0 }),
      step("suggestion_persistence", "succeeded", 1, { suggestionCount: 0 }),
      step("validation", "succeeded", 1, { acceptedCount: 1, warningCount: 0 }),
      step("persistence", "succeeded"),
    ],
    extractedTasks: [
      { title: "ship it", confidence: 0.8, extractionReason: "imperative", accepted: true, syncStatus: "not_attempted", warnings: [] },
    ],
    errorLogs: [],
    totalLatencyMs: 5,
    ...overrides,
  };
}

const emptyInsights: FlowInsights = { nodes: [], edges: [], suggestions: [] };

test("STEP_TO_STAGE maps the current pipeline steps, including analysis and status_update", () => {
  expect(STEP_TO_STAGE["analysis"]).toBe("ai_brain");
  expect(STEP_TO_STAGE["status_update"]).toBe("tasks");
  const names = [
    "telegram_message", "secret_detection", "redaction", "analysis",
    "memory_persistence", "graph_persistence", "suggestion_persistence",
    "validation", "persistence", "notion_sync",
  ];
  for (const name of names) {
    expect(STEP_TO_STAGE[name]).toBeTruthy();
  }
});

test("unknown step names are ignored gracefully", () => {
  const frames = buildFlow(record({ steps: [step("mystery_step", "succeeded"), step("analysis", "succeeded")] }), emptyInsights);
  expect(frames.find((frame) => frame.stageId === "ai_brain")?.status).toBe("succeeded");
});

test("buildFlow returns nine frames in canonical stage order", () => {
  const frames = buildFlow(record(), emptyInsights);
  expect(frames).toHaveLength(STAGE_ORDER.length);
  expect(frames.map((frame) => frame.stageId)).toEqual([...STAGE_ORDER]);
  expect(frames.at(-1)?.stageId).toBe("audit");
});

test("the analysis step drives the ai_brain stage", () => {
  const frames = buildFlow(record({
    steps: [step("analysis", "succeeded", 3, { nodeCount: 2, edgeCount: 1, suggestionCount: 1 })],
  }), emptyInsights);
  const brain = frames.find((frame) => frame.stageId === "ai_brain");
  expect(brain?.status).toBe("succeeded");
  expect(brain?.headline).toBe("2 facts, 1 links");
});

test("buildFlow resolves status: chat/receive succeed, missing stages skip, failures surface", () => {
  const frames = buildFlow(record({
    steps: [step("analysis", "succeeded"), step("graph_persistence", "failed")],
  }), emptyInsights);
  expect(frames.find((frame) => frame.stageId === "chat")?.status).toBe("succeeded");
  expect(frames.find((frame) => frame.stageId === "knowledge")?.status).toBe("failed");
  expect(frames.find((frame) => frame.stageId === "memory")?.status).toBe("skipped");
});

test("protect headline reflects redaction count", () => {
  expect(buildFlow(record(), emptyInsights).find((f) => f.stageId === "protect")?.headline).toBe("clean");
  expect(buildFlow(record({ redactionFindingCount: 2 }), emptyInsights).find((f) => f.stageId === "protect")?.headline).toBe("2 redacted");
});

test("knowledge and ideas headlines derive from persistence metadata", () => {
  const frames = buildFlow(record({
    steps: [
      step("analysis", "succeeded", 3, { nodeCount: 2, edgeCount: 1, suggestionCount: 1 }),
      step("graph_persistence", "succeeded", 2, { nodeCount: 2, edgeCount: 1 }),
      step("suggestion_persistence", "succeeded", 1, { suggestionCount: 1 }),
    ],
  }), emptyInsights);
  expect(frames.find((f) => f.stageId === "knowledge")?.headline).toBe("2 nodes, 1 links");
  expect(frames.find((f) => f.stageId === "ideas")?.headline).toBe("1 idea");
});

test("status_update also lands on the tasks stage", () => {
  const frames = buildFlow(record({
    steps: [step("status_update", "succeeded", 1, { requestedCount: 1, appliedCount: 1 })],
    extractedTasks: [],
  }), emptyInsights);
  expect(frames.find((f) => f.stageId === "tasks")?.status).toBe("succeeded");
});

test("tasks frame carries accepted/total metrics and a notion sync value", () => {
  const frame = buildFlow(record(), emptyInsights).find((f) => f.stageId === "tasks");
  expect(frame?.headline).toBe("1/1 accepted");
  expect(frame?.metrics.some((metric) => metric.label === "Notion sync" && metric.value === "skipped")).toBe(true);
});

test("ai_brain metrics surface token usage when present", () => {
  const withTokens = buildFlow(record({
    aiTokenUsage: { provider: "anthropic", model: "claude", inputTokens: 100, outputTokens: 40, totalTokens: 140 },
  }), emptyInsights).find((f) => f.stageId === "ai_brain");
  expect(withTokens?.metrics.some((metric) => metric.label === "Provider" && metric.value === "anthropic")).toBe(true);
  expect(withTokens?.metrics.some((metric) => metric.label === "Tokens" && metric.value === 140)).toBe(true);
});

test("knowledge samples read from the real insights graph", () => {
  const insights: FlowInsights = {
    nodes: [
      { id: "person:mak", kind: "person", label: "Mak", status: "active", confidence: 1 },
      { id: "goal:x", kind: "goal", label: "Grow X", status: "active", confidence: 0.8 },
    ],
    edges: [
      { id: "edge:1", fromNodeId: "person:mak", toNodeId: "goal:x", relation: "SUPPORTS_GOAL", status: "active", confidence: 0.8, fact: "Mak wants to grow X" },
    ],
    suggestions: [],
  };
  const samples = buildFlow(record(), insights).find((f) => f.stageId === "knowledge")?.samples ?? [];
  expect(samples[0]).toBe("Mak → supports goal → Grow X");
});

test("ideas stage carries the approval property", () => {
  const frame = buildFlow(record(), emptyInsights).find((f) => f.stageId === "ideas");
  expect(frame?.property).toMatch(/approval/i);
});

test("botReplyText summarizes accepted tasks or says nothing actionable", () => {
  expect(botReplyText(record())).toMatch(/Suggestion: log 1 task: ship it/);
  expect(botReplyText(record({ extractedTasks: [] }))).toMatch(/nothing actionable/);
});

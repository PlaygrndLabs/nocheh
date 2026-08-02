import test from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryEdge,
  createMemoryNode,
  normalizeGraphId,
  normalizeGraphLabel,
  validateConfidence,
  validateTemporalRange,
  type ExpandedMemoryPayload,
  type MemoryGraphSource,
} from "../src/domain/memory/memory-graph.js";

const source: MemoryGraphSource = {
  platform: "telegram",
  conversationId: "chat-1",
  messageId: "message-1",
  occurredAt: new Date("2026-06-21T00:00:00.000Z"),
};

test("creates a memory node with normalized label, aliases, and defaults", () => {
  const now = new Date("2026-06-21T10:00:00.000Z");
  const node = createMemoryNode({
    id: "node:mak",
    kind: "person",
    label: "  Mak   ",
    scope: "user",
    source,
    confidence: 0.92,
    aliases: [" Mak ", "mak", "M. "],
    payload: { role: "owner" },
    now,
  });

  assert.equal(node.id, "node:mak");
  assert.equal(node.kind, "person");
  assert.equal(node.label, "Mak");
  assert.equal(node.status, "active");
  assert.deepEqual(node.aliases, ["Mak", "M."]);
  assert.deepEqual(node.payload, { role: "owner" });
  assert.equal(node.createdAt, now);
  assert.equal(node.updatedAt, now);
});

test("creates a memory edge with temporal validity and normalized fact", () => {
  const validFrom = new Date("2026-06-01T00:00:00.000Z");
  const validUntil = new Date("2026-07-01T00:00:00.000Z");
  const edge = createMemoryEdge({
    id: "edge:1",
    fromNodeId: "person:mak",
    toNodeId: "goal:english",
    relation: "GOAL_HAS_ROUTINE",
    fact: "  English goal has a daily practice routine  ",
    source,
    confidence: 0.81,
    validFrom,
    validUntil,
  });

  assert.equal(edge.id, "edge:1");
  assert.equal(edge.fromNodeId, "person:mak");
  assert.equal(edge.toNodeId, "goal:english");
  assert.equal(edge.relation, "GOAL_HAS_ROUTINE");
  assert.equal(edge.fact, "English goal has a daily practice routine");
  assert.equal(edge.status, "active");
  assert.equal(edge.validFrom, validFrom);
  assert.equal(edge.validUntil, validUntil);
});

test("validates confidence, graph ids, labels, and temporal ranges", () => {
  assert.equal(validateConfidence(0), 0);
  assert.equal(validateConfidence(1), 1);
  assert.throws(() => validateConfidence(-0.01), /between 0 and 1/);
  assert.throws(() => validateConfidence(1.01), /between 0 and 1/);
  assert.throws(() => validateConfidence(Number.NaN), /between 0 and 1/);

  assert.equal(normalizeGraphId(" node:1 "), "node:1");
  assert.throws(() => normalizeGraphId("ab"), /at least 3/);
  assert.throws(() => normalizeGraphId("node 1"), /whitespace/);

  assert.equal(normalizeGraphLabel("  goal   name "), "goal name");
  assert.throws(() => normalizeGraphLabel("x"), /at least 2/);

  assert.doesNotThrow(() => validateTemporalRange(new Date("2026-01-01"), new Date("2026-01-02")));
  assert.throws(() => validateTemporalRange(new Date("bad"), undefined), /validFrom/);
  assert.throws(() => validateTemporalRange(undefined, new Date("bad")), /validUntil/);
  assert.throws(() => validateTemporalRange(new Date("2026-01-02"), new Date("2026-01-01")), /after validFrom/);
});

test("rejects invalid source references", () => {
  assert.throws(() => createMemoryNode({
    kind: "project",
    label: "Nocheh",
    scope: "project",
    source: { ...source, messageId: "" },
    confidence: 0.7,
  }), /source messageId/);

  assert.throws(() => createMemoryEdge({
    fromNodeId: "node:a",
    toNodeId: "node:b",
    relation: "IDEA_SUPPORTS_GOAL",
    fact: "idea supports goal",
    source: { ...source, occurredAt: new Date("bad") },
    confidence: 0.7,
  }), /occurredAt/);
});

test("supports expanded structured payloads without raw chat text", () => {
  const payloads: readonly ExpandedMemoryPayload[] = [{
    payloadKind: "goal",
    status: "active",
    desiredOutcome: "Improve English speaking confidence",
    successMetric: "Daily speaking practice completed five days per week",
  }, {
    payloadKind: "routine_experiment",
    hypothesis: "Morning English shadowing improves recall",
    durationDays: 14,
    measurement: "Completed sessions and speaking notes",
  }, {
    payloadKind: "investment_thesis",
    market: "crypto",
    thesis: "Decision support only; review risk before any trade",
    invalidationSignal: "Breaks risk limit",
  }];

  const node = createMemoryNode({
    id: "goal:english",
    kind: "goal",
    label: "English learning goal",
    scope: "user",
    source,
    confidence: 0.9,
    payload: payloads[0]!,
  });

  assert.equal(node.payload.payloadKind, "goal");
  assert.equal(JSON.stringify(payloads).includes("rawText"), false);
  assert.equal(JSON.stringify(payloads).includes("messageText"), false);
});

test("a short platform message id is a valid source, since Telegram ids start at 1", () => {
  // The graph-id minimum length must not leak into source validation: the first
  // hundred messages of any Telegram chat have one- or two-character ids.
  const node = createMemoryNode({
    id: "task:first-message",
    kind: "task",
    label: "Reply to the first message",
    scope: "user",
    source: { platform: "telegram", conversationId: "-100123", messageId: "1", occurredAt: new Date("2026-06-19T12:00:00.000Z") },
    confidence: 0.9,
    now: new Date("2026-06-19T12:00:00.000Z"),
  });

  assert.equal(node.source.messageId, "1");
});

test("an empty or whitespace source identifier is still rejected", () => {
  const base = {
    id: "task:xy",
    kind: "task" as const,
    label: "Check the source",
    scope: "user" as const,
    confidence: 0.9,
    now: new Date("2026-06-19T12:00:00.000Z"),
  };
  const source = { platform: "telegram", conversationId: "-100123", messageId: "1", occurredAt: new Date("2026-06-19T12:00:00.000Z") };

  assert.throws(() => createMemoryNode({ ...base, source: { ...source, messageId: "" } }), /must not be empty/);
  assert.throws(() => createMemoryNode({ ...base, source: { ...source, messageId: "a b" } }), /must not contain whitespace/);
});

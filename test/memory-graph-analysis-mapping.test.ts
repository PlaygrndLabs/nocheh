import test from "node:test";
import assert from "node:assert/strict";
import {
  analysisSystemPrompt,
  buildMemoryGraphAnalysis,
} from "../src/infrastructure/reasoning/memory-graph-analysis-mapping.js";
import {
  MEMORY_GRAPH_SCOPES,
  MEMORY_GRAPH_STATUSES,
  MEMORY_NODE_KINDS,
  MEMORY_PAYLOAD_KINDS,
  MEMORY_RELATIONS,
} from "../src/domain/memory/memory-graph.js";
import {
  EXTERNAL_ACTION_KINDS,
  STRATEGIC_SUGGESTION_KINDS,
  SUGGESTION_RISK_LEVELS,
} from "../src/domain/memory/strategic-suggestion.js";
import type { ConversationWindow } from "../src/application/dto/conversation-window.js";
import type { MemoryEdge, MemoryNode } from "../src/domain/memory/memory-graph.js";
import type { ActionSuggestion, StrategicSuggestion } from "../src/domain/memory/strategic-suggestion.js";

const occurredAt = new Date("2026-06-21T12:00:00.000Z");

const window: ConversationWindow = {
  platform: "telegram",
  conversationId: "chat-1",
  messages: [{
    platform: "telegram",
    conversationId: "chat-1",
    messageId: "message-1",
    senderId: "mak",
    text: "I want a daily English routine for the Acme project.",
    occurredAt,
  }],
};

/** Envelope fields every item needs; only `value` varies between the cases below. */
function envelope(value: unknown, confidence = 0.9): Record<string, unknown> {
  return {
    idempotencyKey: `key:${JSON.stringify(value).slice(0, 24)}`,
    source: { messageId: "message-1" },
    confidence,
    reason: "Test fixture.",
    value,
  };
}

function rawOutput(overrides: Record<string, readonly unknown[]>): Record<string, unknown> {
  return {
    memories: [],
    nodes: [],
    edges: [],
    strategicSuggestions: [],
    actionSuggestions: [],
    tasks: [],
    statusUpdates: [],
    warnings: [],
    ...overrides,
  };
}

function build(overrides: Record<string, readonly unknown[]>) {
  return buildMemoryGraphAnalysis({
    rawOutput: rawOutput(overrides),
    provider: "test",
    minimumConfidence: 0.55,
    window,
  });
}

test("the prompt names every domain vocabulary, so it cannot drift from the graph", () => {
  const prompt = analysisSystemPrompt();

  for (const kind of MEMORY_NODE_KINDS) {
    assert.ok(prompt.includes(kind), `prompt is missing node kind ${kind}`);
  }
  for (const relation of MEMORY_RELATIONS) {
    assert.ok(prompt.includes(relation), `prompt is missing relation ${relation}`);
  }
  for (const scope of MEMORY_GRAPH_SCOPES) {
    assert.ok(prompt.includes(scope), `prompt is missing scope ${scope}`);
  }
  for (const status of MEMORY_GRAPH_STATUSES) {
    assert.ok(prompt.includes(status), `prompt is missing status ${status}`);
  }
  for (const payloadKind of MEMORY_PAYLOAD_KINDS) {
    assert.ok(prompt.includes(payloadKind), `prompt is missing payload kind ${payloadKind}`);
  }
  for (const kind of STRATEGIC_SUGGESTION_KINDS) {
    assert.ok(prompt.includes(kind), `prompt is missing strategic suggestion kind ${kind}`);
  }
  for (const kind of EXTERNAL_ACTION_KINDS) {
    assert.ok(prompt.includes(kind), `prompt is missing external action kind ${kind}`);
  }
  for (const risk of SUGGESTION_RISK_LEVELS) {
    assert.ok(prompt.includes(risk), `prompt is missing risk level ${risk}`);
  }
});

test("the prompt documents a value shape for every envelope array", () => {
  const prompt = analysisSystemPrompt();
  for (const key of ["memories", "nodes", "edges", "strategicSuggestions", "actionSuggestions", "tasks", "statusUpdates", "warnings"]) {
    assert.ok(prompt.includes(`${key}[].`), `prompt does not document a shape for ${key}`);
  }
});

test("the prompt states the id and confidence rules the domain silently enforces", () => {
  const prompt = analysisSystemPrompt(0.55);
  assert.match(prompt, /at least 3 characters, no whitespace/);
  assert.match(prompt, /at least 0\.55/);
  assert.match(prompt, /at least 2 characters/);
});

test("a conforming node, edge, and both suggestion kinds map into the domain", () => {
  const analysis = build({
    nodes: [
      envelope({
        id: "goal:english",
        kind: "goal",
        label: "English growth",
        scope: "user",
        payload: { payloadKind: "goal", status: "suggested", desiredOutcome: "Speak fluently" },
      }),
      envelope({ id: "routine:english-daily", kind: "routine", label: "Daily English practice" }),
    ],
    edges: [envelope({
      id: "edge:english-routine",
      fromNodeId: "goal:english",
      toNodeId: "routine:english-daily",
      relation: "GOAL_HAS_ROUTINE",
      fact: "English growth needs a daily routine",
    })],
    strategicSuggestions: [envelope({
      id: "suggestion:english-routine",
      kind: "routine_experiment",
      title: "Try 20 minutes of English every morning",
      rationale: "Consistency beats intensity for language retention",
      riskLevel: "low",
    })],
    actionSuggestions: [envelope({
      id: "action:tell-partner",
      kind: "send_message",
      title: "Tell the partner about the routine",
      rationale: "Keeps accountability shared",
      target: "partner:sam",
      preview: "Starting a daily English routine this week.",
    })],
  });

  assert.deepEqual(analysis.warnings, []);
  assert.deepEqual(analysis.nodes.map((node: MemoryNode) => node.id), ["goal:english", "routine:english-daily"]);
  assert.equal(analysis.nodes[0]?.scope, "user");
  // Scope and status are defaulted, not invented, when the model omits them.
  assert.equal(analysis.nodes[1]?.scope, "user");
  assert.equal(analysis.nodes[1]?.status, "active");
  assert.deepEqual(analysis.edges.map((edge: MemoryEdge) => edge.relation), ["GOAL_HAS_ROUTINE"]);
  assert.equal(analysis.suggestions.length, 2);
  assert.equal((analysis.suggestions[0] as StrategicSuggestion).kind, "routine_experiment");
  assert.equal((analysis.suggestions[1] as ActionSuggestion).target, "partner:sam");
  assert.equal(analysis.suggestions[1]?.status, "pending");
  // Source is resolved from the window, never taken from the model.
  assert.equal(analysis.nodes[0]?.source.conversationId, "chat-1");
  assert.deepEqual(analysis.nodes[0]?.source.occurredAt, occurredAt);
});

test("the shape GLM-5.2 invented for a node is dropped with a reason naming the field", () => {
  const analysis = build({
    nodes: [envelope({ type: "goal", title: "English growth", project: "Acme" })],
  });

  assert.deepEqual(analysis.nodes, []);
  assert.equal(analysis.warnings.length, 1);
  assert.match(analysis.warnings[0] ?? "", /Dropped graph node: node kind must be a non-empty string\./);
});

test("a bare string suggestion is dropped with a reason instead of failing the window", () => {
  const analysis = build({
    strategicSuggestions: ["ship the landing page"],
    nodes: [envelope({ id: "project:acme", kind: "project", label: "Acme site" })],
  });

  assert.deepEqual(analysis.suggestions, []);
  assert.equal(analysis.nodes.length, 1, "the good node still lands");
  assert.match(analysis.warnings.join("\n"), /strategicSuggestions item must be an object/);
});

test("an invented relation is dropped and listed, never written to the graph", () => {
  const analysis = build({
    edges: [envelope({
      id: "edge:mentions",
      fromNodeId: "person:mak",
      toNodeId: "project:acme",
      relation: "MENTIONS",
      fact: "Mak mentioned Acme",
    })],
  });

  assert.deepEqual(analysis.edges, []);
  assert.match(analysis.warnings[0] ?? "", /edge relation must be one of: PERSON_WORKS_ON_PROJECT/);
  assert.match(analysis.warnings[0] ?? "", /Received "MENTIONS"/);
});

test("an unknown node kind, scope, or payloadKind is refused", () => {
  const kindAnalysis = build({ nodes: [envelope({ id: "n:1", kind: "startup", label: "Acme" })] });
  assert.match(kindAnalysis.warnings[0] ?? "", /node kind must be one of: person, project/);

  const scopeAnalysis = build({ nodes: [envelope({ id: "n:1", kind: "project", label: "Acme", scope: "team" })] });
  assert.match(scopeAnalysis.warnings[0] ?? "", /node scope must be one of: user, conversation, project, global/);

  const payloadAnalysis = build({
    nodes: [envelope({ id: "n:1", kind: "project", label: "Acme", payload: { payloadKind: "milestone" } })],
  });
  assert.match(payloadAnalysis.warnings[0] ?? "", /payloadKind must be one of: person, preference/);
});

test("an id shorter than the graph minimum is reported as such, not silently lost", () => {
  const analysis = build({ nodes: [envelope({ id: "g", kind: "goal", label: "English" })] });
  assert.match(analysis.warnings[0] ?? "", /Memory node id must contain at least 3 characters\./);
});

test("an id containing whitespace is reported, because the domain rejects it", () => {
  const analysis = build({ nodes: [envelope({ id: "goal english", kind: "goal", label: "English" })] });
  assert.match(analysis.warnings[0] ?? "", /Memory node id must not contain whitespace\./);
});

test("one malformed task value no longer rejects the whole window", () => {
  const analysis = build({
    tasks: [
      envelope("ship it"),
      envelope({ title: "Ship the landing page", priority: "high" }),
    ],
    nodes: [envelope({ id: "project:acme", kind: "project", label: "Acme site" })],
  });

  assert.equal(analysis.tasks.length, 1);
  assert.equal(analysis.tasks[0]?.title, "Ship the landing page");
  assert.equal(analysis.tasks[0]?.priority, "high");
  assert.equal(analysis.nodes.length, 1);
  assert.match(analysis.warnings.join("\n"), /tasks item requires value/);
});

test("memories and status updates now report why they were dropped", () => {
  const analysis = build({
    memories: [
      envelope({ type: "Milestone", title: "Launch" }),
      envelope({ type: "Decision", title: "Use SQLite" }),
      envelope({ type: "Decision", title: "Use SQLite", outcome: "Chose SQLite over Postgres" }),
    ],
    statusUpdates: [envelope({ targetMessageId: "message-1", status: "finished" })],
  });

  assert.equal(analysis.memories.length, 1);
  assert.equal(analysis.memories[0]?.candidate.type, "Decision");
  assert.deepEqual(analysis.statusUpdates, []);
  const warnings = analysis.warnings.join("\n");
  assert.match(warnings, /Dropped memory: memory type must be one of: Project, Decision/);
  assert.match(warnings, /Dropped memory: memory Decision outcome must be a non-empty string\./);
  assert.match(warnings, /Dropped status update: status update status must be one of: open, in_progress/);
});

test("an item below the confidence floor is skipped and reported", () => {
  const analysis = build({
    nodes: [envelope({ id: "goal:english", kind: "goal", label: "English growth" }, 0.4)],
  });

  assert.deepEqual(analysis.nodes, []);
  assert.match(analysis.warnings[0] ?? "", /confidence must be between 0\.55 and 1/);
});

test("model warnings and mapping drops arrive in one list", () => {
  const analysis = build({
    warnings: [{
      idempotencyKey: "warning:1",
      source: { messageId: "message-1" },
      confidence: 0.9,
      reason: "Ambiguous.",
      message: "Could not tell which project the deadline belongs to.",
    }],
    nodes: [envelope({ id: "n:1", kind: "startup", label: "Acme" })],
  });

  assert.equal(analysis.warnings.length, 2);
  assert.equal(analysis.warnings[0], "Could not tell which project the deadline belongs to.");
  assert.match(analysis.warnings[1] ?? "", /Dropped graph node/);
});

test("a structurally broken root still rejects the whole window", () => {
  assert.throws(
    () => buildMemoryGraphAnalysis({
      rawOutput: { nodes: [] },
      provider: "test",
      minimumConfidence: 0.55,
      window,
    }),
    /test analysis output rejected: AI analysis output memories must be an array\./,
  );
});

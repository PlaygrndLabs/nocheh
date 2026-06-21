import test from "node:test";
import assert from "node:assert/strict";
import { AssistantContextBuilder } from "../src/application/services/assistant-context-builder.js";
import type { MemoryRetrievalPort, MemorySearchResult } from "../src/application/ports/memory-retrieval.js";
import type { MemoryGraphRepositoryPort } from "../src/application/ports/memory-graph-repository.js";
import type { SuggestionRepositoryPort } from "../src/application/ports/suggestion-repository.js";
import { createGroupAssistantSettings } from "../src/domain/assistant/group-assistant-settings.js";
import {
  createMemoryEdge,
  createMemoryNode,
  type MemoryEdge,
  type MemoryGraphSource,
  type MemoryNode,
  type MemoryRelation,
} from "../src/domain/memory/memory-graph.js";
import type { MemoryRecord } from "../src/domain/memory/memory-record.js";
import { createStrategicSuggestion, type Suggestion } from "../src/domain/memory/strategic-suggestion.js";

const source: MemoryGraphSource = {
  platform: "telegram",
  conversationId: "chat-1",
  messageId: "message-1",
  occurredAt: new Date("2026-06-21T10:00:00.000Z"),
};

test("assistant context includes bounded graph, accepted rules, and high-value suggestions", async () => {
  const preference = createMemoryNode({
    id: "preference:style",
    kind: "concept",
    label: "Direct concise style",
    scope: "user",
    source,
    confidence: 0.9,
    payload: { payloadKind: "style_rule", rule: "Be direct and simple." },
  });
  const goal = createMemoryNode({
    id: "goal:english",
    kind: "goal",
    label: "English growth",
    scope: "user",
    source,
    confidence: 0.86,
  });
  const routine = createMemoryNode({
    id: "routine:speaking",
    kind: "routine",
    label: "Daily speaking routine",
    scope: "user",
    source,
    confidence: 0.8,
  });
  const graph = new InMemoryMemoryGraphRepository([preference, goal, routine], [
    edge("edge:goal-routine", goal.id, routine.id, "GOAL_HAS_ROUTINE"),
  ]);
  const suggestion = createStrategicSuggestion({
    id: "suggestion:routine",
    kind: "routine_experiment",
    title: "Try 14 days of English shadowing",
    rationale: "Routine experiment fits the learning goal.",
    source,
    confidence: 0.82,
    riskLevel: "low",
  });
  const builder = new AssistantContextBuilder(
    new FixedRetrieval([memoryRecord("memory-1", "Decision", "Use short simulator cycles")]),
    {
      graphRepository: graph,
      suggestionRepository: new InMemorySuggestionRepository([suggestion]),
    },
  );

  const context = await builder.build([
    message("old-message", "This old message should not be included"),
    message("new-message", "What should I do for English today?"),
  ], createGroupAssistantSettings({
    conversationId: "chat-1",
    maxRecentMessages: 1,
    maxAiContextTokens: 180,
  }, source.occurredAt), {
    graphCenterNodeIds: [goal.id],
    graphDepth: 1,
  });

  assert.equal(context.currentMessages.length, 1);
  assert.equal(context.acceptedRules[0]?.id, preference.id);
  assert.equal(context.graphNodes.some((node) => node.id === routine.id), true);
  assert.equal(context.graphEdges[0]?.relation, "GOAL_HAS_ROUTINE");
  assert.equal(context.pendingSuggestions[0]?.id, suggestion.id);
  assert.match(context.text, /Accepted preferences/);
  assert.match(context.text, /Try 14 days/);
  assert.doesNotMatch(context.text, /old-message/);
  assert.ok(context.text.length <= context.tokenBudget * 4);
});

function message(messageId: string, text: string) {
  return {
    platform: "telegram",
    conversationId: "chat-1",
    messageId,
    senderId: "7",
    text,
    occurredAt: source.occurredAt,
  };
}

function memoryRecord(id: string, type: MemoryRecord["type"], title: string): MemoryRecord {
  return {
    id,
    type,
    source,
    timestamp: source.occurredAt,
    confidence: 0.8,
    decision: { title, outcome: title },
  };
}

function edge(id: string, fromNodeId: string, toNodeId: string, relation: MemoryRelation): MemoryEdge {
  return createMemoryEdge({
    id,
    fromNodeId,
    toNodeId,
    relation,
    fact: "Goal uses routine",
    source,
    confidence: 0.8,
  });
}

class FixedRetrieval implements MemoryRetrievalPort {
  public constructor(private readonly records: readonly MemoryRecord[]) {}

  public async query(): Promise<readonly MemorySearchResult[]> {
    return this.records.map((record) => ({ record, score: 1 }));
  }
}

class InMemoryMemoryGraphRepository implements MemoryGraphRepositoryPort {
  public constructor(
    private readonly nodes: readonly MemoryNode[],
    private readonly edges: readonly MemoryEdge[],
  ) {}

  public async saveNode(): Promise<void> {}

  public async saveEdge(): Promise<void> {}

  public async findNodeById(id: string): Promise<MemoryNode | undefined> {
    return this.nodes.find((node) => node.id === id);
  }

  public async findEdgeById(id: string): Promise<MemoryEdge | undefined> {
    return this.edges.find((edge) => edge.id === id);
  }

  public async listNodes(): Promise<readonly MemoryNode[]> {
    return this.nodes;
  }

  public async listEdgesForNode(nodeId: string): Promise<readonly MemoryEdge[]> {
    return this.edges.filter((edge) => edge.fromNodeId === nodeId || edge.toNodeId === nodeId);
  }

  public async listEdgesByRelation(relation: MemoryRelation): Promise<readonly MemoryEdge[]> {
    return this.edges.filter((edge) => edge.relation === relation);
  }
}

class InMemorySuggestionRepository implements SuggestionRepositoryPort {
  public constructor(private readonly suggestions: readonly Suggestion[]) {}

  public async save(): Promise<void> {}

  public async findById(id: string): Promise<Suggestion | undefined> {
    return this.suggestions.find((suggestion) => suggestion.id === id);
  }

  public async findByStatus(status: Suggestion["status"]): Promise<readonly Suggestion[]> {
    return this.suggestions.filter((suggestion) => suggestion.status === status);
  }

  public async findPending(): Promise<readonly Suggestion[]> {
    return this.findByStatus("pending");
  }
}

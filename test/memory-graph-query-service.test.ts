import test from "node:test";
import assert from "node:assert/strict";
import { MemoryGraphQueryService } from "../src/application/services/memory-graph-query-service.js";
import type { MemoryGraphRepositoryPort } from "../src/application/ports/memory-graph-repository.js";
import {
  createMemoryEdge,
  createMemoryNode,
  type MemoryEdge,
  type MemoryGraphSource,
  type MemoryNode,
  type MemoryRelation,
} from "../src/domain/memory/memory-graph.js";

const source: MemoryGraphSource = {
  platform: "telegram",
  conversationId: "chat-1",
  messageId: "message-1",
  occurredAt: new Date("2026-06-21T10:00:00.000Z"),
};

test("queries graph neighborhood with bounded depth and cycle protection", async () => {
  const mak = node("person:mak", "person", "Mak");
  const startup = node("project:startup", "project", "Startup");
  const goal = node("goal:growth", "goal", "Growth goal");
  const idea = node("idea:x-content", "idea", "X content idea");
  const routine = node("routine:weekly-review", "routine", "Weekly review");
  const task = node("task:launch", "task", "Launch task");
  const repository = new InMemoryMemoryGraphRepository([
    mak,
    startup,
    goal,
    idea,
    routine,
    task,
  ], [
    edge("edge:1", mak.id, startup.id, "PERSON_WORKS_ON_PROJECT"),
    edge("edge:2", goal.id, startup.id, "GOAL_HAS_PROJECT"),
    edge("edge:3", goal.id, routine.id, "GOAL_HAS_ROUTINE"),
    edge("edge:4", routine.id, mak.id, "ROUTINE_SUPPORTS_AREA"),
    edge("edge:5", idea.id, goal.id, "IDEA_SUPPORTS_GOAL"),
    edge("edge:6", mak.id, task.id, "PERSON_OWNS_TASK"),
  ]);
  const service = new MemoryGraphQueryService(repository);

  const shallow = await service.neighborhood(mak.id, 1);
  assert.deepEqual(shallow?.nodes.map((item) => item.id).sort(), ["person:mak", "project:startup", "routine:weekly-review", "task:launch"]);
  assert.equal(shallow.edges.length, 3);

  const deeper = await service.neighborhood(mak.id, 3);
  assert.deepEqual(deeper?.nodes.map((item) => item.id).sort(), [
    "goal:growth",
    "idea:x-content",
    "person:mak",
    "project:startup",
    "routine:weekly-review",
    "task:launch",
  ]);
  assert.equal(deeper.edges.length, 6);
  assert.equal((await service.byRelation("GOAL_HAS_ROUTINE")).length, 1);
  await assert.rejects(() => service.neighborhood(mak.id, 5), /depth/);
});

function node(id: string, kind: MemoryNode["kind"], label: string): MemoryNode {
  return createMemoryNode({
    id,
    kind,
    label,
    scope: "user",
    source,
    confidence: 0.9,
  });
}

function edge(id: string, fromNodeId: string, toNodeId: string, relation: MemoryRelation): MemoryEdge {
  return createMemoryEdge({
    id,
    fromNodeId,
    toNodeId,
    relation,
    fact: `${fromNodeId} ${relation} ${toNodeId}`,
    source,
    confidence: 0.8,
  });
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

  public async findNodesBySourceMessageId(messageId: string): Promise<readonly MemoryNode[]> {
    return this.nodes.filter((node) => node.source.messageId === messageId);
  }
}

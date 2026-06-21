import type {
  MemoryEdge,
  MemoryEdgeId,
  MemoryNode,
  MemoryNodeId,
  MemoryRelation,
} from "../../domain/memory/memory-graph.js";

export interface MemoryGraphRepositoryPort {
  saveNode(node: MemoryNode): Promise<void>;
  saveEdge(edge: MemoryEdge): Promise<void>;
  findNodeById(id: MemoryNodeId): Promise<MemoryNode | undefined>;
  findEdgeById(id: MemoryEdgeId): Promise<MemoryEdge | undefined>;
  listNodes(): Promise<readonly MemoryNode[]>;
  listEdgesForNode(nodeId: MemoryNodeId): Promise<readonly MemoryEdge[]>;
  listEdgesByRelation(relation: MemoryRelation): Promise<readonly MemoryEdge[]>;
}

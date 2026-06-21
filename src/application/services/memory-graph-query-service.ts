import type { MemoryGraphRepositoryPort } from "../ports/memory-graph-repository.js";
import type {
  MemoryEdge,
  MemoryNode,
  MemoryNodeId,
  MemoryRelation,
} from "../../domain/memory/memory-graph.js";

export interface MemoryGraphNeighborhood {
  readonly center: MemoryNode;
  readonly nodes: readonly MemoryNode[];
  readonly edges: readonly MemoryEdge[];
}

export class MemoryGraphQueryService {
  public constructor(private readonly repository: MemoryGraphRepositoryPort) {}

  public async node(id: MemoryNodeId): Promise<MemoryNode | undefined> {
    return this.repository.findNodeById(id);
  }

  public async edgesForNode(id: MemoryNodeId): Promise<readonly MemoryEdge[]> {
    return this.repository.listEdgesForNode(id);
  }

  public async byRelation(relation: MemoryRelation): Promise<readonly MemoryEdge[]> {
    return this.repository.listEdgesByRelation(relation);
  }

  public async neighborhood(centerId: MemoryNodeId, maxDepth: number): Promise<MemoryGraphNeighborhood | undefined> {
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 4) {
      throw new Error("Memory graph neighborhood depth must be an integer between 0 and 4.");
    }

    const center = await this.repository.findNodeById(centerId);
    if (center === undefined) {
      return undefined;
    }

    const visitedNodeIds = new Set<MemoryNodeId>([center.id]);
    const edgeIds = new Set<string>();
    const nodes = new Map<MemoryNodeId, MemoryNode>([[center.id, center]]);
    const edges: MemoryEdge[] = [];
    let frontier: readonly MemoryNodeId[] = [center.id];

    for (let depth = 0; depth < maxDepth; depth += 1) {
      const next = new Set<MemoryNodeId>();
      for (const nodeId of frontier) {
        const adjacent = await this.repository.listEdgesForNode(nodeId);
        for (const edge of adjacent) {
          if (!edgeIds.has(edge.id)) {
            edgeIds.add(edge.id);
            edges.push(edge);
          }

          const neighborId = edge.fromNodeId === nodeId ? edge.toNodeId : edge.fromNodeId;
          if (visitedNodeIds.has(neighborId)) {
            continue;
          }

          const neighbor = await this.repository.findNodeById(neighborId);
          if (neighbor === undefined) {
            continue;
          }

          visitedNodeIds.add(neighborId);
          nodes.set(neighborId, neighbor);
          next.add(neighborId);
        }
      }
      frontier = [...next];
      if (frontier.length === 0) {
        break;
      }
    }

    return {
      center,
      nodes: [...nodes.values()],
      edges,
    };
  }
}

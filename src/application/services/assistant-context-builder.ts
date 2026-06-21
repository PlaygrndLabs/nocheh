import type { IncomingMessage } from "../dto/incoming-message.js";
import type { MemoryGraphRepositoryPort } from "../ports/memory-graph-repository.js";
import type { MemoryRetrievalPort } from "../ports/memory-retrieval.js";
import type { SuggestionRepositoryPort } from "../ports/suggestion-repository.js";
import type { GroupAssistantSettings } from "../../domain/assistant/group-assistant-settings.js";
import type { MemoryEdge, MemoryNode, MemoryNodeId } from "../../domain/memory/memory-graph.js";
import { memoryRecordText, type MemoryRecord } from "../../domain/memory/memory-record.js";
import type { Suggestion } from "../../domain/memory/strategic-suggestion.js";

export interface AssistantContext {
  readonly conversationId: string;
  readonly currentMessages: readonly IncomingMessage[];
  readonly memories: readonly MemoryRecord[];
  readonly graphNodes: readonly MemoryNode[];
  readonly graphEdges: readonly MemoryEdge[];
  readonly acceptedRules: readonly MemoryNode[];
  readonly pendingSuggestions: readonly Suggestion[];
  readonly tokenBudget: number;
  readonly text: string;
}

export interface AssistantContextBuilderDependencies {
  readonly graphRepository?: MemoryGraphRepositoryPort;
  readonly suggestionRepository?: SuggestionRepositoryPort;
}

export interface AssistantContextBuildOptions {
  readonly graphCenterNodeIds?: readonly MemoryNodeId[];
  readonly graphDepth?: number;
}

/** Builds small AI-ready context from current messages plus retrieved structured memory. */
export class AssistantContextBuilder {
  public constructor(
    private readonly retrieval: MemoryRetrievalPort,
    private readonly dependencies: AssistantContextBuilderDependencies = {},
  ) {}

  public async build(
    messages: readonly IncomingMessage[],
    settings: GroupAssistantSettings,
    options: AssistantContextBuildOptions = {},
  ): Promise<AssistantContext> {
    const currentMessages = messages.slice(-settings.maxRecentMessages);
    const queryText = currentMessages.map((message) => message.text).join("\n");
    const memories = queryText.trim().length === 0
      ? []
      : await this.retrieval.query({
        text: queryText,
        limit: settings.maxRetrievedMemories,
        minimumScore: 0.03,
      });

    const memoryRecords = memories.map((result) => result.record);
    const graph = await this.graphContext(options.graphCenterNodeIds ?? [], options.graphDepth ?? 1);
    const acceptedRules = graph.nodes.filter((node) => isAcceptedRule(node));
    const pendingSuggestions = await this.pendingSuggestions();

    return {
      conversationId: settings.conversationId,
      currentMessages,
      memories: memoryRecords,
      graphNodes: graph.nodes,
      graphEdges: graph.edges,
      acceptedRules,
      pendingSuggestions,
      tokenBudget: settings.maxAiContextTokens,
      text: this.render(currentMessages, memoryRecords, graph.nodes, graph.edges, acceptedRules, pendingSuggestions, settings.maxAiContextTokens),
    };
  }

  private async graphContext(
    centerNodeIds: readonly MemoryNodeId[],
    maxDepth: number,
  ): Promise<{ readonly nodes: readonly MemoryNode[]; readonly edges: readonly MemoryEdge[] }> {
    const repository = this.dependencies.graphRepository;
    if (repository === undefined) {
      return { nodes: [], edges: [] };
    }

    const normalizedDepth = Math.min(Math.max(maxDepth, 0), 2);
    const nodes = new Map<MemoryNodeId, MemoryNode>();
    const edges = new Map<string, MemoryEdge>();

    for (const node of await repository.listNodes()) {
      if (isAcceptedRule(node)) {
        nodes.set(node.id, node);
      }
    }

    let frontier = new Set(centerNodeIds);
    const visited = new Set<MemoryNodeId>();
    for (let depth = 0; depth <= normalizedDepth; depth += 1) {
      const next = new Set<MemoryNodeId>();
      for (const nodeId of frontier) {
        if (visited.has(nodeId)) {
          continue;
        }
        visited.add(nodeId);

        const node = await repository.findNodeById(nodeId);
        if (node !== undefined) {
          nodes.set(node.id, node);
        }
        if (depth === normalizedDepth) {
          continue;
        }

        for (const edge of await repository.listEdgesForNode(nodeId)) {
          edges.set(edge.id, edge);
          next.add(edge.fromNodeId === nodeId ? edge.toNodeId : edge.fromNodeId);
        }
      }
      frontier = next;
    }

    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }

  private async pendingSuggestions(): Promise<readonly Suggestion[]> {
    const repository = this.dependencies.suggestionRepository;
    if (repository === undefined) {
      return [];
    }
    return (await repository.findPending())
      .filter((suggestion) => suggestion.confidence >= 0.7)
      .slice(0, 5);
  }

  private render(
    messages: readonly IncomingMessage[],
    memories: readonly MemoryRecord[],
    graphNodes: readonly MemoryNode[],
    graphEdges: readonly MemoryEdge[],
    acceptedRules: readonly MemoryNode[],
    pendingSuggestions: readonly Suggestion[],
    maxTokens: number,
  ): string {
    const sections = [
      "Relevant structured memory:",
      memories.length === 0
        ? "none"
        : memories.map((record) => `- ${record.type}: ${memoryRecordText(record)}`).join("\n"),
      "",
      "Accepted preferences and personal rules:",
      acceptedRules.length === 0
        ? "none"
        : acceptedRules.map((node) => `- ${node.label}: ${node.summary ?? summarizePayload(node.payload)}`).join("\n"),
      "",
      "Relevant knowledge graph:",
      graphNodes.length === 0
        ? "none"
        : [
          ...graphNodes.map((node) => `- node ${node.id} [${node.kind}/${node.status}]: ${node.label}`),
          ...graphEdges.map((edge) => `- edge ${edge.fromNodeId} ${edge.relation} ${edge.toNodeId}: ${edge.fact}`),
        ].join("\n"),
      "",
      "Pending suggestions:",
      pendingSuggestions.length === 0
        ? "none"
        : pendingSuggestions.map((suggestion) => `- ${suggestion.kind} [${suggestion.riskLevel}/${suggestion.confidence}]: ${suggestion.title}`).join("\n"),
      "",
      "Current messages:",
      messages.map((message) => `- ${message.occurredAt.toISOString()} ${message.senderDisplayName ?? message.senderId}: ${message.text}`).join("\n"),
    ];

    return trimToApproxTokens(sections.join("\n"), maxTokens);
  }
}

function trimToApproxTokens(text: string, maxTokens: number): string {
  const maxChars = Math.max(1, maxTokens) * 4;
  return text.length <= maxChars ? text : text.slice(0, maxChars - 3).trimEnd() + "...";
}

function isAcceptedRule(node: MemoryNode): boolean {
  const payloadKind = node.payload.payloadKind;
  return node.status === "active" && (
    payloadKind === "preference" ||
    payloadKind === "style_rule" ||
    payloadKind === "personal_rule"
  );
}

function summarizePayload(payload: Readonly<Record<string, unknown>>): string {
  const summaryFields = ["preference", "rule", "desiredOutcome", "hypothesis", "insight"];
  for (const field of summaryFields) {
    const value = payload[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return JSON.stringify(payload);
}

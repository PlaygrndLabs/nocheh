import type { IncomingMessage } from "../dto/incoming-message.js";
import type { MemoryGraphRepositoryPort } from "../ports/memory-graph-repository.js";
import type { MemoryRetrievalPort } from "../ports/memory-retrieval.js";
import type { SuggestionRepositoryPort } from "../ports/suggestion-repository.js";
import type { GroupAssistantSettings } from "../../domain/assistant/group-assistant-settings.js";
import type { MemoryEdge, MemoryNode, MemoryNodeId } from "../../domain/memory/memory-graph.js";
import { memoryRecordSummary, type MemoryRecord } from "../../domain/memory/memory-record.js";
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
  /**
   * The same context without the current messages.
   *
   * The analyzer already sends the window as structured `messages`, so grounding it with
   * `text` would pay for every message twice. Callers that send the window themselves use
   * this; callers that need one self-contained blob use `text`.
   */
  readonly groundingText: string;
}

export interface AssistantContextBuilderDependencies {
  readonly graphRepository?: MemoryGraphRepositoryPort;
  readonly suggestionRepository?: SuggestionRepositoryPort;
}

export interface AssistantContextBuildOptions {
  /**
   * Explicit graph starting points. Omit to let the builder seed them from what recall
   * returned: a memory found by meaning names the message it came from, and that message
   * names the graph nodes born with it.
   */
  readonly graphCenterNodeIds?: readonly MemoryNodeId[];
  readonly graphDepth?: number;
}

/**
 * How many source messages the builder will expand into graph nodes.
 *
 * Each one is a repository lookup, and the graph neighborhood is token-capped anyway, so
 * expanding all 12 recalled memories plus all 30 recent messages buys nothing.
 */
const MAX_GRAPH_SEED_LOOKUPS = 16;

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
    const centerNodeIds = options.graphCenterNodeIds
      ?? await this.seedGraphCenters(memoryRecords, currentMessages);
    const graph = await this.graphContext(centerNodeIds, options.graphDepth ?? 1);
    const acceptedRules = graph.nodes.filter((node) => isAcceptedRule(node));
    const pendingSuggestions = await this.pendingSuggestions();
    const budget = settings.maxAiContextTokens;
    const grounding = this.renderGrounding(memoryRecords, graph.nodes, graph.edges, acceptedRules, pendingSuggestions);
    const messageSection = this.renderMessages(currentMessages);

    return {
      conversationId: settings.conversationId,
      currentMessages,
      memories: memoryRecords,
      graphNodes: graph.nodes,
      graphEdges: graph.edges,
      acceptedRules,
      pendingSuggestions,
      tokenBudget: budget,
      text: trimToApproxTokens([...grounding, "", ...messageSection].join("\n"), budget),
      groundingText: trimToApproxTokens(grounding.join("\n"), budget),
    };
  }

  /**
   * Turns recalled memory into graph starting points.
   *
   * This is the associative step: recall finds a memory by meaning, the memory names its
   * source message, and `findNodesBySourceMessageId` names the nodes that message created.
   * Expanding one hop from there reaches knowledge that shares no words with the query.
   * Current messages are seeded too, so a note or correction about an earlier message
   * lands on the knowledge that message already produced.
   */
  private async seedGraphCenters(
    memories: readonly MemoryRecord[],
    messages: readonly IncomingMessage[],
  ): Promise<readonly MemoryNodeId[]> {
    const repository = this.dependencies.graphRepository;
    if (repository === undefined) {
      return [];
    }

    // Recalled memories first: they are score-ordered, and the cap is a budget.
    const sourceMessageIds: string[] = [];
    for (const messageId of [
      ...memories.map((record) => record.source.messageId),
      ...[...messages].reverse().map((message) => message.messageId),
    ]) {
      if (!sourceMessageIds.includes(messageId)) {
        sourceMessageIds.push(messageId);
      }
      if (sourceMessageIds.length >= MAX_GRAPH_SEED_LOOKUPS) {
        break;
      }
    }

    const centers = new Set<MemoryNodeId>();
    for (const messageId of sourceMessageIds) {
      for (const node of await repository.findNodesBySourceMessageId(messageId)) {
        if (node.status === "active") {
          centers.add(node.id);
        }
      }
    }
    return [...centers];
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

  private renderGrounding(
    memories: readonly MemoryRecord[],
    graphNodes: readonly MemoryNode[],
    graphEdges: readonly MemoryEdge[],
    acceptedRules: readonly MemoryNode[],
    pendingSuggestions: readonly Suggestion[],
  ): readonly string[] {
    return [
      "Relevant structured memory:",
      memories.length === 0
        ? "none"
        : memories.map((record) => `- ${record.type}: ${memoryRecordSummary(record)}`).join("\n"),
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
    ];
  }

  private renderMessages(messages: readonly IncomingMessage[]): readonly string[] {
    return [
      "Current messages:",
      messages.map((message) => `- ${message.occurredAt.toISOString()} ${message.senderDisplayName ?? message.senderId}: ${message.text}`).join("\n"),
    ];
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

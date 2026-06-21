import type { IncomingMessage } from "../../application/dto/incoming-message.js";
import type { MemoryGraphAnalysis, MemoryGraphAnalyzerPort } from "../../application/ports/memory-graph-analyzer.js";
import {
  createMemoryEdge,
  createMemoryNode,
  type CreateMemoryEdgeInput,
  type MemoryGraphSource,
  type MemoryNode,
} from "../../domain/memory/memory-graph.js";
import {
  createActionSuggestion,
  createStrategicSuggestion,
  type Suggestion,
} from "../../domain/memory/strategic-suggestion.js";

/** Deterministic graph analyzer used before a provider-backed AI adapter exists. */
export class RuleBasedMemoryGraphAnalyzer implements MemoryGraphAnalyzerPort {
  public async analyze(message: IncomingMessage): Promise<MemoryGraphAnalysis> {
    const source = sourceFrom(message);
    const text = message.text.toLowerCase();
    const now = new Date(message.occurredAt);
    const nodes: MemoryNode[] = [node("person:mak", "person", "Mak", source, 1, now, {
      payloadKind: "person",
      role: "owner",
    })];
    const edgeInputs: CreateMemoryEdgeInput[] = [];
    const suggestions: Suggestion[] = [];
    const warnings: string[] = [];

    if (hasAny(text, ["startup", "cofounder", "partner"])) {
      nodes.push(
        node("project:startup-context", "project", "Startup context", source, 0.82, now),
        node("person:startup-partner", "person", "Startup partner", source, 0.72, now),
        node("goal:startup-next-decision", "goal", "Define next startup decision", source, 0.78, now, {
          payloadKind: "goal",
          status: "suggested",
          desiredOutcome: "Clarify startup owner, risk, and next decision point.",
        }),
      );
      edgeInputs.push(
        edgeInput("edge:mak-startup", "person:mak", "project:startup-context", "PERSON_WORKS_ON_PROJECT", "Mak works on the startup context", source, 0.82, now),
        edgeInput("edge:partner-startup", "person:startup-partner", "project:startup-context", "PARTNER_WORKS_ON_STARTUP", "Startup partner is connected to the startup context", source, 0.72, now),
        edgeInput("edge:startup-goal", "goal:startup-next-decision", "project:startup-context", "GOAL_HAS_PROJECT", "Startup decision goal belongs to startup context", source, 0.78, now),
      );
      suggestions.push(createStrategicSuggestion({
        id: "suggestion:startup-next-decision",
        kind: "goal",
        title: "Define next startup decision",
        rationale: "Startup and partner context needs a concrete owner, risk, and next decision point.",
        expectedValue: "Less ambiguity with startup partner and faster project movement.",
        source,
        confidence: 0.78,
        riskLevel: "medium",
        evidenceNodeIds: ["project:startup-context", "person:startup-partner"],
        now,
      }));
    }

    if (hasAny(text, ["english", "vocabulary", "grammar", "speaking"])) {
      nodes.push(
        node("goal:english-growth", "learning_plan", "English growth", source, 0.86, now, {
          payloadKind: "learning_plan",
          topic: "English",
          targetOutcome: "Improve speaking, vocabulary, writing, and communication confidence.",
        }),
        node("routine:english-practice", "routine", "English practice routine", source, 0.79, now, {
          payloadKind: "routine",
          cadence: "daily",
          habit: "English practice",
        }),
      );
      edgeInputs.push(edgeInput("edge:english-routine", "goal:english-growth", "routine:english-practice", "GOAL_HAS_ROUTINE", "English growth uses a practice routine", source, 0.83, now));
      suggestions.push(createStrategicSuggestion({
        id: "suggestion:english-routine",
        kind: "routine_experiment",
        title: "Run a 15-minute English loop",
        rationale: "A small daily loop is easier to sustain and review than a broad study goal.",
        source,
        confidence: 0.82,
        riskLevel: "low",
        evidenceNodeIds: ["goal:english-growth", "routine:english-practice"],
        now,
      }));
    }

    if (hasAny(text, ["twitter", "x ", "x.com", "post", "thread", "audience"])) {
      nodes.push(
        node("content:x-growth", "content_plan", "X growth loop", source, 0.81, now, {
          payloadKind: "content_plan",
          platform: "x",
          audience: "Startup, product, and builder audience",
          angle: "Turn current work into content experiments.",
        }),
        node("goal:audience-growth", "goal", "Audience growth", source, 0.74, now, {
          payloadKind: "goal",
          status: "suggested",
          desiredOutcome: "Grow Mak's page through useful content experiments.",
        }),
      );
      edgeInputs.push(edgeInput("edge:x-growth-goal", "content:x-growth", "goal:audience-growth", "CONTENT_PLAN_SUPPORTS_GOAL", "X growth loop supports audience growth", source, 0.74, now));
      suggestions.push(createStrategicSuggestion({
        id: "suggestion:x-post-angles",
        kind: "idea",
        title: "Draft three X post angles",
        rationale: "Conversation context can become content tests before committing to a full plan.",
        source,
        confidence: 0.76,
        riskLevel: "low",
        evidenceNodeIds: ["content:x-growth"],
        now,
      }));
    }

    if (hasAny(text, ["routine", "habit", "weekly review", "daily", "morning"])) {
      nodes.push(
        node("routine:operating-review", "routine", "Operating review routine", source, 0.8, now, {
          payloadKind: "routine_experiment",
          hypothesis: "A small review loop reduces forgotten follow-ups and unclear priorities.",
          durationDays: 14,
          measurement: "Completed reviews and reduced open loops.",
        }),
        node("area:personal-operating-system", "area", "Personal operating system", source, 0.82, now),
      );
      edgeInputs.push(edgeInput("edge:routine-area", "routine:operating-review", "area:personal-operating-system", "ROUTINE_SUPPORTS_AREA", "Operating review supports Mak's personal operating system", source, 0.8, now));
      suggestions.push(createStrategicSuggestion({
        id: "suggestion:operating-review",
        kind: "routine_experiment",
        title: "Try one operating review experiment",
        rationale: "Routine changes should be small, reviewable, and optional.",
        source,
        confidence: 0.8,
        riskLevel: "low",
        evidenceNodeIds: ["routine:operating-review"],
        now,
      }));
    }

    if (hasAny(text, ["crypto", "trade", "trading", "btc", "eth"])) {
      nodes.push(
        node("thesis:crypto-decision-support", "investment_thesis", "Crypto decision support", source, 0.76, now, {
          payloadKind: "investment_thesis",
          market: "crypto",
          thesis: "Capture thesis, risk, watchlist, and journal notes without auto-trading.",
        }),
        node("risk:auto-trading", "risk", "Auto-trading risk", source, 0.96, now, {
          payloadKind: "risk",
          level: "high",
          risk: "Automated trading can create financial harm and must stay blocked.",
          mitigation: "Decision support only; require explicit human action outside Nocheh.",
        }),
      );
      edgeInputs.push(edgeInput("edge:crypto-risk", "thesis:crypto-decision-support", "risk:auto-trading", "INVESTMENT_THESIS_HAS_RISK", "Crypto decision support has auto-trading risk", source, 0.94, now));
      suggestions.push(createActionSuggestion({
        id: "suggestion:block-auto-trade",
        kind: "place_trade",
        title: "Do not execute crypto trade",
        rationale: "Crypto support is decision support only and cannot place trades.",
        target: "crypto-exchange",
        preview: "Blocked: no auto-trading action will be sent.",
        source,
        confidence: 0.96,
        riskLevel: "high",
        now,
      }));
      warnings.push("Crypto auto-trading blocked; only thesis/risk support is allowed.");
    }

    return {
      nodes: dedupeNodes(nodes),
      edges: dedupeEdges(edgeInputs.map((input) => createMemoryEdge(input))),
      suggestions: dedupeSuggestions(suggestions),
      warnings,
    };
  }
}

function sourceFrom(message: IncomingMessage): MemoryGraphSource {
  return {
    platform: message.platform,
    conversationId: message.conversationId,
    messageId: message.messageId,
    occurredAt: message.occurredAt,
  };
}

function node(
  id: string,
  kind: Parameters<typeof createMemoryNode>[0]["kind"],
  label: string,
  source: MemoryGraphSource,
  confidence: number,
  now: Date,
  payload: Readonly<Record<string, unknown>> = {},
): MemoryNode {
  return createMemoryNode({
    id,
    kind,
    label,
    scope: "user",
    source,
    confidence,
    payload,
    now,
  });
}

function edgeInput(
  id: string,
  fromNodeId: string,
  toNodeId: string,
  relation: CreateMemoryEdgeInput["relation"],
  fact: string,
  source: MemoryGraphSource,
  confidence: number,
  now: Date,
): CreateMemoryEdgeInput {
  return { id, fromNodeId, toNodeId, relation, fact, source, confidence, now };
}

function hasAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function dedupeNodes(nodes: readonly MemoryNode[]): readonly MemoryNode[] {
  return uniqueBy(nodes, (nodeItem) => nodeItem.id);
}

function dedupeEdges(edges: readonly ReturnType<typeof createMemoryEdge>[]): readonly ReturnType<typeof createMemoryEdge>[] {
  return uniqueBy(edges, (edgeItem) => edgeItem.id);
}

function dedupeSuggestions(suggestions: readonly Suggestion[]): readonly Suggestion[] {
  return uniqueBy(suggestions, (suggestion) => suggestion.id);
}

function uniqueBy<T>(items: readonly T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyFor(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

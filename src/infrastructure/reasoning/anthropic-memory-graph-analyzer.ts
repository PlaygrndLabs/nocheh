import type { IncomingMessage } from "../../application/dto/incoming-message.js";
import type { MemoryGraphAnalysis, MemoryGraphAnalyzerPort } from "../../application/ports/memory-graph-analyzer.js";
import { validateAiAnalysisOutput } from "../../application/services/ai-analysis-contract.js";
import {
  createMemoryEdge,
  createMemoryNode,
  type CreateMemoryEdgeInput,
  type CreateMemoryNodeInput,
  type MemoryGraphSource,
  type MemoryGraphStatus,
  type MemoryNodeId,
} from "../../domain/memory/memory-graph.js";
import {
  createActionSuggestion,
  createStrategicSuggestion,
  type CreateActionSuggestionInput,
  type CreateStrategicSuggestionInput,
  type Suggestion,
} from "../../domain/memory/strategic-suggestion.js";
import type { AiTokenUsage } from "../../domain/observability/audit.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_API_VERSION = "2023-06-01";

export interface AnthropicMemoryGraphAnalyzerConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly apiVersion?: string;
  readonly baseUrl?: string;
  readonly minimumConfidence?: number;
  readonly maxTokens?: number;
}

interface AnthropicClaudeResponse {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
}

type JsonRecord = Record<string, unknown>;

/** Provider-backed graph analyzer using Anthropic Claude directly. */
export class AnthropicMemoryGraphAnalyzer implements MemoryGraphAnalyzerPort {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly minimumConfidence: number;
  private readonly maxTokens: number;

  public constructor(config: AnthropicMemoryGraphAnalyzerConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.minimumConfidence = config.minimumConfidence ?? 0.55;
    this.maxTokens = config.maxTokens ?? 4000;
  }

  public async analyze(message: IncomingMessage): Promise<MemoryGraphAnalysis> {
    const body = JSON.stringify({
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemPrompt(),
      messages: [{
        role: "user",
        content: [{ type: "text", text: userPrompt(message) }],
      }],
    });

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": this.apiVersion,
        "x-api-key": this.apiKey,
      },
      body,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Anthropic response failed with status ${response.status}: ${text}`);
    }

    const parsed = JSON.parse(text) as AnthropicClaudeResponse;
    const validated = validateAiAnalysisOutput(parseJsonOutput(parsed), { minimumConfidence: this.minimumConfidence });
    if (!validated.ok) {
      throw validated.error;
    }

    const nodes = validated.value.nodes.map((item) => createMemoryNode(nodeInput(item.value, item.source, item.confidence)));
    const edges = validated.value.edges.map((item) => createMemoryEdge(edgeInput(item.value, item.source, item.confidence)));
    const suggestions: Suggestion[] = [
      ...validated.value.strategicSuggestions.map((item) =>
        createStrategicSuggestion(strategicSuggestionInput(item.value, item.source, item.confidence)),
      ),
      ...validated.value.actionSuggestions.map((item) =>
        createActionSuggestion(actionSuggestionInput(item.value, item.source, item.confidence)),
      ),
    ];
    const usage = tokenUsage(parsed, this.model);

    return {
      nodes,
      edges,
      suggestions,
      warnings: validated.value.warnings.map((warning) => warning.message),
      ...(usage === undefined ? {} : { tokenUsage: usage }),
    };
  }
}

function systemPrompt(): string {
  return [
    "You are Nocheh's memory graph analyzer.",
    "Return only JSON. No markdown, no prose outside JSON.",
    "Extract structured knowledge from already-redacted chat text.",
    "Do not copy raw chat text into durable payloads, facts, or rationales.",
    "Separate facts from suggestions. Goals, ideas, hypotheses, routines, replies, and actions remain suggestions until Mak accepts them.",
    "Never suggest automatic crypto trading. Crypto support is thesis, risk, journal, and decision support only.",
    "The JSON root must contain arrays: memories, nodes, edges, strategicSuggestions, actionSuggestions, warnings.",
    "Every item must include idempotencyKey, source, confidence, reason, and value. Warnings use message instead of value.",
  ].join("\n");
}

function userPrompt(message: IncomingMessage): string {
  return JSON.stringify({
    source: {
      platform: message.platform,
      conversationId: message.conversationId,
      messageId: message.messageId,
      occurredAt: message.occurredAt.toISOString(),
    },
    senderId: message.senderId,
    senderDisplayName: message.senderDisplayName,
    sanitizedText: message.text,
  });
}

function parseJsonOutput(response: AnthropicClaudeResponse): unknown {
  const text = response.content
    ?.filter((content) => content.type === "text" || content.type === undefined)
    .map((content) => content.text)
    .filter((value): value is string => value !== undefined)
    .join("")
    .trim();
  if (text === undefined || text.length === 0) {
    throw new Error("Anthropic Claude response did not include text output.");
  }
  return JSON.parse(stripCodeFence(text));
}

function stripCodeFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match?.[1] ?? text;
}

function nodeInput(value: unknown, source: MemoryGraphSource, confidence: number): CreateMemoryNodeInput {
  const record = requireRecord(value, "node value");
  return {
    kind: requiredString(record.kind, "node kind") as CreateMemoryNodeInput["kind"],
    label: requiredString(record.label, "node label"),
    scope: (optionalString(record.scope) ?? "user") as CreateMemoryNodeInput["scope"],
    source: hydrateSource(source),
    confidence,
    ...(optionalString(record.id) === undefined ? {} : { id: requiredString(record.id, "node id") }),
    ...(optionalString(record.summary) === undefined ? {} : { summary: requiredString(record.summary, "node summary") }),
    aliases: arrayOfStrings(record.aliases),
    payload: objectValue(record.payload),
    status: (optionalString(record.status) ?? "active") as MemoryGraphStatus,
  };
}

function edgeInput(value: unknown, source: MemoryGraphSource, confidence: number): CreateMemoryEdgeInput {
  const record = requireRecord(value, "edge value");
  return {
    fromNodeId: requiredString(record.fromNodeId, "edge fromNodeId"),
    toNodeId: requiredString(record.toNodeId, "edge toNodeId"),
    relation: requiredString(record.relation, "edge relation") as CreateMemoryEdgeInput["relation"],
    fact: requiredString(record.fact, "edge fact"),
    source: hydrateSource(source),
    confidence,
    payload: objectValue(record.payload),
    status: (optionalString(record.status) ?? "active") as MemoryGraphStatus,
    ...(optionalString(record.id) === undefined ? {} : { id: requiredString(record.id, "edge id") }),
  };
}

function strategicSuggestionInput(value: unknown, source: MemoryGraphSource, confidence: number): CreateStrategicSuggestionInput {
  const record = requireRecord(value, "strategic suggestion value");
  return {
    kind: requiredString(record.kind, "strategic suggestion kind") as CreateStrategicSuggestionInput["kind"],
    title: requiredString(record.title, "strategic suggestion title"),
    rationale: requiredString(record.rationale, "strategic suggestion rationale"),
    source: hydrateSource(source),
    confidence,
    riskLevel: (optionalString(record.riskLevel) ?? "medium") as CreateStrategicSuggestionInput["riskLevel"],
    ...(optionalString(record.expectedValue) === undefined ? {} : { expectedValue: requiredString(record.expectedValue, "strategic suggestion expectedValue") }),
    evidenceNodeIds: arrayOfStrings(record.evidenceNodeIds) as readonly MemoryNodeId[],
    ...(optionalString(record.id) === undefined ? {} : { id: requiredString(record.id, "strategic suggestion id") }),
  };
}

function actionSuggestionInput(value: unknown, source: MemoryGraphSource, confidence: number): CreateActionSuggestionInput {
  const record = requireRecord(value, "action suggestion value");
  return {
    kind: requiredString(record.kind, "action suggestion kind") as CreateActionSuggestionInput["kind"],
    title: requiredString(record.title, "action suggestion title"),
    rationale: requiredString(record.rationale, "action suggestion rationale"),
    source: hydrateSource(source),
    confidence,
    riskLevel: (optionalString(record.riskLevel) ?? "medium") as CreateActionSuggestionInput["riskLevel"],
    target: requiredString(record.target, "action suggestion target"),
    preview: requiredString(record.preview, "action suggestion preview"),
    ...(optionalString(record.id) === undefined ? {} : { id: requiredString(record.id, "action suggestion id") }),
  };
}

function tokenUsage(response: AnthropicClaudeResponse, model: string): AiTokenUsage | undefined {
  const usage = response.usage;
  if (usage === undefined) {
    return undefined;
  }
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  return {
    provider: "anthropic",
    model,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function hydrateSource(source: MemoryGraphSource): MemoryGraphSource {
  return {
    ...source,
    occurredAt: source.occurredAt instanceof Date ? source.occurredAt : new Date(source.occurredAt),
  };
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Anthropic ${label} must be an object.`);
  }
  return value as JsonRecord;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Anthropic ${label} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function arrayOfStrings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

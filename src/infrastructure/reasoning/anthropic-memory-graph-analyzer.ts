import type { ConversationAnalysisInput } from "../../application/ports/memory-graph-analyzer.js";
import type {
  AnalyzedMemoryCandidate,
  AnalyzedStatusUpdate,
  AnalyzedTaskCandidate,
  MemoryGraphAnalysis,
  MemoryGraphAnalyzerPort,
} from "../../application/ports/memory-graph-analyzer.js";
import type { ExtractedMemoryCandidate } from "../../application/ports/memory-extractor.js";
import { validateAiAnalysisOutput } from "../../application/services/ai-analysis-contract.js";
import type { IncomingMessage } from "../../application/dto/incoming-message.js";
import {
  createMemoryEdge,
  createMemoryNode,
  type CreateMemoryEdgeInput,
  type CreateMemoryNodeInput,
  type MemoryGraphSource,
  type MemoryGraphStatus,
  type MemoryNodeId,
} from "../../domain/memory/memory-graph.js";
import { projectIdFromName } from "../../domain/memory/memory-record.js";
import {
  createActionSuggestion,
  createStrategicSuggestion,
  type CreateActionSuggestionInput,
  type CreateStrategicSuggestionInput,
  type Suggestion,
} from "../../domain/memory/strategic-suggestion.js";
import type { TaskPriority, TaskStatus } from "../../domain/tasks/task.js";
import type { AiTokenUsage } from "../../domain/observability/audit.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_API_VERSION = "2023-06-01";

const MEMORY_TYPES = new Set(["Project", "Decision", "Deadline", "Blocker", "Summary"]);
const TASK_STATUSES = new Set<TaskStatus>(["open", "in_progress", "completed", "cancelled"]);
const TASK_PRIORITIES = new Set<TaskPriority>(["low", "medium", "high", "urgent"]);

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

/** Provider-backed brain that reasons over a whole conversation window using Anthropic Claude. */
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

  public async analyze(input: ConversationAnalysisInput): Promise<MemoryGraphAnalysis> {
    const body = JSON.stringify({
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemPrompt(),
      messages: [{
        role: "user",
        content: [{ type: "text", text: userPrompt(input) }],
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
    const memories = validated.value.memories.flatMap((item) => {
      const candidate = memoryCandidate(item.value, item.confidence, item.reason);
      return candidate === undefined ? [] : [{ sourceMessageId: item.source.messageId, candidate }];
    }) as readonly AnalyzedMemoryCandidate[];
    const tasks = validated.value.tasks.flatMap((item) => {
      const task = taskCandidate(item.value, item.source.messageId, item.confidence, item.reason);
      return task === undefined ? [] : [task];
    }) as readonly AnalyzedTaskCandidate[];
    const statusUpdates = validated.value.statusUpdates.flatMap((item) => {
      const update = statusUpdate(item.value, item.source.messageId, item.confidence, item.reason);
      return update === undefined ? [] : [update];
    }) as readonly AnalyzedStatusUpdate[];
    const usage = tokenUsage(parsed, this.model);

    return {
      memories,
      nodes,
      edges,
      suggestions,
      tasks,
      statusUpdates,
      warnings: validated.value.warnings.map((warning) => warning.message),
      ...(usage === undefined ? {} : { tokenUsage: usage }),
    };
  }
}

function systemPrompt(): string {
  return [
    "You are Nocheh's memory graph analyzer and second-brain.",
    "You receive an ordered window of already-redacted chat messages from ONE conversation, plus optional grounding context.",
    "Reason across the whole window: connect messages that reference each other, resolve who said what, and infer relationships.",
    "Understand meaning from natural language. Do NOT rely on rigid keywords or templates like 'Project: X' or 'Task: Y'.",
    "Infer projects from natural conversation. A conversation may cover one project or several; link tasks, decisions, and people to the right project.",
    "Interpret emoji reactions in context (for example a check-style reaction usually means done, a thumbs up means acknowledged) — decide from meaning, never a fixed rule.",
    "Treat any provided manual note as an authoritative instruction from Mak that overrides conflicting chatter.",
    "Return only JSON. No markdown, no prose outside JSON.",
    "Do not copy raw chat text into durable payloads, facts, or rationales.",
    "Separate facts from suggestions. Goals, ideas, hypotheses, routines, replies, and actions remain suggestions until Mak accepts them.",
    "Never suggest automatic crypto trading. Crypto support is thesis, risk, journal, and decision support only.",
    "The JSON root must contain arrays: memories, nodes, edges, strategicSuggestions, actionSuggestions, tasks, statusUpdates, warnings.",
    "Every item must include idempotencyKey, source, confidence, reason, and value. Warnings use message instead of value.",
    "source.messageId MUST be the id of the specific window message the item came from, so knowledge stays traceable.",
    "tasks[].value: { title, description?, priority?(low|medium|high|urgent), dueAt?(ISO), assignee? }.",
    "statusUpdates[].value: { targetMessageId, status(open|in_progress|completed|cancelled) } to change an EXISTING task/node derived from that message (e.g. closing a task after a done reaction).",
    "memories[].value: { type(Project|Decision|Deadline|Blocker|Summary), ...typed fields } for durable structured memory.",
  ].join("\n");
}

function userPrompt(input: ConversationAnalysisInput): string {
  const window = input.window;
  return JSON.stringify({
    conversation: {
      platform: window.platform,
      conversationId: window.conversationId,
      projectHint: window.projectHint ?? "unknown",
    },
    ...(window.note === undefined ? {} : { manualNote: window.note }),
    ...(input.contextText === undefined ? {} : { groundingContext: input.contextText }),
    ...(input.candidateTargets === undefined || input.candidateTargets.length === 0
      ? {}
      : { existingKnowledge: input.candidateTargets }),
    messages: window.messages.map((message) => describeMessage(message)),
  });
}

function describeMessage(message: IncomingMessage): JsonRecord {
  return {
    messageId: message.messageId,
    senderId: message.senderId,
    ...(message.senderDisplayName === undefined ? {} : { sender: message.senderDisplayName }),
    occurredAt: message.occurredAt.toISOString(),
    ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
    ...(message.reactions === undefined || message.reactions.length === 0
      ? {}
      : {
        reactions: message.reactions.map((reaction) => ({
          emoji: reaction.emoji,
          ...(reaction.reactorDisplayName === undefined ? {} : { by: reaction.reactorDisplayName }),
        })),
      }),
    text: message.text,
  };
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

function taskCandidate(
  value: unknown,
  sourceMessageId: string,
  confidence: number,
  reason: string,
): AnalyzedTaskCandidate | undefined {
  const record = requireRecord(value, "task value");
  const title = optionalString(record.title);
  if (title === undefined) {
    return undefined;
  }
  const priority = optionalString(record.priority) as TaskPriority | undefined;
  const dueAt = optionalDate(record.dueAt);
  const description = optionalString(record.description);
  const assignee = optionalString(record.assignee);
  return {
    title,
    confidence,
    extractionReason: reason,
    sourceMessageId,
    ...(description === undefined ? {} : { description }),
    ...(assignee === undefined ? {} : { assignee }),
    ...(priority !== undefined && TASK_PRIORITIES.has(priority) ? { priority } : {}),
    ...(dueAt === undefined ? {} : { dueAt }),
  };
}

function statusUpdate(
  value: unknown,
  sourceMessageId: string,
  confidence: number,
  reason: string,
): AnalyzedStatusUpdate | undefined {
  const record = requireRecord(value, "status update value");
  const status = optionalString(record.status) as TaskStatus | undefined;
  if (status === undefined || !TASK_STATUSES.has(status)) {
    return undefined;
  }
  const targetMessageId = optionalString(record.targetMessageId) ?? sourceMessageId;
  return { targetMessageId, status, reason, confidence };
}

function memoryCandidate(value: unknown, confidence: number, reason: string): ExtractedMemoryCandidate | undefined {
  const record = requireRecord(value, "memory value");
  const type = optionalString(record.type);
  if (type === undefined || !MEMORY_TYPES.has(type)) {
    return undefined;
  }
  const base = { confidence, extractionReason: reason };
  switch (type) {
    case "Project": {
      const name = optionalString(record.name) ?? optionalString(record.title);
      if (name === undefined) {
        return undefined;
      }
      const description = optionalString(record.description);
      const status = optionalString(record.status);
      return {
        type: "Project",
        ...base,
        project: { id: projectIdFromName(name), name },
        projectMemory: {
          name,
          ...(description === undefined ? {} : { description }),
          ...(status === undefined ? {} : { status }),
        },
      };
    }
    case "Decision": {
      const title = optionalString(record.title);
      const outcome = optionalString(record.outcome);
      if (title === undefined || outcome === undefined) {
        return undefined;
      }
      const rationale = optionalString(record.rationale);
      return {
        type: "Decision",
        ...base,
        decision: { title, outcome, ...(rationale === undefined ? {} : { rationale }) },
      };
    }
    case "Deadline": {
      const title = optionalString(record.title);
      if (title === undefined) {
        return undefined;
      }
      const dueAt = optionalDate(record.dueAt);
      const description = optionalString(record.description);
      return {
        type: "Deadline",
        ...base,
        deadline: {
          title,
          ...(dueAt === undefined ? {} : { dueAt }),
          ...(description === undefined ? {} : { description }),
        },
      };
    }
    case "Blocker": {
      const description = optionalString(record.description);
      if (description === undefined) {
        return undefined;
      }
      const status = optionalString(record.status) === "resolved" ? "resolved" : "open";
      const owner = optionalString(record.owner);
      return {
        type: "Blocker",
        ...base,
        blocker: { description, status, ...(owner === undefined ? {} : { owner }) },
      };
    }
    case "Summary": {
      const title = optionalString(record.title);
      const summaryText = optionalString(record.summary);
      if (title === undefined || summaryText === undefined) {
        return undefined;
      }
      return {
        type: "Summary",
        ...base,
        summary: { title, summary: summaryText, coveredRecordIds: [] },
      };
    }
    default:
      return undefined;
  }
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

function optionalDate(value: unknown): Date | undefined {
  const text = optionalString(value);
  if (text === undefined) {
    return undefined;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function arrayOfStrings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

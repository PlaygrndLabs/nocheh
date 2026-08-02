import type { ConversationAnalysisInput } from "../../application/ports/memory-graph-analyzer.js";
import type {
  AnalyzedMemoryCandidate,
  AnalyzedStatusUpdate,
  AnalyzedTaskCandidate,
  MemoryGraphAnalysis,
} from "../../application/ports/memory-graph-analyzer.js";
import type { ExtractedMemoryCandidate } from "../../application/ports/memory-extractor.js";
import { validateAiAnalysisOutputDetailed } from "../../application/services/ai-analysis-contract.js";
import type { ConversationWindow } from "../../application/dto/conversation-window.js";
import type { IncomingMessage } from "../../application/dto/incoming-message.js";
import {
  createMemoryEdge,
  createMemoryNode,
  type CreateMemoryEdgeInput,
  type CreateMemoryNodeInput,
  type MemoryGraphSource,
  type MemoryEdge,
  type MemoryGraphStatus,
  type MemoryNode,
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

/**
 * Provider-neutral prompt and mapping layer shared by every LLM adapter.
 *
 * Adapters own transport only (endpoint, auth, wire request/response shape).
 * The prompt, the provider-neutral output contract, and the mapping into domain
 * objects live here so providers stay interchangeable.
 */

/** Confidence floor applied to provider output before it becomes domain knowledge. */
export const DEFAULT_MINIMUM_CONFIDENCE = 0.55;

/** Default output budget for a single analysis call. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4000;

const MEMORY_TYPES = new Set(["Project", "Decision", "Deadline", "Blocker", "Summary"]);
const TASK_STATUSES = new Set<TaskStatus>(["open", "in_progress", "completed", "cancelled"]);
const TASK_PRIORITIES = new Set<TaskPriority>(["low", "medium", "high", "urgent"]);

type JsonRecord = Record<string, unknown>;

export interface BuildMemoryGraphAnalysisOptions {
  /** Parsed JSON the provider returned. */
  readonly rawOutput: unknown;
  /** Provider id recorded in audit/token usage, for example "nvidia". */
  readonly provider: string;
  readonly minimumConfidence: number;
  readonly tokenUsage?: AiTokenUsage;
  /**
   * The analysed window. When given, each item's source reference is resolved from
   * it rather than taken from the model. Adapters should always pass this.
   */
  readonly window?: ConversationWindow;
}

/** Shared system instructions. Identical across providers so output stays comparable. */
export function analysisSystemPrompt(): string {
  return [
    "You are Nocheh's memory graph analyzer and second-brain.",
    "You receive an ordered window of already-redacted chat messages from ONE conversation, plus optional grounding context.",
    "Reason across the whole window: connect messages that reference each other, resolve who said what, and infer relationships.",
    "Understand meaning from natural language. Do NOT rely on rigid keywords or templates like 'Project: X' or 'Task: Y'.",
    "Infer projects from natural conversation. A conversation may cover one project or several; link tasks, decisions, and people to the right project.",
    "Interpret emoji reactions in context (for example a check-style reaction usually means done, a thumbs up means acknowledged) — decide from meaning, never a fixed rule.",
    "A message may carry attachments (images, voice notes). When an attachment has understood=true, treat its description and transcript as that message's content and extract knowledge from it. When understood=false, note that media was sent but do not guess what it contained.",
    "Attachment descriptions come from a perception model and may be wrong; lower confidence for knowledge derived only from an attachment.",
    "Treat any provided manual note as an authoritative instruction from Mak that overrides conflicting chatter.",
    "Return only JSON. No markdown, no prose outside JSON.",
    "Do not copy raw chat text into durable payloads, facts, or rationales.",
    "Separate facts from suggestions. Goals, ideas, hypotheses, routines, replies, and actions remain suggestions until Mak accepts them.",
    "Never suggest automatic crypto trading. Crypto support is thesis, risk, journal, and decision support only.",
    "The JSON root must contain arrays: memories, nodes, edges, strategicSuggestions, actionSuggestions, tasks, statusUpdates, warnings.",
    "Every item must include idempotencyKey, source, confidence, reason, and value. Warnings use message instead of value.",
    "source is exactly { \"messageId\": \"<id of the window message this came from>\" } and nothing else.",
    "Never invent a messageId. Use one of the ids listed in messages, so knowledge stays traceable.",
    "tasks[].value: { title, description?, priority?(low|medium|high|urgent), dueAt?(ISO), assignee? }.",
    "statusUpdates[].value: { targetMessageId, status(open|in_progress|completed|cancelled) } to change an EXISTING task/node derived from that message (e.g. closing a task after a done reaction).",
    "memories[].value: { type(Project|Decision|Deadline|Blocker|Summary), ...typed fields } for durable structured memory.",
  ].join("\n");
}

/** Serializes the analysis window into the provider-neutral user prompt. */
export function analysisUserPrompt(input: ConversationAnalysisInput): string {
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

/** Removes a ```json fence some models wrap JSON output in. */
export function stripCodeFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match?.[1] ?? text;
}

/** Parses provider text output into JSON, tolerating a surrounding code fence. */
export function parseAnalysisJson(text: string, provider: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error(`${provider} response did not include text output.`);
  }
  try {
    return JSON.parse(stripCodeFence(trimmed));
  } catch (error) {
    throw new Error(`${provider} response was not valid JSON: ${(error as Error).message}`, { cause: error });
  }
}

/** Builds token usage from any provider's input/output counters. */
export function createTokenUsage(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): AiTokenUsage {
  return {
    provider,
    model,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

/** Validates provider output against the neutral contract and maps it into domain objects. */
export function buildMemoryGraphAnalysis(options: BuildMemoryGraphAnalysisOptions): MemoryGraphAnalysis {
  const rawOutput = options.window === undefined
    ? options.rawOutput
    : resolveItemSources(options.rawOutput, options.window);
  const validated = validateAiAnalysisOutputDetailed(rawOutput, {
    minimumConfidence: options.minimumConfidence,
    // Structural problems still reject the window. A single malformed item does not:
    // discarding a whole conversation over one bad suggestion loses real knowledge.
    onInvalidItem: "skip",
  });
  if (!validated.ok) {
    throw new Error(`${options.provider} analysis output rejected: ${validated.error.message}`, { cause: validated.error });
  }

  const output = validated.value.output;
  // Items that validated but cannot be mapped into the domain are dropped the same
  // way, so a shape the prompt did not pin down degrades instead of failing.
  const mappingWarnings: string[] = [...validated.value.skipped];
  function mapKept<T>(items: readonly T[], map: (item: T) => unknown, label: string): readonly unknown[] {
    const mapped: unknown[] = [];
    for (const item of items) {
      try {
        mapped.push(map(item));
      } catch (error) {
        mappingWarnings.push(`Dropped ${label}: ${(error as Error).message}`);
      }
    }
    return mapped;
  }

  try {
    const nodes = mapKept(
      output.nodes,
      (item) => createMemoryNode(nodeInput(item.value, item.source, item.confidence)),
      "graph node",
    ) as readonly MemoryNode[];
    const edges = mapKept(
      output.edges,
      (item) => createMemoryEdge(edgeInput(item.value, item.source, item.confidence)),
      "graph edge",
    ) as readonly MemoryEdge[];
    const suggestions: Suggestion[] = [
      ...mapKept(
        output.strategicSuggestions,
        (item) => createStrategicSuggestion(strategicSuggestionInput(item.value, item.source, item.confidence)),
        "strategic suggestion",
      ) as readonly Suggestion[],
      ...mapKept(
        output.actionSuggestions,
        (item) => createActionSuggestion(actionSuggestionInput(item.value, item.source, item.confidence)),
        "action suggestion",
      ) as readonly Suggestion[],
    ];
    const memories = output.memories.flatMap((item) => {
      const candidate = memoryCandidate(item.value, item.confidence, item.reason);
      return candidate === undefined ? [] : [{ sourceMessageId: item.source.messageId, candidate }];
    }) as readonly AnalyzedMemoryCandidate[];
    const tasks = output.tasks.flatMap((item) => {
      const task = taskCandidate(item.value, item.source.messageId, item.confidence, item.reason);
      return task === undefined ? [] : [task];
    }) as readonly AnalyzedTaskCandidate[];
    const statusUpdates = output.statusUpdates.flatMap((item) => {
      const update = statusUpdate(item.value, item.source.messageId, item.confidence, item.reason);
      return update === undefined ? [] : [update];
    }) as readonly AnalyzedStatusUpdate[];

    return {
      memories,
      nodes,
      edges,
      suggestions,
      tasks,
      statusUpdates,
      warnings: [...output.warnings.map((warning) => warning.message), ...mappingWarnings],
      ...(options.tokenUsage === undefined ? {} : { tokenUsage: options.tokenUsage }),
    };
  } catch (error) {
    throw new Error(`${options.provider} analysis output could not be mapped: ${(error as Error).message}`, { cause: error });
  }
}

const ENVELOPE_KEYS = [
  "memories",
  "nodes",
  "edges",
  "strategicSuggestions",
  "actionSuggestions",
  "tasks",
  "statusUpdates",
  "warnings",
] as const;

/**
 * Fills each item's source reference from the window instead of trusting the model.
 *
 * The model is only asked which window message an item came from. Platform,
 * conversation id, and timestamp are known locally, so echoing them back would waste
 * tokens and give the model a chance to attribute knowledge to the wrong
 * conversation. Verified against `z-ai/glm-5.2`, which returns `{ messageId }` alone.
 *
 * An unrecognised messageId falls back to the window anchor: the item still came from
 * this conversation, and keeping it attributed to the closest real message is better
 * than discarding extracted knowledge.
 */
function resolveItemSources(rawOutput: unknown, window: ConversationWindow): unknown {
  if (!isJsonRecord(rawOutput)) {
    return rawOutput;
  }

  const byId = new Map(window.messages.map((message) => [message.messageId, message]));
  const anchor = window.messages[window.messages.length - 1];
  if (anchor === undefined) {
    return rawOutput;
  }

  const resolved: Record<string, unknown> = { ...rawOutput };
  for (const key of ENVELOPE_KEYS) {
    const items = resolved[key];
    if (!Array.isArray(items)) {
      continue;
    }
    resolved[key] = items.map((item) => {
      if (!isJsonRecord(item)) {
        return item;
      }
      const rawSource = isJsonRecord(item.source) ? item.source : {};
      const claimedId = typeof rawSource.messageId === "string" ? rawSource.messageId : undefined;
      const message = (claimedId === undefined ? undefined : byId.get(claimedId)) ?? anchor;
      return {
        ...item,
        source: {
          platform: message.platform,
          conversationId: message.conversationId,
          messageId: message.messageId,
          occurredAt: message.occurredAt.toISOString(),
        },
      };
    });
  }
  return resolved;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    ...(message.attachments === undefined || message.attachments.length === 0
      ? {}
      : {
        attachments: message.attachments.map((attachment) => ({
          kind: attachment.kind,
          ...(attachment.fileName === undefined ? {} : { fileName: attachment.fileName }),
          ...(attachment.durationSeconds === undefined ? {} : { durationSeconds: attachment.durationSeconds }),
          ...(attachment.understanding === undefined
            ? { understood: false }
            : {
              understood: true,
              description: attachment.understanding.description,
              ...(attachment.understanding.transcript === undefined
                ? {}
                : { transcript: attachment.understanding.transcript }),
              confidence: attachment.understanding.confidence,
            }),
        })),
      }),
  };
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

function hydrateSource(source: MemoryGraphSource): MemoryGraphSource {
  return {
    ...source,
    occurredAt: source.occurredAt instanceof Date ? source.occurredAt : new Date(source.occurredAt),
  };
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
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

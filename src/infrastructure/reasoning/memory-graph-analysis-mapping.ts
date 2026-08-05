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
  isMemoryPayloadKind,
  requiredMemoryPayloadFields,
  MEMORY_GRAPH_SCOPES,
  MEMORY_GRAPH_STATUSES,
  MEMORY_NODE_KINDS,
  MEMORY_PAYLOAD_FIELD_SPECS,
  MEMORY_PAYLOAD_KINDS,
  MEMORY_RELATIONS,
  type CreateMemoryEdgeInput,
  type CreateMemoryNodeInput,
  type MemoryGraphSource,
  type MemoryEdge,
  type MemoryNode,
  type MemoryNodeId,
} from "../../domain/memory/memory-graph.js";
import { projectIdFromName } from "../../domain/memory/memory-record.js";
import {
  createActionSuggestion,
  createStrategicSuggestion,
  EXTERNAL_ACTION_KINDS,
  STRATEGIC_SUGGESTION_KINDS,
  SUGGESTION_RISK_LEVELS,
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

const MEMORY_TYPES = ["Project", "Decision", "Deadline", "Blocker", "Summary"] as const;
const TASK_STATUSES: readonly TaskStatus[] = ["open", "in_progress", "completed", "cancelled"];
const TASK_PRIORITIES: readonly TaskPriority[] = ["low", "medium", "high", "urgent"];

/**
 * Minimum id length and the no-whitespace rule the graph domain enforces.
 *
 * `normalizeGraphId` throws on anything shorter or containing a space, so a model that
 * answers `"my project"` loses the node. The prompt has to say so up front.
 */
const GRAPH_ID_RULE = "at least 3 characters, no whitespace";

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

/**
 * Shared system instructions. Identical across providers so output stays comparable.
 *
 * Every value vocabulary is rendered from the domain arrays rather than written by
 * hand. The four graph and suggestion arrays used to be undocumented here, so models
 * invented plausible shapes (`{type, title, project}` for a node, a bare string for a
 * suggestion) and every item was discarded. Generating the contract from the domain is
 * what stops that from silently recurring.
 */
export function analysisSystemPrompt(minimumConfidence: number = DEFAULT_MINIMUM_CONFIDENCE): string {
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
    "source is exactly { \"messageId\": \"<id of a window message>\" } and nothing else. Never invent a messageId: knowledge must stay traceable.",
    `Only return items you are at least ${minimumConfidence} confident in; the rest are discarded.`,
    `Every id must be ${GRAPH_ID_RULE}, in slug form like project:acme-site. Labels, facts, titles, and rationales need at least 2 characters.`,
    "",
    "Value shapes. ? marks optional, [] an array, (a|b) the only accepted values; anything outside them is discarded.",
    "tasks[].value: { title, description?, priority?(low|medium|high|urgent), dueAt?(ISO), assignee? }.",
    "statusUpdates[].value: { targetMessageId, status(open|in_progress|completed|cancelled) } changes an EXISTING task/node from that message, e.g. closing a task after a done reaction.",
    `memories[].value: { type(${MEMORY_TYPES.join("|")}), ...fields }. Project needs name; Decision title+outcome; Deadline title, dueAt?(ISO); Blocker description, status?(open|resolved), owner?; Summary title+summary.`,
    `nodes[].value: { id, kind(${MEMORY_NODE_KINDS.join("|")}), label, scope?(${MEMORY_GRAPH_SCOPES.join("|")}), status?(${MEMORY_GRAPH_STATUSES.join("|")}), summary?, aliases?[], payload?{ payloadKind, ...fields for that kind } }.`,
    `payloadKind fields: ${payloadFieldContract()}.`,
    `edges[].value: { id, fromNodeId, toNodeId, relation(${MEMORY_RELATIONS.join("|")}), fact, status?, validFrom?(ISO), validUntil?(ISO) }. Both endpoints must be ids you return in nodes or ids in existingKnowledge.`,
    `strategicSuggestions[].value: { id, kind(${STRATEGIC_SUGGESTION_KINDS.join("|")}), title, rationale, riskLevel?(${SUGGESTION_RISK_LEVELS.join("|")}), expectedValue?, evidenceNodeIds?[] }: things Mak might decide to do.`,
    `actionSuggestions[].value: { id, kind(${EXTERNAL_ACTION_KINDS.join("|")}), title, rationale, riskLevel?(${SUGGESTION_RISK_LEVELS.join("|")}), target, preview }: external effects awaiting Mak's approval. target is who or what it acts on; preview is the exact content that would be sent or written.`,
    "warnings[].message: a short note about anything you refused, could not resolve, or found contradictory.",
  ].join("\n");
}

/**
 * Renders `MEMORY_PAYLOAD_FIELD_SPECS` as `kind(field,field) kind(field)`.
 *
 * The single largest line in the prompt, so the notation is terse on purpose. It also
 * doubles as the list of valid `payloadKind` values, which is why no separate
 * enumeration of them is sent.
 */
function payloadFieldContract(): string {
  return MEMORY_PAYLOAD_KINDS
    .map((kind) => `${kind}(${MEMORY_PAYLOAD_FIELD_SPECS[kind].join(",")})`)
    .join(" ");
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
  reasoningTokens?: number,
): AiTokenUsage {
  return {
    provider,
    model,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(reasoningTokens === undefined || reasoningTokens <= 0 ? {} : { reasoningTokens }),
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
  /** Records a problem that degraded an item without discarding it. */
  const warn = (message: string): void => {
    mappingWarnings.push(message);
  };
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
      (item) => createMemoryNode(nodeInput(item.value, item.source, item.confidence, warn)),
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
    // memories, tasks and statusUpdates go through the same mapKept path as the graph
    // arrays. They used to be mapped with flatMap and dropped silently on an unknown
    // type or a missing title, while a non-object value threw out to the catch below
    // and rejected the entire window — the exact opposite of the documented policy.
    const memories = mapKept(
      output.memories,
      (item) => ({
        sourceMessageId: item.source.messageId,
        candidate: memoryCandidate(item.value, item.confidence, item.reason),
      }),
      "memory",
    ) as readonly AnalyzedMemoryCandidate[];
    const tasks = mapKept(
      output.tasks,
      (item) => taskCandidate(item.value, item.source.messageId, item.confidence, item.reason),
      "task",
    ) as readonly AnalyzedTaskCandidate[];
    const statusUpdates = mapKept(
      output.statusUpdates,
      (item) => statusUpdate(item.value, item.source.messageId, item.confidence, item.reason),
      "status update",
    ) as readonly AnalyzedStatusUpdate[];

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

function nodeInput(
  value: unknown,
  source: MemoryGraphSource,
  confidence: number,
  warn: (message: string) => void,
): CreateMemoryNodeInput {
  const record = requireRecord(value, "node value");
  return {
    kind: requiredEnum(record.kind, "node kind", MEMORY_NODE_KINDS),
    label: requiredString(record.label, "node label"),
    scope: optionalEnum(record.scope, "node scope", MEMORY_GRAPH_SCOPES, "user"),
    source: hydrateSource(source),
    confidence,
    ...(optionalString(record.id) === undefined ? {} : { id: requiredString(record.id, "node id") }),
    ...(optionalString(record.summary) === undefined ? {} : { summary: requiredString(record.summary, "node summary") }),
    aliases: arrayOfStrings(record.aliases),
    payload: nodePayload(record.payload, warn),
    status: optionalEnum(record.status, "node status", MEMORY_GRAPH_STATUSES, "active"),
  };
}

/**
 * Keeps a free-form payload, refuses an unknown `payloadKind`, and discards a payload
 * that does not carry the fields its kind requires.
 *
 * An absent payload is fine — plenty of nodes are just a label. A payload tagged with a
 * kind the domain does not know is worse than none: every reader that switches on
 * `payloadKind` would ignore it, so the node would look stored while carrying nothing.
 *
 * A payload missing required fields is the quiet case. `MemoryGraphPayload` is
 * `Record<string, unknown>`, so `{ payloadKind: "goal" }` with the status left on the
 * node satisfies every type and silently produces a goal with no goal in it. The node
 * still has value — a label and a kind are real knowledge — so it is kept and only the
 * payload is dropped, with a reason.
 */
function nodePayload(value: unknown, warn: (message: string) => void): Readonly<Record<string, unknown>> {
  const payload = objectValue(value);
  const kind = payload.payloadKind;
  if (kind === undefined) {
    return payload;
  }
  if (!isMemoryPayloadKind(kind)) {
    throw new Error(
      `node payload payloadKind must be one of: ${MEMORY_PAYLOAD_KINDS.join(", ")}. Received ${describeValue(kind)}.`,
    );
  }

  const missing = requiredMemoryPayloadFields(kind).filter((field) => payload[field] === undefined);
  if (missing.length > 0) {
    warn(`Dropped ${kind} payload: missing ${missing.join(", ")}. Node kept without it.`);
    return {};
  }
  return payload;
}

function edgeInput(value: unknown, source: MemoryGraphSource, confidence: number): CreateMemoryEdgeInput {
  const record = requireRecord(value, "edge value");
  return {
    fromNodeId: requiredString(record.fromNodeId, "edge fromNodeId"),
    toNodeId: requiredString(record.toNodeId, "edge toNodeId"),
    relation: requiredEnum(record.relation, "edge relation", MEMORY_RELATIONS),
    fact: requiredString(record.fact, "edge fact"),
    source: hydrateSource(source),
    confidence,
    payload: objectValue(record.payload),
    status: optionalEnum(record.status, "edge status", MEMORY_GRAPH_STATUSES, "active"),
    ...(optionalString(record.id) === undefined ? {} : { id: requiredString(record.id, "edge id") }),
    ...(optionalDate(record.validFrom) === undefined ? {} : { validFrom: optionalDate(record.validFrom) as Date }),
    ...(optionalDate(record.validUntil) === undefined ? {} : { validUntil: optionalDate(record.validUntil) as Date }),
  };
}

function strategicSuggestionInput(value: unknown, source: MemoryGraphSource, confidence: number): CreateStrategicSuggestionInput {
  const record = requireRecord(value, "strategic suggestion value");
  return {
    kind: requiredEnum(record.kind, "strategic suggestion kind", STRATEGIC_SUGGESTION_KINDS),
    title: requiredString(record.title, "strategic suggestion title"),
    rationale: requiredString(record.rationale, "strategic suggestion rationale"),
    source: hydrateSource(source),
    confidence,
    riskLevel: optionalEnum(record.riskLevel, "strategic suggestion riskLevel", SUGGESTION_RISK_LEVELS, "medium"),
    ...(optionalString(record.expectedValue) === undefined ? {} : { expectedValue: requiredString(record.expectedValue, "strategic suggestion expectedValue") }),
    evidenceNodeIds: arrayOfStrings(record.evidenceNodeIds) as readonly MemoryNodeId[],
    ...(optionalString(record.id) === undefined ? {} : { id: requiredString(record.id, "strategic suggestion id") }),
  };
}

function actionSuggestionInput(value: unknown, source: MemoryGraphSource, confidence: number): CreateActionSuggestionInput {
  const record = requireRecord(value, "action suggestion value");
  return {
    kind: requiredEnum(record.kind, "action suggestion kind", EXTERNAL_ACTION_KINDS),
    title: requiredString(record.title, "action suggestion title"),
    rationale: requiredString(record.rationale, "action suggestion rationale"),
    source: hydrateSource(source),
    confidence,
    riskLevel: optionalEnum(record.riskLevel, "action suggestion riskLevel", SUGGESTION_RISK_LEVELS, "medium"),
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
): AnalyzedTaskCandidate {
  const record = requireRecord(value, "task value");
  const title = requiredString(record.title, "task title");
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
    ...(priority !== undefined && TASK_PRIORITIES.includes(priority) ? { priority } : {}),
    ...(dueAt === undefined ? {} : { dueAt }),
  };
}

function statusUpdate(
  value: unknown,
  sourceMessageId: string,
  confidence: number,
  reason: string,
): AnalyzedStatusUpdate {
  const record = requireRecord(value, "status update value");
  const status = requiredEnum(record.status, "status update status", TASK_STATUSES);
  const targetMessageId = optionalString(record.targetMessageId) ?? sourceMessageId;
  return { targetMessageId, status, reason, confidence };
}

function memoryCandidate(value: unknown, confidence: number, reason: string): ExtractedMemoryCandidate {
  const record = requireRecord(value, "memory value");
  const type = requiredEnum(record.type, "memory type", MEMORY_TYPES);
  const base = { confidence, extractionReason: reason };
  switch (type) {
    case "Project": {
      const name = optionalString(record.name) ?? requiredString(record.title, "memory Project name");
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
      const title = requiredString(record.title, "memory Decision title");
      const outcome = requiredString(record.outcome, "memory Decision outcome");
      const rationale = optionalString(record.rationale);
      return {
        type: "Decision",
        ...base,
        decision: { title, outcome, ...(rationale === undefined ? {} : { rationale }) },
      };
    }
    case "Deadline": {
      const title = requiredString(record.title, "memory Deadline title");
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
      const description = requiredString(record.description, "memory Blocker description");
      const status = optionalString(record.status) === "resolved" ? "resolved" : "open";
      const owner = optionalString(record.owner);
      return {
        type: "Blocker",
        ...base,
        blocker: { description, status, ...(owner === undefined ? {} : { owner }) },
      };
    }
    case "Summary": {
      const title = requiredString(record.title, "memory Summary title");
      const summaryText = requiredString(record.summary, "memory Summary summary");
      return {
        type: "Summary",
        ...base,
        summary: { title, summary: summaryText, coveredRecordIds: [] },
      };
    }
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

/**
 * Jointly enforces "is a string" and "is in the domain vocabulary".
 *
 * These fields used to be cast straight through, so an invented relation such as
 * `MENTIONS` was written to SQLite and only failed later, at read time, as a value no
 * `MemoryRelation` switch handles. Failing here turns it into one skipped item with a
 * reason a human can read.
 */
function requiredEnum<T extends string>(value: unknown, label: string, vocabulary: readonly T[]): T {
  const text = requiredString(value, label);
  if (!(vocabulary as readonly string[]).includes(text)) {
    throw new Error(`${label} must be one of: ${vocabulary.join(", ")}. Received ${describeValue(text)}.`);
  }
  return text as T;
}

/** Same check, but an absent value falls back instead of failing. */
function optionalEnum<T extends string>(value: unknown, label: string, vocabulary: readonly T[], fallback: T): T {
  const text = optionalString(value);
  if (text === undefined) {
    return fallback;
  }
  if (!(vocabulary as readonly string[]).includes(text)) {
    throw new Error(`${label} must be one of: ${vocabulary.join(", ")}. Received ${describeValue(text)}.`);
  }
  return text as T;
}

/** Short, quoted rendering of a rejected value so the audit reason is actionable. */
function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`;
  }
  return typeof value;
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

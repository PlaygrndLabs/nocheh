import type {
  CreateMemoryEdgeInput,
  CreateMemoryNodeInput,
  MemoryGraphSource,
  MemoryNodeId,
} from "./memory-graph.js";
import {
  normalizeGraphId,
  normalizeGraphLabel,
  validateConfidence,
} from "./memory-graph.js";

export type SuggestionId = string;

/**
 * Suggestion vocabularies are runtime values for the same reason the graph ones are:
 * the analysis prompt renders them and the mapping layer validates against them.
 */
export const SUGGESTION_STATUSES = ["pending", "accepted", "rejected", "archived", "converted"] as const;

export type SuggestionStatus = typeof SUGGESTION_STATUSES[number];

export const SUGGESTION_RISK_LEVELS = ["low", "medium", "high"] as const;

export type SuggestionRiskLevel = typeof SUGGESTION_RISK_LEVELS[number];

export const STRATEGIC_SUGGESTION_KINDS = [
  "goal",
  "idea",
  "opportunity",
  "routine_experiment",
  "hypothesis",
  "recommendation",
] as const;

export type StrategicSuggestionKind = typeof STRATEGIC_SUGGESTION_KINDS[number];

export const EXTERNAL_ACTION_KINDS = [
  "send_message",
  "create_task",
  "publish_content",
  "update_asset_record",
  "place_trade",
  "call_webhook",
] as const;

export type ExternalActionKind = typeof EXTERNAL_ACTION_KINDS[number];

export function isStrategicSuggestionKind(value: unknown): value is StrategicSuggestionKind {
  return includesValue(STRATEGIC_SUGGESTION_KINDS, value);
}

export function isExternalActionKind(value: unknown): value is ExternalActionKind {
  return includesValue(EXTERNAL_ACTION_KINDS, value);
}

export function isSuggestionRiskLevel(value: unknown): value is SuggestionRiskLevel {
  return includesValue(SUGGESTION_RISK_LEVELS, value);
}

export function isSuggestionStatus(value: unknown): value is SuggestionStatus {
  return includesValue(SUGGESTION_STATUSES, value);
}

function includesValue(vocabulary: readonly string[], value: unknown): boolean {
  return typeof value === "string" && vocabulary.includes(value);
}

export interface CreateStrategicSuggestionInput {
  readonly kind: StrategicSuggestionKind;
  readonly title: string;
  readonly rationale: string;
  readonly source: MemoryGraphSource;
  readonly confidence: number;
  readonly riskLevel: SuggestionRiskLevel;
  readonly expectedValue?: string;
  readonly evidenceNodeIds?: readonly MemoryNodeId[];
  readonly proposedNode?: CreateMemoryNodeInput;
  readonly proposedEdges?: readonly CreateMemoryEdgeInput[];
  readonly id?: SuggestionId;
  readonly now?: Date;
}

export interface StrategicSuggestion {
  readonly id: SuggestionId;
  readonly type: "strategic";
  readonly kind: StrategicSuggestionKind;
  readonly title: string;
  readonly rationale: string;
  readonly source: MemoryGraphSource;
  readonly confidence: number;
  readonly status: SuggestionStatus;
  readonly riskLevel: SuggestionRiskLevel;
  readonly expectedValue?: string;
  readonly evidenceNodeIds: readonly MemoryNodeId[];
  readonly proposedNode?: CreateMemoryNodeInput;
  readonly proposedEdges: readonly CreateMemoryEdgeInput[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly acceptedAt?: Date;
  readonly rejectedAt?: Date;
  readonly archivedAt?: Date;
  readonly convertedAt?: Date;
}

export interface CreateActionSuggestionInput {
  readonly kind: ExternalActionKind;
  readonly title: string;
  readonly rationale: string;
  readonly source: MemoryGraphSource;
  readonly confidence: number;
  readonly riskLevel: SuggestionRiskLevel;
  readonly target: string;
  readonly preview: string;
  readonly id?: SuggestionId;
  readonly now?: Date;
}

export interface ActionSuggestion {
  readonly id: SuggestionId;
  readonly type: "action";
  readonly kind: ExternalActionKind;
  readonly title: string;
  readonly rationale: string;
  readonly source: MemoryGraphSource;
  readonly confidence: number;
  readonly status: SuggestionStatus;
  readonly riskLevel: SuggestionRiskLevel;
  readonly target: string;
  readonly preview: string;
  readonly requiresApproval: true;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly acceptedAt?: Date;
  readonly rejectedAt?: Date;
  readonly archivedAt?: Date;
  readonly convertedAt?: Date;
}

export type Suggestion = StrategicSuggestion | ActionSuggestion;

export function createStrategicSuggestion(input: CreateStrategicSuggestionInput): StrategicSuggestion {
  const now = input.now ?? new Date();
  return {
    id: normalizeGraphId(input.id ?? crypto.randomUUID(), "Suggestion id"),
    type: "strategic",
    kind: input.kind,
    title: normalizeGraphLabel(input.title, "Suggestion title"),
    rationale: normalizeGraphLabel(input.rationale, "Suggestion rationale"),
    source: input.source,
    confidence: validateConfidence(input.confidence),
    status: "pending",
    riskLevel: input.riskLevel,
    ...(input.expectedValue === undefined ? {} : { expectedValue: normalizeGraphLabel(input.expectedValue, "Suggestion expectedValue") }),
    evidenceNodeIds: normalizeNodeIds(input.evidenceNodeIds ?? []),
    ...(input.proposedNode === undefined ? {} : { proposedNode: input.proposedNode }),
    proposedEdges: input.proposedEdges ?? [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createActionSuggestion(input: CreateActionSuggestionInput): ActionSuggestion {
  const now = input.now ?? new Date();
  return {
    id: normalizeGraphId(input.id ?? crypto.randomUUID(), "Suggestion id"),
    type: "action",
    kind: input.kind,
    title: normalizeGraphLabel(input.title, "Suggestion title"),
    rationale: normalizeGraphLabel(input.rationale, "Suggestion rationale"),
    source: input.source,
    confidence: validateConfidence(input.confidence),
    status: "pending",
    riskLevel: input.riskLevel,
    target: normalizeGraphLabel(input.target, "Action target"),
    preview: normalizeGraphLabel(input.preview, "Action preview"),
    requiresApproval: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function acceptSuggestion(suggestion: Suggestion, now = new Date()): Suggestion {
  return transitionSuggestion(suggestion, "accepted", now, "acceptedAt");
}

export function rejectSuggestion(suggestion: Suggestion, now = new Date()): Suggestion {
  return transitionSuggestion(suggestion, "rejected", now, "rejectedAt");
}

export function archiveSuggestion(suggestion: Suggestion, now = new Date()): Suggestion {
  return transitionSuggestion(suggestion, "archived", now, "archivedAt");
}

export function convertSuggestion(suggestion: Suggestion, now = new Date()): Suggestion {
  if (suggestion.status !== "accepted") {
    throw new Error("Only accepted suggestions can be converted.");
  }
  return transitionSuggestion(suggestion, "converted", now, "convertedAt");
}

function transitionSuggestion(
  suggestion: Suggestion,
  status: SuggestionStatus,
  now: Date,
  timestampKey: "acceptedAt" | "rejectedAt" | "archivedAt" | "convertedAt",
): Suggestion {
  if (suggestion.status !== "pending" && status !== "converted") {
    throw new Error("Only pending suggestions can be accepted, rejected, or archived.");
  }
  return {
    ...suggestion,
    status,
    updatedAt: now,
    [timestampKey]: now,
  };
}

function normalizeNodeIds(ids: readonly MemoryNodeId[]): readonly MemoryNodeId[] {
  return ids.map((id) => normalizeGraphId(id, "Suggestion evidence node id"));
}

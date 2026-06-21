import { randomUUID } from "node:crypto";
import type { SourceReference } from "../tasks/task.js";

export type MemoryNodeId = string;
export type MemoryEdgeId = string;

export type MemoryGraphStatus = "active" | "superseded" | "archived" | "deleted";

export type MemoryGraphScope = "user" | "conversation" | "project" | "global";

export type MemoryNodeKind =
  | "person"
  | "project"
  | "conversation"
  | "task"
  | "decision"
  | "goal"
  | "idea"
  | "routine"
  | "area"
  | "resource"
  | "skill"
  | "asset"
  | "risk"
  | "content_plan"
  | "learning_plan"
  | "investment_thesis"
  | "concept";

export type MemoryRelation =
  | "PERSON_WORKS_ON_PROJECT"
  | "PERSON_OWNS_TASK"
  | "PROJECT_HAS_DECISION"
  | "PROJECT_HAS_DEADLINE"
  | "PROJECT_HAS_BLOCKER"
  | "TASK_BLOCKED_BY_PERSON"
  | "GOAL_HAS_PROJECT"
  | "GOAL_HAS_ROUTINE"
  | "IDEA_SUPPORTS_GOAL"
  | "IDEA_BECAME_PROJECT"
  | "ROUTINE_SUPPORTS_AREA"
  | "PREFERENCE_GUIDES_STYLE"
  | "SKILL_SUPPORTS_TASK"
  | "PARTNER_WORKS_ON_STARTUP"
  | "CLIENT_OWNS_PROJECT"
  | "CONTENT_PLAN_SUPPORTS_GOAL"
  | "LEARNING_PLAN_BUILDS_SKILL"
  | "ASSET_BELONGS_TO_PROJECT"
  | "INVESTMENT_THESIS_HAS_RISK"
  | "RISK_AFFECTS_GOAL";

export type MemoryGraphPayload = Readonly<Record<string, unknown>>;

export type MemoryPayloadKind =
  | "person"
  | "preference"
  | "style_rule"
  | "personal_rule"
  | "skill"
  | "goal"
  | "idea"
  | "opportunity"
  | "insight"
  | "routine"
  | "routine_experiment"
  | "asset"
  | "risk"
  | "content_plan"
  | "learning_plan"
  | "investment_thesis";

export type GoalStatus = "suggested" | "active" | "paused" | "completed" | "dropped";
export type IdeaStatus = "suggested" | "exploring" | "accepted" | "rejected" | "converted";
export type RoutineCadence = "daily" | "weekly" | "monthly" | "custom";
export type RiskLevel = "low" | "medium" | "high";

export interface PersonMemoryPayload extends MemoryGraphPayload {
  readonly payloadKind: "person";
  readonly role?: string;
  readonly relationship?: string;
  readonly timezone?: string;
  readonly communicationNotes?: readonly string[];
}

export interface PreferenceMemoryPayload extends MemoryGraphPayload {
  readonly payloadKind: "preference";
  readonly area: string;
  readonly preference: string;
}

export interface StyleRuleMemoryPayload extends MemoryGraphPayload {
  readonly payloadKind: "style_rule";
  readonly rule: string;
  readonly examples?: readonly string[];
}

export interface PersonalRuleMemoryPayload extends MemoryGraphPayload {
  readonly payloadKind: "personal_rule";
  readonly rule: string;
  readonly reason?: string;
}

export interface SkillMemoryPayload extends MemoryGraphPayload {
  readonly payloadKind: "skill";
  readonly level?: "learning" | "working" | "strong";
  readonly evidence?: readonly string[];
  readonly targetLevel?: string;
}

export interface GoalMemoryPayload extends MemoryGraphPayload {
  readonly payloadKind: "goal";
  readonly status: GoalStatus;
  readonly desiredOutcome: string;
  readonly horizon?: string;
  readonly successMetric?: string;
}

export interface IdeaMemoryPayload extends MemoryGraphPayload {
  readonly payloadKind: "idea";
  readonly status: IdeaStatus;
  readonly hypothesis: string;
  readonly nextStep?: string;
}

export interface OpportunityMemoryPayload extends MemoryGraphPayload {
  readonly payloadKind: "opportunity";
  readonly opportunity: string;
  readonly upside?: string;
  readonly constraints?: readonly string[];
}

export interface InsightMemoryPayload extends MemoryGraphPayload {
  readonly payloadKind: "insight";
  readonly insight: string;
  readonly implication?: string;
}

export interface RoutineMemoryPayload extends MemoryGraphPayload {
  readonly payloadKind: "routine";
  readonly cadence: RoutineCadence;
  readonly habit: string;
  readonly target?: string;
}

export interface RoutineExperimentMemoryPayload extends MemoryGraphPayload {
  readonly payloadKind: "routine_experiment";
  readonly hypothesis: string;
  readonly durationDays: number;
  readonly measurement: string;
}

export interface AssetMemoryPayload extends MemoryGraphPayload {
  readonly payloadKind: "asset";
  readonly assetType: "cash" | "crypto" | "equity" | "domain" | "content" | "other";
  readonly description: string;
}

export interface RiskMemoryPayload extends MemoryGraphPayload {
  readonly payloadKind: "risk";
  readonly level: RiskLevel;
  readonly risk: string;
  readonly mitigation?: string;
}

export interface ContentPlanMemoryPayload extends MemoryGraphPayload {
  readonly payloadKind: "content_plan";
  readonly platform: "x" | "linkedin" | "blog" | "newsletter" | "other";
  readonly audience: string;
  readonly angle: string;
}

export interface LearningPlanMemoryPayload extends MemoryGraphPayload {
  readonly payloadKind: "learning_plan";
  readonly topic: string;
  readonly currentLevel?: string;
  readonly targetOutcome: string;
}

export interface InvestmentThesisMemoryPayload extends MemoryGraphPayload {
  readonly payloadKind: "investment_thesis";
  readonly market: "crypto" | "equity" | "startup" | "other";
  readonly thesis: string;
  readonly invalidationSignal?: string;
}

export type ExpandedMemoryPayload =
  | PersonMemoryPayload
  | PreferenceMemoryPayload
  | StyleRuleMemoryPayload
  | PersonalRuleMemoryPayload
  | SkillMemoryPayload
  | GoalMemoryPayload
  | IdeaMemoryPayload
  | OpportunityMemoryPayload
  | InsightMemoryPayload
  | RoutineMemoryPayload
  | RoutineExperimentMemoryPayload
  | AssetMemoryPayload
  | RiskMemoryPayload
  | ContentPlanMemoryPayload
  | LearningPlanMemoryPayload
  | InvestmentThesisMemoryPayload;

/** Source reference for graph facts; raw chat text is intentionally excluded. */
export interface MemoryGraphSource extends SourceReference {
  readonly recordId?: string;
}

export interface CreateMemoryNodeInput {
  readonly kind: MemoryNodeKind;
  readonly label: string;
  readonly scope: MemoryGraphScope;
  readonly source: MemoryGraphSource;
  readonly confidence: number;
  readonly summary?: string;
  readonly aliases?: readonly string[];
  readonly payload?: MemoryGraphPayload;
  readonly status?: MemoryGraphStatus;
  readonly id?: MemoryNodeId;
  readonly now?: Date;
}

export interface MemoryNode {
  readonly id: MemoryNodeId;
  readonly kind: MemoryNodeKind;
  readonly label: string;
  readonly scope: MemoryGraphScope;
  readonly source: MemoryGraphSource;
  readonly confidence: number;
  readonly status: MemoryGraphStatus;
  readonly summary?: string;
  readonly aliases: readonly string[];
  readonly payload: MemoryGraphPayload;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateMemoryEdgeInput {
  readonly fromNodeId: MemoryNodeId;
  readonly toNodeId: MemoryNodeId;
  readonly relation: MemoryRelation;
  readonly fact: string;
  readonly source: MemoryGraphSource;
  readonly confidence: number;
  readonly payload?: MemoryGraphPayload;
  readonly status?: MemoryGraphStatus;
  readonly validFrom?: Date;
  readonly validUntil?: Date;
  readonly id?: MemoryEdgeId;
  readonly now?: Date;
}

export interface MemoryEdge {
  readonly id: MemoryEdgeId;
  readonly fromNodeId: MemoryNodeId;
  readonly toNodeId: MemoryNodeId;
  readonly relation: MemoryRelation;
  readonly fact: string;
  readonly source: MemoryGraphSource;
  readonly confidence: number;
  readonly status: MemoryGraphStatus;
  readonly payload: MemoryGraphPayload;
  readonly validFrom?: Date;
  readonly validUntil?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function createMemoryNode(input: CreateMemoryNodeInput): MemoryNode {
  const now = input.now ?? new Date();
  const summary = optionalText(input.summary);
  const node: MemoryNode = {
    id: normalizeGraphId(input.id ?? randomUUID(), "Memory node id"),
    kind: input.kind,
    label: normalizeGraphLabel(input.label, "Memory node label"),
    scope: input.scope,
    source: validateGraphSource(input.source),
    confidence: validateConfidence(input.confidence),
    status: input.status ?? "active",
    aliases: normalizeAliases(input.aliases ?? []),
    payload: input.payload ?? {},
    createdAt: now,
    updatedAt: now,
  };

  return {
    ...node,
    ...(summary === undefined ? {} : { summary }),
  };
}

export function createMemoryEdge(input: CreateMemoryEdgeInput): MemoryEdge {
  const now = input.now ?? new Date();
  validateTemporalRange(input.validFrom, input.validUntil);
  return {
    id: normalizeGraphId(input.id ?? randomUUID(), "Memory edge id"),
    fromNodeId: normalizeGraphId(input.fromNodeId, "Memory edge fromNodeId"),
    toNodeId: normalizeGraphId(input.toNodeId, "Memory edge toNodeId"),
    relation: input.relation,
    fact: normalizeGraphLabel(input.fact, "Memory edge fact"),
    source: validateGraphSource(input.source),
    confidence: validateConfidence(input.confidence),
    status: input.status ?? "active",
    payload: input.payload ?? {},
    ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
    ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
    createdAt: now,
    updatedAt: now,
  };
}

export function validateConfidence(confidence: number): number {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("Memory graph confidence must be between 0 and 1.");
  }
  return confidence;
}

export function normalizeGraphId(value: string, fieldName = "Memory graph id"): string {
  const id = value.trim();
  if (id.length < 3) {
    throw new Error(`${fieldName} must contain at least 3 characters.`);
  }
  if (/\s/.test(id)) {
    throw new Error(`${fieldName} must not contain whitespace.`);
  }
  return id;
}

export function normalizeGraphLabel(value: string, fieldName = "Memory graph label"): string {
  const label = value.trim().replace(/\s+/g, " ");
  if (label.length < 2) {
    throw new Error(`${fieldName} must contain at least 2 characters.`);
  }
  return label;
}

export function validateTemporalRange(validFrom: Date | undefined, validUntil: Date | undefined): void {
  if (validFrom !== undefined && Number.isNaN(validFrom.getTime())) {
    throw new Error("Memory graph validFrom must be a valid date.");
  }
  if (validUntil !== undefined && Number.isNaN(validUntil.getTime())) {
    throw new Error("Memory graph validUntil must be a valid date.");
  }
  if (validFrom !== undefined && validUntil !== undefined && validUntil.getTime() < validFrom.getTime()) {
    throw new Error("Memory graph validUntil must be after validFrom.");
  }
}

function validateGraphSource(source: MemoryGraphSource): MemoryGraphSource {
  normalizeGraphId(source.platform, "Memory graph source platform");
  normalizeGraphId(source.conversationId, "Memory graph source conversationId");
  normalizeGraphId(source.messageId, "Memory graph source messageId");
  if (Number.isNaN(source.occurredAt.getTime())) {
    throw new Error("Memory graph source occurredAt must be a valid date.");
  }
  return source;
}

function normalizeAliases(aliases: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const alias of aliases) {
    const value = optionalText(alias);
    if (value === undefined || seen.has(value.toLowerCase())) {
      continue;
    }
    seen.add(value.toLowerCase());
    normalized.push(value);
  }
  return normalized;
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, " ");
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

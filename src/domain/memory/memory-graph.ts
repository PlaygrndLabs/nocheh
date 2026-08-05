import type { SourceReference } from "../tasks/task.js";

export type MemoryNodeId = string;
export type MemoryEdgeId = string;

/**
 * The graph vocabularies exist at runtime, not only in the type system.
 *
 * Two consumers need the members as values: the analysis prompt, which must tell a
 * model exactly which kinds and relations are allowed, and the mapping layer, which
 * must reject anything outside them. Deriving the unions with `typeof X[number]`
 * keeps one source of truth, so the prompt cannot drift from the domain.
 */
export const MEMORY_GRAPH_STATUSES = ["active", "superseded", "archived", "deleted"] as const;

export type MemoryGraphStatus = typeof MEMORY_GRAPH_STATUSES[number];

export const MEMORY_GRAPH_SCOPES = ["user", "conversation", "project", "global"] as const;

export type MemoryGraphScope = typeof MEMORY_GRAPH_SCOPES[number];

export const MEMORY_NODE_KINDS = [
  "person",
  "project",
  "conversation",
  "task",
  "decision",
  "goal",
  "idea",
  "routine",
  "area",
  "resource",
  "skill",
  "asset",
  "risk",
  "content_plan",
  "learning_plan",
  "investment_thesis",
  "concept",
] as const;

export type MemoryNodeKind = typeof MEMORY_NODE_KINDS[number];

export const MEMORY_RELATIONS = [
  "PERSON_WORKS_ON_PROJECT",
  "PERSON_OWNS_TASK",
  "PROJECT_HAS_DECISION",
  "PROJECT_HAS_DEADLINE",
  "PROJECT_HAS_BLOCKER",
  "TASK_BLOCKED_BY_PERSON",
  "GOAL_HAS_PROJECT",
  "GOAL_HAS_ROUTINE",
  "IDEA_SUPPORTS_GOAL",
  "IDEA_BECAME_PROJECT",
  "ROUTINE_SUPPORTS_AREA",
  "PREFERENCE_GUIDES_STYLE",
  "SKILL_SUPPORTS_TASK",
  "PARTNER_WORKS_ON_STARTUP",
  "CLIENT_OWNS_PROJECT",
  "CONTENT_PLAN_SUPPORTS_GOAL",
  "LEARNING_PLAN_BUILDS_SKILL",
  "ASSET_BELONGS_TO_PROJECT",
  "INVESTMENT_THESIS_HAS_RISK",
  "RISK_AFFECTS_GOAL",
] as const;

export type MemoryRelation = typeof MEMORY_RELATIONS[number];

export type MemoryGraphPayload = Readonly<Record<string, unknown>>;

export const MEMORY_PAYLOAD_KINDS = [
  "person",
  "preference",
  "style_rule",
  "personal_rule",
  "skill",
  "goal",
  "idea",
  "opportunity",
  "insight",
  "routine",
  "routine_experiment",
  "asset",
  "risk",
  "content_plan",
  "learning_plan",
  "investment_thesis",
] as const;

export type MemoryPayloadKind = typeof MEMORY_PAYLOAD_KINDS[number];

export const GOAL_STATUSES = ["suggested", "active", "paused", "completed", "dropped"] as const;
export type GoalStatus = typeof GOAL_STATUSES[number];

export const IDEA_STATUSES = ["suggested", "exploring", "accepted", "rejected", "converted"] as const;
export type IdeaStatus = typeof IDEA_STATUSES[number];

export const ROUTINE_CADENCES = ["daily", "weekly", "monthly", "custom"] as const;
export type RoutineCadence = typeof ROUTINE_CADENCES[number];

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = typeof RISK_LEVELS[number];

export const SKILL_LEVELS = ["learning", "working", "strong"] as const;
export type SkillLevel = typeof SKILL_LEVELS[number];

export const ASSET_TYPES = ["cash", "crypto", "equity", "domain", "content", "other"] as const;
export type AssetType = typeof ASSET_TYPES[number];

export const CONTENT_PLATFORMS = ["x", "linkedin", "blog", "newsletter", "other"] as const;
export type ContentPlatform = typeof CONTENT_PLATFORMS[number];

export const INVESTMENT_MARKETS = ["crypto", "equity", "startup", "other"] as const;
export type InvestmentMarket = typeof INVESTMENT_MARKETS[number];

/**
 * The fields each expanded payload kind must carry, as a value the prompt can render.
 *
 * Typed as an exhaustive `Record<MemoryPayloadKind, ...>` so adding a payload kind to
 * `MEMORY_PAYLOAD_KINDS` without documenting its shape is a compile error. Enum-valued
 * fields spell out their options inline, because a model told only "status" invents one.
 */
export const MEMORY_PAYLOAD_FIELD_SPECS: Readonly<Record<MemoryPayloadKind, readonly string[]>> = {
  person: ["role?", "relationship?", "timezone?", "communicationNotes?[]"],
  preference: ["area", "preference"],
  style_rule: ["rule", "examples?[]"],
  personal_rule: ["rule", "reason?"],
  skill: [`level?(${SKILL_LEVELS.join("|")})`, "evidence?[]", "targetLevel?"],
  goal: [`status(${GOAL_STATUSES.join("|")})`, "desiredOutcome", "horizon?", "successMetric?"],
  idea: [`status(${IDEA_STATUSES.join("|")})`, "hypothesis", "nextStep?"],
  opportunity: ["opportunity", "upside?", "constraints?[]"],
  insight: ["insight", "implication?"],
  routine: [`cadence(${ROUTINE_CADENCES.join("|")})`, "habit", "target?"],
  routine_experiment: ["hypothesis", "durationDays(number)", "measurement"],
  asset: [`assetType(${ASSET_TYPES.join("|")})`, "description"],
  risk: [`level(${RISK_LEVELS.join("|")})`, "risk", "mitigation?"],
  content_plan: [`platform(${CONTENT_PLATFORMS.join("|")})`, "audience", "angle"],
  learning_plan: ["topic", "targetOutcome", "currentLevel?"],
  investment_thesis: [`market(${INVESTMENT_MARKETS.join("|")})`, "thesis", "invalidationSignal?"],
};

export function isMemoryGraphStatus(value: unknown): value is MemoryGraphStatus {
  return includesValue(MEMORY_GRAPH_STATUSES, value);
}

export function isMemoryGraphScope(value: unknown): value is MemoryGraphScope {
  return includesValue(MEMORY_GRAPH_SCOPES, value);
}

export function isMemoryNodeKind(value: unknown): value is MemoryNodeKind {
  return includesValue(MEMORY_NODE_KINDS, value);
}

export function isMemoryRelation(value: unknown): value is MemoryRelation {
  return includesValue(MEMORY_RELATIONS, value);
}

export function isMemoryPayloadKind(value: unknown): value is MemoryPayloadKind {
  return includesValue(MEMORY_PAYLOAD_KINDS, value);
}

/**
 * The payload fields a kind cannot do without, derived from the same spec the prompt
 * renders.
 *
 * Checking these locally is free, while telling a model about them costs input tokens on
 * every call forever. It also catches the one failure a validator can otherwise miss:
 * a payload is `Record<string, unknown>`, so a goal whose `status` was put on the node
 * instead of inside the payload validates cleanly and silently loses its status.
 */
export function requiredMemoryPayloadFields(kind: MemoryPayloadKind): readonly string[] {
  return MEMORY_PAYLOAD_FIELD_SPECS[kind]
    .filter((field) => !field.includes("?"))
    .map((field) => field.split("(")[0] ?? field);
}

function includesValue(vocabulary: readonly string[], value: unknown): boolean {
  return typeof value === "string" && vocabulary.includes(value);
}

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
  readonly level?: SkillLevel;
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
  readonly assetType: AssetType;
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
  readonly platform: ContentPlatform;
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
  readonly market: InvestmentMarket;
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
    id: normalizeGraphId(input.id ?? crypto.randomUUID(), "Memory node id"),
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
    id: normalizeGraphId(input.id ?? crypto.randomUUID(), "Memory edge id"),
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

/**
 * Validates a source reference.
 *
 * Source identifiers come from the platform, not from Nocheh, so they only have to be
 * present and unambiguous. The graph-id minimum length does not apply: a Telegram
 * `message_id` starts at 1 in every chat, so requiring three characters would make
 * the first hundred messages of any conversation unpersistable.
 */
function validateGraphSource(source: MemoryGraphSource): MemoryGraphSource {
  normalizeSourceIdentifier(source.platform, "Memory graph source platform");
  normalizeSourceIdentifier(source.conversationId, "Memory graph source conversationId");
  normalizeSourceIdentifier(source.messageId, "Memory graph source messageId");
  if (Number.isNaN(source.occurredAt.getTime())) {
    throw new Error("Memory graph source occurredAt must be a valid date.");
  }
  return source;
}

function normalizeSourceIdentifier(value: string, fieldName: string): string {
  const id = value.trim();
  if (id.length === 0) {
    throw new Error(`${fieldName} must not be empty.`);
  }
  if (/\s/.test(id)) {
    throw new Error(`${fieldName} must not contain whitespace.`);
  }
  return id;
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

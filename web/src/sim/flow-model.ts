import type { AuditRecord, AuditStep, BrainGraphEdge, BrainGraphNode, BrainSuggestion } from "../api/client.js";

/**
 * Lean, backend-derived view of what the analysis produced: the current
 * knowledge graph plus pending suggestions. Replaces the old keyword
 * `BrainPreview` — every field here comes from real `/api/*` responses.
 */
export interface FlowInsights {
  readonly nodes: readonly BrainGraphNode[];
  readonly edges: readonly BrainGraphEdge[];
  readonly suggestions: readonly BrainSuggestion[];
}

/** The nine human-readable stages a message passes through, in flow order. */
export type StageId =
  | "chat"
  | "receive"
  | "protect"
  | "ai_brain"
  | "memory"
  | "knowledge"
  | "ideas"
  | "tasks"
  | "audit";

/** Swimlane grouping used to lay the flow out by architectural role. */
export type Lane = "external" | "infra" | "process" | "stores" | "audit";

export type StageStatus = "succeeded" | "started" | "failed" | "skipped";

export interface FlowStage {
  readonly id: StageId;
  readonly label: string;
  readonly sublabel: string;
  readonly lane: Lane;
  /** Primary left-to-right ordering column. */
  readonly column: number;
  /** The system guarantee this stage embodies, shown in the inspector. */
  readonly property?: string;
}

export interface FlowEdge {
  readonly from: StageId;
  readonly to: StageId;
}

export interface FlowMetric {
  readonly label: string;
  readonly value: string | number;
}

/** A single animation step: one stage, its status, and everything the inspector needs. */
export interface FlowFrame {
  readonly stageId: StageId;
  readonly status: StageStatus;
  readonly durationMs: number;
  /** Short overlay label, e.g. "4 facts, 3 links". */
  readonly headline: string;
  /** One human sentence describing what happened at this stage. */
  readonly detail: string;
  readonly metrics: readonly FlowMetric[];
  readonly property?: string;
  /** Concrete examples (memory titles, suggestion titles, task names, …). */
  readonly samples: readonly string[];
}

export const LANE_LABELS: Record<Lane, string> = {
  external: "External",
  infra: "Infra",
  process: "Process",
  stores: "Stores",
  audit: "Audit",
};

/** Lanes in vertical display order (top to bottom). */
export const LANE_ORDER: readonly Lane[] = ["external", "infra", "process", "stores", "audit"];

/** The four data stores fan out from the AI brain; ordered top to bottom in the store column. */
export const STORE_STAGES: readonly StageId[] = ["memory", "knowledge", "ideas", "tasks"];

export const FLOW_STAGES: readonly FlowStage[] = [
  {
    id: "chat",
    label: "Telegram chat",
    sublabel: "A message appears in a group.",
    lane: "external",
    column: 0,
    property: "The simulator posts real messages through Nocheh's pipeline — buffered until you run analysis.",
  },
  {
    id: "receive",
    label: "Nocheh receives it",
    sublabel: "The bot accepts the message; it can batch several together.",
    lane: "infra",
    column: 1,
    property: "Immediate or batch mode — high-traffic groups are grouped into one conversation window to control cost.",
  },
  {
    id: "protect",
    label: "Protect privacy",
    sublabel: "Secrets and sensitive text are detected and redacted.",
    lane: "process",
    column: 2,
    property: "Redaction-first — raw chat is never persisted, only redacted, structured facts.",
  },
  {
    id: "ai_brain",
    label: "AI Brain",
    sublabel: "Reads the whole window; extracts memory, graph, and tasks.",
    lane: "process",
    column: 3,
    property: "One LLM pass over the conversation window (the configured provider, e.g. GLM-5.2). Dry-run with no provider returns an empty analysis.",
  },
  {
    id: "memory",
    label: "Memory",
    sublabel: "Useful facts saved as structured memory.",
    lane: "stores",
    column: 4,
    property: "Six memory types: Task, Decision, Project, Deadline, Blocker, Summary.",
  },
  {
    id: "knowledge",
    label: "Knowledge graph",
    sublabel: "People, goals, projects, routines, and links are updated.",
    lane: "stores",
    column: 4,
    property: "Entities and relationships — not flat lists — power later reasoning.",
  },
  {
    id: "ideas",
    label: "Suggestions",
    sublabel: "Ideas and advice saved for approval.",
    lane: "stores",
    column: 4,
    property: "Suggestions are PENDING human approval — never auto-executed (e.g. NO auto-trading).",
  },
  {
    id: "tasks",
    label: "Tasks",
    sublabel: "Possible tasks are extracted, checked, and saved.",
    lane: "stores",
    column: 4,
    property: "Validated for clarity and duplicates; optional Notion sync when a provider is configured.",
  },
  {
    id: "audit",
    label: "Activity log",
    sublabel: "Nocheh records timing, errors, and what changed.",
    lane: "audit",
    column: 5,
    property: "Every step is timestamped and auditable for trust and debugging.",
  },
];

export const FLOW_EDGES: readonly FlowEdge[] = [
  { from: "chat", to: "receive" },
  { from: "receive", to: "protect" },
  { from: "protect", to: "ai_brain" },
  { from: "ai_brain", to: "memory" },
  { from: "ai_brain", to: "knowledge" },
  { from: "ai_brain", to: "ideas" },
  { from: "ai_brain", to: "tasks" },
  { from: "memory", to: "audit" },
  { from: "knowledge", to: "audit" },
  { from: "ideas", to: "audit" },
  { from: "tasks", to: "audit" },
];

/** Maps a backend audit step name to the flow stage it animates. Unknown steps are ignored. */
export const STEP_TO_STAGE: Record<string, StageId> = {
  telegram_message: "receive",
  // Media is fetched and turned into text as part of receiving the message.
  media_fetch: "receive",
  media_understanding: "receive",
  secret_detection: "protect",
  redaction: "protect",
  // Recall runs before analysis and only feeds it, so it animates as part of the brain.
  context_build: "ai_brain",
  // Current backend: one combined LLM pass over the conversation window.
  analysis: "ai_brain",
  memory_persistence: "memory",
  graph_persistence: "knowledge",
  suggestion_persistence: "ideas",
  validation: "tasks",
  persistence: "tasks",
  status_update: "tasks",
  notion_sync: "tasks",
  // Legacy step names kept for backward compatibility with older audit records.
  memory_extraction: "ai_brain",
  graph_analysis: "ai_brain",
  task_extraction: "ai_brain",
};

/** Stage display order for playback (same as FLOW_STAGES order). */
export const STAGE_ORDER: readonly StageId[] = FLOW_STAGES.map((stage) => stage.id);

const STAGE_BY_ID = new Map<StageId, FlowStage>(FLOW_STAGES.map((stage) => [stage.id, stage]));

export function stageById(id: StageId): FlowStage {
  const stage = STAGE_BY_ID.get(id);
  if (stage === undefined) {
    throw new Error(`Unknown flow stage: ${id}`);
  }
  return stage;
}

/** Turns a processed window's audit record (+ real backend insights) into ordered, enriched flow frames. */
export function buildFlow(record: AuditRecord, insights: FlowInsights): readonly FlowFrame[] {
  const stepsByStage = groupSteps(record.steps);
  const labels = labelMap(insights);
  return STAGE_ORDER.map((stageId) => {
    const steps = stepsByStage.get(stageId);
    return {
      stageId,
      status: stageStatus(stageId, steps),
      durationMs: durationFor(steps),
      headline: stageHeadline(stageId, record, steps),
      detail: stageDetail(stageId, record, insights, steps),
      metrics: stageMetrics(stageId, record, insights, steps),
      property: stageById(stageId).property,
      samples: stageSamples(stageId, record, insights, labels),
    };
  });
}

/** Short summary shown in chat after the audit record arrives. */
export function botReplyText(record: AuditRecord): string {
  const accepted = record.extractedTasks.filter((task) => task.accepted);
  if (accepted.length === 0) {
    return "Suggestion: nothing actionable spotted.";
  }
  const titles = accepted.map((task) => task.title || "untitled").join(", ");
  return `Suggestion: log ${accepted.length} task${accepted.length === 1 ? "" : "s"}: ${titles}.`;
}

function groupSteps(steps: readonly AuditStep[]): Map<StageId, AuditStep[]> {
  const result = new Map<StageId, AuditStep[]>();
  for (const step of steps) {
    const stageId = STEP_TO_STAGE[step.name];
    if (stageId === undefined) {
      continue;
    }
    result.set(stageId, [...(result.get(stageId) ?? []), step]);
  }
  return result;
}

function stageStatus(stageId: StageId, steps: readonly AuditStep[] | undefined): StageStatus {
  if (stageId === "chat") {
    return "succeeded";
  }
  if (stageId === "receive" && steps === undefined) {
    return "succeeded";
  }
  if (steps === undefined || steps.length === 0) {
    return "skipped";
  }
  if (steps.some((step) => step.status === "failed")) {
    return "failed";
  }
  if (steps.every((step) => step.status === "skipped")) {
    return "skipped";
  }
  if (steps.some((step) => step.status === "started")) {
    return "started";
  }
  return "succeeded";
}

function durationFor(steps: readonly AuditStep[] | undefined): number {
  return steps?.reduce((total, step) => total + step.durationMs, 0) ?? 0;
}

function stageHeadline(stageId: StageId, record: AuditRecord, steps: readonly AuditStep[] | undefined): string {
  switch (stageId) {
    case "chat":
      return "new message";
    case "receive": {
      const count = metadataNumber(stepByName(steps, "telegram_message"), "messageCount");
      return count > 0 ? countLabel(count, "message") : "received";
    }
    case "protect":
      return record.redactionFindingCount > 0 ? `${record.redactionFindingCount} redacted` : "clean";
    case "ai_brain": {
      const brain = brainStep(steps);
      const nodes = metadataNumber(brain, "nodeCount");
      const edges = metadataNumber(brain, "edgeCount");
      return nodes + edges > 0 ? `${nodes} facts, ${edges} links` : "understood";
    }
    case "memory":
      return countLabel(metadataNumber(stepByName(steps, "memory_persistence"), "recordCount"), "memory");
    case "knowledge": {
      const graph = stepByName(steps, "graph_persistence");
      return `${metadataNumber(graph, "nodeCount")} nodes, ${metadataNumber(graph, "edgeCount")} links`;
    }
    case "ideas":
      return countLabel(metadataNumber(stepByName(steps, "suggestion_persistence"), "suggestionCount"), "idea");
    case "tasks": {
      const accepted = record.extractedTasks.filter((task) => task.accepted).length;
      return record.extractedTasks.length === 0 ? "no tasks" : `${accepted}/${record.extractedTasks.length} accepted`;
    }
    case "audit":
      return `${record.totalLatencyMs.toFixed(0)} ms`;
    default:
      return "ready";
  }
}

function stageDetail(
  stageId: StageId,
  record: AuditRecord,
  insights: FlowInsights,
  steps: readonly AuditStep[] | undefined,
): string {
  switch (stageId) {
    case "chat":
      return `A member posts a message in conversation "${record.conversationId}".`;
    case "receive": {
      const count = metadataNumber(stepByName(steps, "telegram_message"), "messageCount");
      return count > 1
        ? `Nocheh grouped ${count} buffered messages into one conversation window before analysis.`
        : "Nocheh accepts the message. Busy groups can be batched into one window before analysis to save tokens.";
    }
    case "protect":
      return record.redactionFindingCount > 0
        ? `${record.redactionFindingCount} sensitive value${record.redactionFindingCount === 1 ? "" : "s"} were redacted before anything was stored.`
        : "No secrets detected. Only redacted, structured text moves forward — raw chat is never persisted.";
    case "ai_brain": {
      const brain = brainStep(steps);
      const nodes = metadataNumber(brain, "nodeCount");
      const edges = metadataNumber(brain, "edgeCount");
      const provider = record.aiTokenUsage?.provider;
      return `The brain read the whole window and produced ${nodes} fact${nodes === 1 ? "" : "s"} and ${edges} link${edges === 1 ? "" : "s"} in one pass. ${provider === undefined ? "Dry-run (no API key) returns an empty analysis." : `Analyzed by ${provider}.`}`;
    }
    case "memory": {
      const count = metadataNumber(stepByName(steps, "memory_persistence"), "recordCount");
      return `${count} structured memory record${count === 1 ? "" : "s"} saved with source and confidence.`;
    }
    case "knowledge": {
      const edges = metadataNumber(stepByName(steps, "graph_persistence"), "edgeCount");
      return `${edges} relationship${edges === 1 ? "" : "s"} connect people, goals, projects, routines, and risks. The graph now holds ${insights.nodes.length} node${insights.nodes.length === 1 ? "" : "s"}.`;
    }
    case "ideas": {
      const count = metadataNumber(stepByName(steps, "suggestion_persistence"), "suggestionCount");
      return `${count} suggestion${count === 1 ? "" : "s"} saved this run; ${insights.suggestions.length} pending your approval overall. None act without you.`;
    }
    case "tasks": {
      const accepted = record.extractedTasks.filter((task) => task.accepted).length;
      return record.extractedTasks.length === 0
        ? "No actionable tasks were found in this window."
        : `${accepted} of ${record.extractedTasks.length} candidate task${record.extractedTasks.length === 1 ? "" : "s"} passed validation.`;
    }
    case "audit":
      return record.errorLogs.length > 0
        ? `Completed in ${record.totalLatencyMs.toFixed(0)} ms with ${record.errorLogs.length} error${record.errorLogs.length === 1 ? "" : "s"}.`
        : `All steps completed cleanly in ${record.totalLatencyMs.toFixed(0)} ms and were recorded for audit.`;
    default:
      return "";
  }
}

function stageMetrics(
  stageId: StageId,
  record: AuditRecord,
  insights: FlowInsights,
  steps: readonly AuditStep[] | undefined,
): readonly FlowMetric[] {
  switch (stageId) {
    case "protect":
      return [
        { label: "Redactions", value: record.redactionFindingCount },
        { label: "Preview", value: `${record.redactedContentPreview.length} chars` },
      ];
    case "ai_brain": {
      const brain = brainStep(steps);
      const base: FlowMetric[] = [
        { label: "Facts", value: metadataNumber(brain, "nodeCount") },
        { label: "Links", value: metadataNumber(brain, "edgeCount") },
        { label: "Provider", value: record.aiTokenUsage?.provider ?? "dry-run" },
      ];
      return record.aiTokenUsage === undefined
        ? base
        : [...base, { label: "Tokens", value: record.aiTokenUsage.totalTokens }];
    }
    case "memory":
      return [{ label: "Memories", value: metadataNumber(stepByName(steps, "memory_persistence"), "recordCount") }];
    case "knowledge":
      return [
        { label: "Nodes", value: metadataNumber(stepByName(steps, "graph_persistence"), "nodeCount") },
        { label: "Links", value: metadataNumber(stepByName(steps, "graph_persistence"), "edgeCount") },
        { label: "Graph total", value: insights.nodes.length },
      ];
    case "ideas":
      return [
        { label: "Suggestions", value: metadataNumber(stepByName(steps, "suggestion_persistence"), "suggestionCount") },
        { label: "High risk", value: insights.suggestions.filter((suggestion) => suggestion.riskLevel === "high").length },
        { label: "Pending", value: insights.suggestions.length },
      ];
    case "tasks":
      return [
        { label: "Accepted", value: record.extractedTasks.filter((task) => task.accepted).length },
        { label: "Total", value: record.extractedTasks.length },
        { label: "Notion sync", value: notionSyncValue(steps) },
      ];
    case "audit":
      return [
        { label: "Latency", value: `${record.totalLatencyMs.toFixed(0)} ms` },
        { label: "Errors", value: record.errorLogs.length },
        { label: "Steps", value: record.steps.length },
      ];
    default:
      return [];
  }
}

function stageSamples(
  stageId: StageId,
  record: AuditRecord,
  insights: FlowInsights,
  labels: ReadonlyMap<string, string>,
): readonly string[] {
  switch (stageId) {
    case "knowledge":
      return insights.edges.slice(0, 4).map((edge) =>
        `${labels.get(edge.fromNodeId) ?? edge.fromNodeId} → ${humanRelation(edge.relation)} → ${labels.get(edge.toNodeId) ?? edge.toNodeId}`);
    case "ideas":
      return insights.suggestions.slice(0, 4).map((suggestion) =>
        `${suggestion.title} — ${suggestion.riskLevel} risk`);
    case "tasks":
      return record.extractedTasks.slice(0, 4).map((task) =>
        `${task.title || "(empty)"} — ${task.confidence.toFixed(2)} ${task.accepted ? "accepted" : "rejected"}`);
    default:
      return [];
  }
}

/** The one combined analysis step, falling back to the legacy graph_analysis step name. */
function brainStep(steps: readonly AuditStep[] | undefined): AuditStep | undefined {
  return stepByName(steps, "analysis") ?? stepByName(steps, "graph_analysis");
}

function notionSyncValue(steps: readonly AuditStep[] | undefined): string {
  const notion = stepByName(steps, "notion_sync");
  if (notion === undefined) {
    return "skipped";
  }
  return notion.status === "succeeded" ? "synced" : notion.status === "failed" ? "failed" : "skipped";
}

/** Maps node ids to labels so graph edges can be rendered with readable endpoints. */
function labelMap(insights: FlowInsights): ReadonlyMap<string, string> {
  return new Map(insights.nodes.map((node) => [node.id, node.label]));
}

function stepByName(steps: readonly AuditStep[] | undefined, name: string): AuditStep | undefined {
  return steps?.find((step) => step.name === name);
}

function countLabel(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function metadataNumber(step: AuditStep | undefined, key: string): number {
  const value = step?.metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function humanRelation(relation: string): string {
  return relation.toLowerCase().replace(/_/g, " ");
}

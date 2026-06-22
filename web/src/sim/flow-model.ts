import type { AuditRecord, AuditStep } from "../api/client.js";
import type { BrainPreview } from "./brain-preview.js";

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
    property: "The simulator runs fully local — no real Telegram or backend is contacted.",
  },
  {
    id: "receive",
    label: "Nocheh receives it",
    sublabel: "The bot accepts the message; it can batch several together.",
    lane: "infra",
    column: 1,
    property: "Immediate or batch mode — high-traffic groups are grouped to control cost.",
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
    sublabel: "Extracts memory, graph, and tasks.",
    lane: "process",
    column: 3,
    property: "Rule-based now; Claude when an Anthropic key is configured.",
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
    property: "Validated for clarity and duplicates; optional Notion sync (skipped here — local-only).",
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

/** Maps a backend audit step name to the flow stage it animates. */
export const STEP_TO_STAGE: Record<string, StageId> = {
  telegram_message: "receive",
  secret_detection: "protect",
  redaction: "protect",
  memory_extraction: "ai_brain",
  memory_persistence: "memory",
  graph_analysis: "ai_brain",
  graph_persistence: "knowledge",
  suggestion_persistence: "ideas",
  task_extraction: "ai_brain",
  validation: "tasks",
  persistence: "tasks",
  notion_sync: "tasks",
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

/** Turns a processed message's audit record (+ brain preview) into ordered, enriched flow frames. */
export function buildFlow(record: AuditRecord, preview: BrainPreview): readonly FlowFrame[] {
  const stepsByStage = groupSteps(record.steps);
  return STAGE_ORDER.map((stageId) => {
    const steps = stepsByStage.get(stageId);
    return {
      stageId,
      status: stageStatus(stageId, steps),
      durationMs: durationFor(steps),
      headline: stageHeadline(stageId, record, steps),
      detail: stageDetail(stageId, record, preview, steps),
      metrics: stageMetrics(stageId, record, preview, steps),
      property: stageById(stageId).property,
      samples: stageSamples(stageId, record, preview),
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
    case "receive":
      return "local only";
    case "protect":
      return record.redactionFindingCount > 0 ? `${record.redactionFindingCount} redacted` : "clean";
    case "ai_brain": {
      const graph = stepByName(steps, "graph_analysis");
      const nodes = metadataNumber(graph, "nodeCount");
      const edges = metadataNumber(graph, "edgeCount");
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
  preview: BrainPreview,
  steps: readonly AuditStep[] | undefined,
): string {
  switch (stageId) {
    case "chat":
      return `A member posts a message in conversation "${record.conversationId}".`;
    case "receive":
      return "Nocheh accepts the message. Busy groups can be batched before analysis to save tokens.";
    case "protect":
      return record.redactionFindingCount > 0
        ? `${record.redactionFindingCount} sensitive value${record.redactionFindingCount === 1 ? "" : "s"} were redacted before anything was stored.`
        : "No secrets detected. Only redacted, structured text moves forward — raw chat is never persisted.";
    case "ai_brain": {
      const graph = stepByName(steps, "graph_analysis");
      const nodes = metadataNumber(graph, "nodeCount");
      const edges = metadataNumber(graph, "edgeCount");
      return `The brain read the message and produced ${nodes} fact${nodes === 1 ? "" : "s"} and ${edges} link${edges === 1 ? "" : "s"}. Rule-based today; Claude when configured.`;
    }
    case "memory":
      return `${preview.metrics.memories} structured memory candidate${preview.metrics.memories === 1 ? "" : "s"} would be saved with source and confidence.`;
    case "knowledge":
      return `${preview.metrics.edges} relationship${preview.metrics.edges === 1 ? "" : "s"} connect people, goals, projects, routines, and risks.`;
    case "ideas":
      return `${preview.metrics.suggestions} suggestion${preview.metrics.suggestions === 1 ? "" : "s"} are queued, all pending your approval before any action.`;
    case "tasks": {
      const accepted = record.extractedTasks.filter((task) => task.accepted).length;
      return record.extractedTasks.length === 0
        ? "No actionable tasks were found in this message."
        : `${accepted} of ${record.extractedTasks.length} candidate task${record.extractedTasks.length === 1 ? "" : "s"} passed validation. Notion sync is skipped (local-only).`;
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
  preview: BrainPreview,
  steps: readonly AuditStep[] | undefined,
): readonly FlowMetric[] {
  switch (stageId) {
    case "protect":
      return [
        { label: "Redactions", value: record.redactionFindingCount },
        { label: "Preview", value: `${record.redactedContentPreview.length} chars` },
      ];
    case "ai_brain": {
      const graph = stepByName(steps, "graph_analysis");
      return [
        { label: "Facts", value: metadataNumber(graph, "nodeCount") },
        { label: "Links", value: metadataNumber(graph, "edgeCount") },
        { label: "Provider", value: record.aiTokenUsage?.provider ?? "rule-based" },
      ];
    }
    case "memory":
      return [{ label: "Memories", value: preview.metrics.memories }];
    case "knowledge":
      return [
        { label: "Nodes", value: preview.nodes.length },
        { label: "Links", value: preview.metrics.edges },
      ];
    case "ideas":
      return [
        { label: "Suggestions", value: preview.metrics.suggestions },
        { label: "Blocked", value: preview.metrics.blocked },
      ];
    case "tasks":
      return [
        { label: "Accepted", value: record.extractedTasks.filter((task) => task.accepted).length },
        { label: "Total", value: record.extractedTasks.length },
        { label: "Notion sync", value: "skipped" },
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

function stageSamples(stageId: StageId, record: AuditRecord, preview: BrainPreview): readonly string[] {
  switch (stageId) {
    case "memory":
      return preview.memories
        .filter((memory) => memory.type !== "Preview")
        .slice(0, 4)
        .map((memory) => `${memory.title} (${memory.type})`);
    case "knowledge":
      return preview.edges.slice(0, 4).map((edge) => `${edge.from} → ${humanRelation(edge.relation)} → ${edge.to}`);
    case "ideas":
      return preview.suggestions.slice(0, 4).map((suggestion) =>
        `${suggestion.title}${suggestion.status === "blocked" ? " — approval required" : ""}`);
    case "tasks":
      return record.extractedTasks.slice(0, 4).map((task) =>
        `${task.title || "(empty)"} — ${task.confidence.toFixed(2)} ${task.accepted ? "accepted" : "rejected"}`);
    default:
      return [];
  }
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

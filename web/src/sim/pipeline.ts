import type { AuditRecord, AuditStep } from "../api/client.js";

export type NodeKind = "external" | "infra" | "process" | "store" | "sim";
export type NodeStatus = "idle" | "active" | "started" | "succeeded" | "failed" | "skipped" | "simulated";

export interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly kind: NodeKind;
  /** Layout coordinates on a 1000x520 canvas (left -> right DAG). */
  readonly x: number;
  readonly y: number;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
}

/** A single step in the animated replay: which node lit up, how, and the data it handled. */
export interface TimelineFrame {
  readonly nodeId: string;
  readonly status: Exclude<NodeStatus, "idle" | "active">;
  readonly durationMs: number;
  readonly dataLabel?: string;
  readonly simulated?: boolean;
}

/** Architecture nodes, positioned for a left-to-right system-design graph. */
export const GRAPH_NODES: readonly GraphNode[] = [
  { id: "group", label: "Group chat", kind: "external", x: 40, y: 220 },
  { id: "telegram", label: "Telegram", kind: "external", x: 180, y: 220 },
  { id: "webhook", label: "Webhook", kind: "infra", x: 320, y: 220 },
  { id: "buffer", label: "Buffer", kind: "infra", x: 320, y: 360 },
  { id: "secret", label: "Secret detect", kind: "process", x: 460, y: 120 },
  { id: "redact", label: "Redact", kind: "process", x: 460, y: 260 },
  { id: "mem_extract", label: "Memory extract", kind: "process", x: 600, y: 60 },
  { id: "mem_store", label: "Memory store", kind: "store", x: 740, y: 60 },
  { id: "task_extract", label: "Task extract", kind: "process", x: 600, y: 200 },
  { id: "validate", label: "Validate", kind: "process", x: 740, y: 200 },
  { id: "task_store", label: "Task store", kind: "store", x: 860, y: 200 },
  { id: "notion_mcp", label: "Notion MCP", kind: "process", x: 860, y: 320 },
  { id: "notion", label: "Notion", kind: "external", x: 960, y: 320 },
  { id: "audit", label: "Audit + metrics", kind: "store", x: 600, y: 360 },
  { id: "ai", label: "AI brain (simulated)", kind: "sim", x: 600, y: 460 },
  { id: "bot_reply", label: "Suggestion (simulated)", kind: "sim", x: 320, y: 460 },
] as const;

export const GRAPH_EDGES: readonly GraphEdge[] = [
  { from: "group", to: "telegram" },
  { from: "telegram", to: "webhook" },
  { from: "webhook", to: "buffer" },
  { from: "buffer", to: "secret" },
  { from: "secret", to: "redact" },
  { from: "redact", to: "mem_extract" },
  { from: "redact", to: "task_extract" },
  { from: "mem_extract", to: "mem_store" },
  { from: "task_extract", to: "validate" },
  { from: "validate", to: "task_store" },
  { from: "task_store", to: "notion_mcp" },
  { from: "notion_mcp", to: "notion" },
  { from: "task_store", to: "audit" },
  { from: "audit", to: "ai" },
  { from: "ai", to: "bot_reply" },
  { from: "bot_reply", to: "group" },
] as const;

/** Maps an audit step name to the graph node it animates. */
export const STEP_TO_NODE: Record<string, string> = {
  telegram_message: "webhook",
  secret_detection: "secret",
  redaction: "redact",
  memory_extraction: "mem_extract",
  memory_persistence: "mem_store",
  task_extraction: "task_extract",
  validation: "validate",
  persistence: "task_store",
  notion_sync: "notion_mcp",
};

/**
 * Turns a processed message's audit record into an ordered animation timeline,
 * then appends the two client-simulated stages (AI brain + suggestion) so the graph
 * reads end-to-end.
 */
export function buildTimeline(record: AuditRecord): TimelineFrame[] {
  const ordered = [...record.steps].sort(byStartOrder);
  const frames: TimelineFrame[] = ordered.map((step) => ({
    nodeId: STEP_TO_NODE[step.name] ?? step.name,
    status: step.status,
    durationMs: step.durationMs,
    ...(dataLabel(step, record) === undefined ? {} : { dataLabel: dataLabel(step, record) }),
  }));

  // Audit + metrics are always written once processing completes.
  frames.push({ nodeId: "audit", status: "succeeded", durationMs: 0, dataLabel: `${record.totalLatencyMs.toFixed(0)} ms` });

  // Simulated stages — not wired in the backend today.
  frames.push({ nodeId: "ai", status: "simulated", durationMs: 0, dataLabel: "context (simulated)", simulated: true });
  frames.push({
    nodeId: "bot_reply",
    status: "simulated",
    durationMs: 0,
    dataLabel: botReplyText(record),
    simulated: true,
  });
  return frames;
}

/** Short summary the simulated assistant suggests. */
export function botReplyText(record: AuditRecord): string {
  const accepted = record.extractedTasks.filter((task) => task.accepted);
  if (accepted.length === 0) {
    return "Suggestion: nothing actionable spotted.";
  }
  const titles = accepted.map((task) => task.title || "untitled").join(", ");
  return `Suggestion: log ${accepted.length} task${accepted.length === 1 ? "" : "s"}: ${titles}.`;
}

function byStartOrder(left: AuditStep, right: AuditStep): number {
  // Steps carry no startedAt on the wire; preserve their recorded order via the
  // canonical pipeline sequence as a stable tiebreak.
  return canonicalIndex(left.name) - canonicalIndex(right.name);
}

function canonicalIndex(name: string): number {
  const order = Object.keys(STEP_TO_NODE);
  const index = order.indexOf(name);
  return index === -1 ? order.length : index;
}

function dataLabel(step: AuditStep, record: AuditRecord): string | undefined {
  switch (step.name) {
    case "secret_detection":
    case "redaction":
      return record.redactionFindingCount > 0 ? `${record.redactionFindingCount} redacted` : undefined;
    case "task_extraction":
      return record.extractedTasks.length > 0 ? `${record.extractedTasks.length} candidate(s)` : "no tasks";
    case "validation": {
      const accepted = record.extractedTasks.filter((task) => task.accepted).length;
      return `${accepted} accepted`;
    }
    case "notion_sync": {
      const synced = record.extractedTasks.filter((task) => task.syncStatus === "succeeded").length;
      return synced > 0 ? `${synced} synced` : undefined;
    }
    default:
      return undefined;
  }
}

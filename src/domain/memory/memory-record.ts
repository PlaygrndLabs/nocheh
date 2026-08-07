import type { SourceReference, Task } from "../tasks/task.js";

/** Durable structured memory categories supported by Phase 2. */
export type MemoryRecordType = "Task" | "Decision" | "Project" | "Deadline" | "Blocker" | "Summary";

/** Backwards-compatible alias for Phase 1 consumers. */
export type MemoryRecordKind = MemoryRecordType;

/** Reference to the sanitized origin that created structured knowledge. */
export type MemorySource = SourceReference;

/** Lightweight project reference used to connect related memory records. */
export interface ProjectReference {
  readonly id: string;
  readonly name: string;
}

/** A persisted project memory item. */
export interface ProjectMemory {
  readonly name: string;
  readonly description?: string;
  readonly status?: string;
}

/** A persisted decision memory item. */
export interface DecisionMemory {
  readonly title: string;
  readonly outcome: string;
  readonly rationale?: string;
}

/** A persisted deadline memory item. */
export interface DeadlineMemory {
  readonly title: string;
  readonly dueAt?: Date;
  readonly description?: string;
}

/** A persisted blocker memory item. */
export interface BlockerMemory {
  readonly description: string;
  readonly status: "open" | "resolved";
  readonly owner?: string;
}

/** A structured summary derived from knowledge records, not raw messages. */
export interface SummaryMemory {
  readonly title: string;
  readonly summary: string;
  readonly coveredRecordIds: readonly string[];
}

/** Durable structured knowledge record. Raw chat text is intentionally excluded. */
export interface MemoryRecord {
  readonly id: string;
  readonly type: MemoryRecordType;
  readonly source: MemorySource;
  readonly timestamp: Date;
  readonly confidence: number;
  readonly project?: ProjectReference;
  readonly task?: Task;
  readonly decision?: DecisionMemory;
  readonly projectMemory?: ProjectMemory;
  readonly deadline?: DeadlineMemory;
  readonly blocker?: BlockerMemory;
  readonly summary?: SummaryMemory;
}

/** Normalizes a human project name into a stable local identifier for linking. */
export function projectIdFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `project:${slug || "unknown"}`;
}

/** Builds searchable text from structured fields only. */
export function memoryRecordText(record: MemoryRecord): string {
  // Type first, then the summary. Vectors were computed from exactly this string, so its
  // composition is storage format: changing it invalidates every stored embedding.
  return [record.type, memoryRecordSummary(record)].filter((part) => part.length > 0).join(" ");
}

/**
 * The same structured fields without the type.
 *
 * For rendering, where the type is already a label. `"- Decision: Decision API platform"`
 * pays for the word twice and reads like a bug.
 */
export function memoryRecordSummary(record: MemoryRecord): string {
  const parts = [
    record.project?.name,
    record.task?.title,
    record.task?.description,
    record.decision?.title,
    record.decision?.outcome,
    record.decision?.rationale,
    record.projectMemory?.name,
    record.projectMemory?.description,
    record.projectMemory?.status,
    record.deadline?.title,
    record.deadline?.description,
    record.deadline?.dueAt?.toISOString(),
    record.blocker?.description,
    record.blocker?.status,
    record.blocker?.owner,
    record.summary?.title,
    record.summary?.summary,
  ];

  return parts.filter((part): part is string => part !== undefined && part.trim().length > 0).join(" ");
}

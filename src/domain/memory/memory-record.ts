import type { Task } from "../tasks/task.js";

/** Persisted knowledge types supported in Phase 1. */
export type MemoryRecordKind = "task";

/** Durable structured knowledge record. Raw chat text is intentionally excluded. */
export interface MemoryRecord {
  readonly id: string;
  readonly kind: MemoryRecordKind;
  readonly projectId?: string;
  readonly task?: Task;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

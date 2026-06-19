import type { TaskValidationWarning } from "../tasks/task-validation.js";

/** Pipeline step names tracked for each processed message. */
export type ProcessingStepName =
  | "telegram_message"
  | "secret_detection"
  | "redaction"
  | "task_extraction"
  | "validation"
  | "persistence"
  | "notion_sync";

/** Execution status for a pipeline step. */
export type ProcessingStepStatus = "started" | "succeeded" | "failed" | "skipped";

/** A single execution step within the processing audit trail. */
export interface ProcessingAuditStep {
  readonly name: ProcessingStepName;
  readonly status: ProcessingStepStatus;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly durationMs: number;
  readonly metadata: Record<string, string | number | boolean | null>;
  readonly errorMessage?: string;
}

/** Extracted task metadata stored for debugging and operator visibility. */
export interface AuditedExtractedTask {
  readonly title: string;
  readonly confidence: number;
  readonly extractionReason: string;
  readonly sourceMessageId: string;
  readonly processingTimestamp: Date;
  readonly accepted: boolean;
  readonly warnings: readonly TaskValidationWarning[];
  readonly taskId?: string;
  readonly syncStatus: "not_attempted" | "succeeded" | "failed";
  readonly syncError?: string;
}

/** One audit record follows a single message through the complete pipeline. */
export interface ProcessingAuditRecord {
  readonly id: string;
  readonly platform: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly receivedAt: Date;
  readonly processedAt: Date;
  readonly redactedContentPreview: string;
  readonly redactionFindingCount: number;
  readonly steps: readonly ProcessingAuditStep[];
  readonly extractedTasks: readonly AuditedExtractedTask[];
  readonly errorLogs: readonly string[];
  readonly totalLatencyMs: number;
}

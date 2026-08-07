import type { TaskValidationWarning } from "../tasks/task-validation.js";

export interface AiTokenUsage {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /**
   * Tokens a reasoning model spent thinking before answering.
   *
   * Paid for and waited on, then discarded: the trace is never durable output. This is
   * the field that tells you whether a slow analysis is a slow endpoint or a model
   * thinking at length, so it is worth recording even though it buys nothing.
   * Absent when the provider does not report it.
   */
  readonly reasoningTokens?: number;
}

/** Pipeline step names tracked for each processed conversation window. */
export type ProcessingStepName =
  | "telegram_message"
  | "media_fetch"
  | "media_understanding"
  | "secret_detection"
  | "redaction"
  | "context_build"
  | "analysis"
  | "memory_extraction"
  | "memory_persistence"
  | "graph_analysis"
  | "graph_persistence"
  | "suggestion_persistence"
  | "task_extraction"
  | "validation"
  | "persistence"
  | "status_update"
  | "reaction_analysis"
  | "note_analysis"
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
  readonly aiTokenUsage?: AiTokenUsage;
}

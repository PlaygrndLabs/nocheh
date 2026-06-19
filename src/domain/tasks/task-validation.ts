import type { ExtractedTaskCandidate } from "./task-extraction.js";
import type { Task } from "./task.js";

/** Validation warning kinds surfaced to operators in the audit trail. */
export type TaskValidationWarningCode =
  | "duplicate_task"
  | "empty_task"
  | "low_confidence"
  | "invalid_deadline";

/** Validation warning for an extracted task candidate. */
export interface TaskValidationWarning {
  readonly code: TaskValidationWarningCode;
  readonly message: string;
  readonly candidateTitle?: string;
}

/** Result of validating a task candidate before persistence. */
export interface TaskValidationResult {
  readonly candidate: ExtractedTaskCandidate;
  readonly accepted: boolean;
  readonly warnings: readonly TaskValidationWarning[];
}

/** Domain service for Phase 1.5 task candidate correctness checks. */
export class TaskValidationService {
  public constructor(private readonly minimumConfidence = 0.65) {}

  /** Validates extracted candidates against duplicate, confidence, title, and deadline rules. */
  public validate(
    candidates: readonly ExtractedTaskCandidate[],
    existingTasks: readonly Task[],
    now: Date,
  ): TaskValidationResult[] {
    const seenTitles = new Set<string>();
    return candidates.map((candidate) => {
      const warnings: TaskValidationWarning[] = [];
      const title = candidate.title.trim();

      if (title.length === 0) {
        warnings.push({
          code: "empty_task",
          message: "Extracted task title is empty.",
        });
      }

      if (candidate.confidence < this.minimumConfidence) {
        warnings.push({
          code: "low_confidence",
          message: `Extraction confidence ${candidate.confidence.toFixed(2)} is below ${this.minimumConfidence.toFixed(2)}.`,
          candidateTitle: title,
        });
      }

      if (candidate.dueAt !== undefined && (!Number.isFinite(candidate.dueAt.getTime()) || candidate.dueAt < now)) {
        warnings.push({
          code: "invalid_deadline",
          message: "Extracted deadline is invalid or already in the past.",
          candidateTitle: title,
        });
      }

      const normalizedTitle = normalizeTaskTitle(title);
      if (normalizedTitle.length > 0 && (seenTitles.has(normalizedTitle) || this.isDuplicate(title, existingTasks))) {
        warnings.push({
          code: "duplicate_task",
          message: "An open task with the same normalized title already exists.",
          candidateTitle: title,
        });
      }
      seenTitles.add(normalizedTitle);

      return {
        candidate,
        accepted: warnings.length === 0,
        warnings,
      };
    });
  }

  private isDuplicate(title: string, existingTasks: readonly Task[]): boolean {
    const normalized = normalizeTaskTitle(title);
    if (normalized.length === 0) {
      return false;
    }
    return existingTasks.some((task) => normalizeTaskTitle(task.title) === normalized);
  }
}

/** Normalizes titles for conservative duplicate detection. */
export function normalizeTaskTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

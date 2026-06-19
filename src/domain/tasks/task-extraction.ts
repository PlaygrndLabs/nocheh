import type { CreateTaskInput } from "./task.js";

/** Candidate task produced by extraction before domain validation. */
export interface ExtractedTaskCandidate extends Omit<CreateTaskInput, "source"> {
  readonly confidence: number;
}

/** Domain service that filters extraction output before task creation. */
export class TaskCandidatePolicy {
  public constructor(private readonly minimumConfidence = 0.65) {}

  /** Returns only candidates that are actionable enough to create tasks. */
  public actionable(candidates: readonly ExtractedTaskCandidate[]): ExtractedTaskCandidate[] {
    return candidates.filter((candidate) => {
      const title = candidate.title.trim();
      return candidate.confidence >= this.minimumConfidence && title.length >= 3;
    });
  }
}

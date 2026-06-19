import type { IncomingMessage } from "../dto/incoming-message.js";
import type {
  BlockerMemory,
  DeadlineMemory,
  DecisionMemory,
  ProjectMemory,
  ProjectReference,
  SummaryMemory,
} from "../../domain/memory/memory-record.js";

export type ExtractedMemoryCandidate =
  | ExtractedProjectCandidate
  | ExtractedDecisionCandidate
  | ExtractedDeadlineCandidate
  | ExtractedBlockerCandidate
  | ExtractedSummaryCandidate;

interface ExtractedMemoryCandidateBase {
  readonly confidence: number;
  readonly extractionReason: string;
  readonly project?: ProjectReference;
}

export interface ExtractedProjectCandidate extends ExtractedMemoryCandidateBase {
  readonly type: "Project";
  readonly project: ProjectReference;
  readonly projectMemory: ProjectMemory;
}

export interface ExtractedDecisionCandidate extends ExtractedMemoryCandidateBase {
  readonly type: "Decision";
  readonly decision: DecisionMemory;
}

export interface ExtractedDeadlineCandidate extends ExtractedMemoryCandidateBase {
  readonly type: "Deadline";
  readonly deadline: DeadlineMemory;
}

export interface ExtractedBlockerCandidate extends ExtractedMemoryCandidateBase {
  readonly type: "Blocker";
  readonly blocker: BlockerMemory;
}

export interface ExtractedSummaryCandidate extends ExtractedMemoryCandidateBase {
  readonly type: "Summary";
  readonly summary: SummaryMemory;
}

/** Extracts structured memory candidates from already-redacted messages. */
export interface MemoryExtractorPort {
  extractMemory(message: IncomingMessage): Promise<readonly ExtractedMemoryCandidate[]>;
}

/** Default extractor for deployments that only want task extraction enabled. */
export class NoopMemoryExtractor implements MemoryExtractorPort {
  public async extractMemory(): Promise<readonly ExtractedMemoryCandidate[]> {
    return [];
  }
}

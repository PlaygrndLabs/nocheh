import type { ConversationWindow } from "../dto/conversation-window.js";
import type {
  MemoryEdge,
  MemoryNode,
} from "../../domain/memory/memory-graph.js";
import type { AiTokenUsage } from "../../domain/observability/audit.js";
import type { Suggestion } from "../../domain/memory/strategic-suggestion.js";
import type { ExtractedMemoryCandidate } from "./memory-extractor.js";
import type { ExtractedTaskCandidate } from "../../domain/tasks/task-extraction.js";
import type { TaskStatus } from "../../domain/tasks/task.js";

/** A task the brain proposes, tied back to the message that implied it. */
export interface AnalyzedTaskCandidate extends ExtractedTaskCandidate {
  readonly sourceMessageId: string;
}

/**
 * A status change the brain infers for knowledge that already exists, keyed by the
 * source message it came from. Used to close tasks from reactions or notes without
 * hardcoding "check == done" — the model decides based on context.
 */
export interface AnalyzedStatusUpdate {
  /** The source message id whose derived task/node should change status. */
  readonly targetMessageId: string;
  readonly status: TaskStatus;
  readonly reason: string;
  readonly confidence: number;
}

/** A memory candidate produced by the brain, tied back to its source message. */
export interface AnalyzedMemoryCandidate {
  readonly sourceMessageId: string;
  readonly candidate: ExtractedMemoryCandidate;
}

export interface MemoryGraphAnalysis {
  readonly memories: readonly AnalyzedMemoryCandidate[];
  readonly nodes: readonly MemoryNode[];
  readonly edges: readonly MemoryEdge[];
  readonly suggestions: readonly Suggestion[];
  readonly tasks: readonly AnalyzedTaskCandidate[];
  readonly statusUpdates: readonly AnalyzedStatusUpdate[];
  readonly warnings: readonly string[];
  readonly tokenUsage?: AiTokenUsage;
}

/** A prior task/node that a reaction or note might update, given to the model as a candidate target. */
export interface AnalysisCandidateTarget {
  readonly sourceMessageId: string;
  readonly kind: "task" | "node";
  readonly id: string;
  readonly label: string;
  readonly status: string;
}

/** Everything the brain needs for one analysis pass over a conversation window. */
export interface ConversationAnalysisInput {
  readonly window: ConversationWindow;
  /** Rendered structured-memory context for grounding (retrieved memory, rules, graph neighborhood). */
  readonly contextText?: string;
  /** Existing tasks/nodes the window's messages produced, so reactions/notes can update them. */
  readonly candidateTargets?: readonly AnalysisCandidateTarget[];
}

export interface MemoryGraphAnalyzerPort {
  analyze(input: ConversationAnalysisInput): Promise<MemoryGraphAnalysis>;
}

/** Default analyzer used when no AI provider is configured (dry-run: produces nothing). */
export class NoopMemoryGraphAnalyzer implements MemoryGraphAnalyzerPort {
  public async analyze(): Promise<MemoryGraphAnalysis> {
    return {
      memories: [],
      nodes: [],
      edges: [],
      suggestions: [],
      tasks: [],
      statusUpdates: [],
      warnings: [],
    };
  }
}

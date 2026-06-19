import type { ExtractedMemoryCandidate } from "./memory-extractor.js";
import type { ExtractedTaskCandidate } from "../../domain/tasks/task-extraction.js";
import type { AssistantContext } from "../services/assistant-context-builder.js";

export interface AssistantAiAnalysis {
  readonly tasks: readonly ExtractedTaskCandidate[];
  readonly memories: readonly ExtractedMemoryCandidate[];
  readonly replyText?: string;
  readonly confidence: number;
  readonly tokenUsage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

export interface AssistantAiPort {
  analyze(context: AssistantContext): Promise<AssistantAiAnalysis>;
}

export class NoopAssistantAi implements AssistantAiPort {
  public async analyze(): Promise<AssistantAiAnalysis> {
    return {
      tasks: [],
      memories: [],
      confidence: 0,
    };
  }
}

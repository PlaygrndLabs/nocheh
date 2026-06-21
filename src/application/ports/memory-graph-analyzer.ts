import type { IncomingMessage } from "../dto/incoming-message.js";
import type {
  MemoryEdge,
  MemoryNode,
} from "../../domain/memory/memory-graph.js";
import type { AiTokenUsage } from "../../domain/observability/audit.js";
import type { Suggestion } from "../../domain/memory/strategic-suggestion.js";

export interface MemoryGraphAnalysis {
  readonly nodes: readonly MemoryNode[];
  readonly edges: readonly MemoryEdge[];
  readonly suggestions: readonly Suggestion[];
  readonly warnings: readonly string[];
  readonly tokenUsage?: AiTokenUsage;
}

export interface MemoryGraphAnalyzerPort {
  analyze(message: IncomingMessage): Promise<MemoryGraphAnalysis>;
}


export class NoopMemoryGraphAnalyzer implements MemoryGraphAnalyzerPort {
  public async analyze(): Promise<MemoryGraphAnalysis> {
    return {
      nodes: [],
      edges: [],
      suggestions: [],
      warnings: [],
    };
  }
}

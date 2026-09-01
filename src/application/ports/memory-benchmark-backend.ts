import type {
  MemoryBenchmarkManifest,
  MemoryBenchmarkMessage,
  MemoryBenchmarkPreparation,
  MemoryBenchmarkQuestion,
  MemoryBenchmarkRecall,
} from "../../domain/evaluation/memory-benchmark.js";

/** Common Phase 0 seam. Provider SDK types must remain behind its implementation. */
export interface MemoryBenchmarkBackendPort {
  readonly id: string;
  readonly version: string;
  prepare(
    messages: readonly MemoryBenchmarkMessage[],
    manifest: MemoryBenchmarkManifest,
  ): Promise<MemoryBenchmarkPreparation>;
  recall(
    question: MemoryBenchmarkQuestion,
    contextTokenBudget: number,
  ): Promise<MemoryBenchmarkRecall>;
}

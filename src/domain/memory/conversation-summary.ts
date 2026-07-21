import type { MemoryRecord, MemorySource, ProjectReference, SummaryMemory } from "./memory-record.js";
import { memoryRecordText } from "./memory-record.js";

export interface CreateConversationSummaryInput {
  readonly records: readonly MemoryRecord[];
  readonly source: MemorySource;
  readonly timestamp: Date;
  readonly project?: ProjectReference;
}

/** Creates periodic summaries from structured memory records, never raw messages. */
export class ConversationSummaryService {
  public createSummary(input: CreateConversationSummaryInput): MemoryRecord | undefined {
    const records = input.records.filter((record) => record.type !== "Summary");
    if (records.length === 0) {
      return undefined;
    }

    const summary = this.buildSummary(records);
    return {
      id: crypto.randomUUID(),
      type: "Summary",
      source: input.source,
      timestamp: input.timestamp,
      confidence: Math.min(0.9, average(records.map((record) => record.confidence))),
      ...(input.project === undefined ? {} : { project: input.project }),
      summary,
    };
  }

  private buildSummary(records: readonly MemoryRecord[]): SummaryMemory {
    const lines = records.slice(0, 8).map((record) => {
      const text = memoryRecordText(record).replace(/\s+/g, " ").trim();
      return `${record.type}: ${text.length <= 120 ? text : `${text.slice(0, 119).trim()}...`}`;
    });

    return {
      title: "Structured conversation summary",
      summary: lines.join(" | "),
      coveredRecordIds: records.map((record) => record.id),
    };
  }
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

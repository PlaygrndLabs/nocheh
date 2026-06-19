import type { MemoryRecord, MemoryRecordType } from "../../domain/memory/memory-record.js";

export interface MemoryQuery {
  readonly text: string;
  readonly type?: MemoryRecordType;
  readonly projectId?: string;
  readonly limit?: number;
  readonly minimumScore?: number;
}

export interface MemorySearchResult {
  readonly record: MemoryRecord;
  readonly score: number;
}

/** Retrieves structured memory by semantic similarity over sanitized knowledge. */
export interface MemoryRetrievalPort {
  query(query: MemoryQuery): Promise<readonly MemorySearchResult[]>;
}

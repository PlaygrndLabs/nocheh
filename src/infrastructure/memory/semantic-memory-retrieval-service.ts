import type { MemoryRecordRepositoryPort } from "../../application/ports/memory-record-repository.js";
import type { MemoryQuery, MemoryRetrievalPort, MemorySearchResult } from "../../application/ports/memory-retrieval.js";
import { memoryRecordText } from "../../domain/memory/memory-record.js";
import { lexicalScore } from "./lexical-score.js";

/** Local deterministic semantic-ish retrieval over structured memory text. */
export class SemanticMemoryRetrievalService implements MemoryRetrievalPort {
  public constructor(private readonly repository: MemoryRecordRepositoryPort) {}

  /** Ranks records by token overlap against structured fields only. */
  public async query(query: MemoryQuery): Promise<readonly MemorySearchResult[]> {
    const limit = query.limit ?? 10;
    const minimumScore = query.minimumScore ?? 0.05;
    const records = await this.repository.findAll();

    return records
      .filter((record) => query.type === undefined || record.type === query.type)
      .filter((record) => query.projectId === undefined || record.project?.id === query.projectId)
      .map((record) => ({
        record,
        score: lexicalScore(query.text, memoryRecordText(record)) * record.confidence,
      }))
      .filter((result) => result.score >= minimumScore)
      .sort((left, right) => right.score - left.score || right.record.timestamp.getTime() - left.record.timestamp.getTime())
      .slice(0, limit);
  }
}

import type { MemoryRecordRepositoryPort } from "../../application/ports/memory-record-repository.js";
import type { MemoryQuery, MemoryRetrievalPort, MemorySearchResult } from "../../application/ports/memory-retrieval.js";
import { memoryRecordText } from "../../domain/memory/memory-record.js";

/** Local deterministic semantic-ish retrieval over structured memory text. */
export class SemanticMemoryRetrievalService implements MemoryRetrievalPort {
  public constructor(private readonly repository: MemoryRecordRepositoryPort) {}

  /** Ranks records by token overlap against structured fields only. */
  public async query(query: MemoryQuery): Promise<readonly MemorySearchResult[]> {
    const limit = query.limit ?? 10;
    const minimumScore = query.minimumScore ?? 0.05;
    const queryTokens = tokenize(query.text);
    const records = await this.repository.findAll();

    return records
      .filter((record) => query.type === undefined || record.type === query.type)
      .filter((record) => query.projectId === undefined || record.project?.id === query.projectId)
      .map((record) => ({
        record,
        score: score(queryTokens, tokenize(memoryRecordText(record))) * record.confidence,
      }))
      .filter((result) => result.score >= minimumScore)
      .sort((left, right) => right.score - left.score || right.record.timestamp.getTime() - left.record.timestamp.getTime())
      .slice(0, limit);
  }
}

function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function score(queryTokens: readonly string[], documentTokens: readonly string[]): number {
  if (queryTokens.length === 0 || documentTokens.length === 0) {
    return 0;
  }

  const document = new Set(documentTokens);
  const matches = queryTokens.filter((token) => document.has(token)).length;
  const recall = matches / queryTokens.length;
  const precision = matches / document.size;
  return recall === 0 || precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "we",
  "with",
]);

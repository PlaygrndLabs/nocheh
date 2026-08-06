import type { EmbeddingPort } from "../../application/ports/embedding.js";
import type { LoggerPort } from "../../application/ports/logger.js";
import { NoopLogger } from "../../application/ports/logger.js";
import type { MemoryEmbeddingRepositoryPort } from "../../application/ports/memory-embedding-repository.js";
import type { MemoryRecordRepositoryPort } from "../../application/ports/memory-record-repository.js";
import type { MemoryQuery, MemoryRetrievalPort, MemorySearchResult } from "../../application/ports/memory-retrieval.js";
import type { MemoryRecord } from "../../domain/memory/memory-record.js";
import { memoryRecordText } from "../../domain/memory/memory-record.js";
import { lexicalScore } from "./lexical-score.js";
import { dotProduct, normalizeVector } from "../../shared/vector.js";

/**
 * Cosine similarity below which two texts are treated as unrelated.
 *
 * Cosine has a high floor: with a modern retrieval model two arbitrary sentences still
 * score around 0.2-0.4, so a raw similarity is not comparable to a word-overlap score and
 * an absolute threshold tuned for one is meaningless for the other. Scores are rescaled
 * from this floor so that 0 means "no better than unrelated" and existing thresholds
 * (`minimumScore` of 0.03-0.05) keep working.
 *
 * Model dependent, and unverified against a live model. Tune it once real similarity
 * distributions are known.
 */
export const DEFAULT_SIMILARITY_FLOOR = 0.3;

/**
 * How much word overlap can add on top of similarity.
 *
 * Deliberately a bonus, not a peer: exact tokens are what embeddings blur, so a matching
 * project slug or person name should promote a record without being able to outrank a
 * genuine semantic match on its own.
 */
export const DEFAULT_LEXICAL_WEIGHT = 0.25;

export interface HybridMemoryRetrievalOptions {
  readonly similarityFloor?: number;
  readonly lexicalWeight?: number;
}

/**
 * Associative recall over structured memory: vectors first, word overlap as a bonus.
 *
 * The point of the vector half is to surface the thing the owner forgot, which by
 * definition shares no words with what they just wrote — something word overlap cannot do
 * even in principle.
 *
 * Degrades rather than fails. With no embedding provider, or when an embedding call
 * errors, this scores lexically only, matching the rule that every model role degrades
 * independently (ADR-0010).
 */
export class HybridMemoryRetrievalService implements MemoryRetrievalPort {
  private readonly similarityFloor: number;
  private readonly lexicalWeight: number;
  /**
   * Decrypted vectors, loaded once.
   *
   * Every vector is an AES-GCM payload, so without this each query would decrypt the
   * whole corpus. Invalidated on write by `invalidate()`.
   */
  private cache: Map<string, readonly number[]> | undefined;
  private cachedModel: string | undefined;

  public constructor(
    private readonly records: MemoryRecordRepositoryPort,
    private readonly embeddings: MemoryEmbeddingRepositoryPort,
    private readonly embedder: EmbeddingPort | undefined,
    private readonly logger: LoggerPort = new NoopLogger(),
    options: HybridMemoryRetrievalOptions = {},
  ) {
    this.similarityFloor = options.similarityFloor ?? DEFAULT_SIMILARITY_FLOOR;
    this.lexicalWeight = options.lexicalWeight ?? DEFAULT_LEXICAL_WEIGHT;
  }

  /** Drops the vector cache. Call after storing new embeddings. */
  public invalidate(): void {
    this.cache = undefined;
    this.cachedModel = undefined;
  }

  public async query(query: MemoryQuery): Promise<readonly MemorySearchResult[]> {
    const limit = query.limit ?? 10;
    const minimumScore = query.minimumScore ?? 0.05;
    const candidates = (await this.records.findAll())
      .filter((record) => query.type === undefined || record.type === query.type)
      .filter((record) => query.projectId === undefined || record.project?.id === query.projectId);
    if (candidates.length === 0) {
      return [];
    }

    const queryVector = await this.embedQuery(query.text);
    const vectors = queryVector === undefined ? undefined : await this.vectors();

    return candidates
      .map((record) => ({
        record,
        score: this.scoreFor(record, query.text, queryVector, vectors) * record.confidence,
      }))
      .filter((result) => result.score >= minimumScore)
      .sort((left, right) => right.score - left.score
        || right.record.timestamp.getTime() - left.record.timestamp.getTime())
      .slice(0, limit);
  }

  /**
   * Blends the two signals as a weighted average.
   *
   * A weighted average rather than a sum with a ceiling: clamping loses ordering exactly
   * where it matters, because two records that both reach the top of the range become
   * indistinguishable and the tie falls through to timestamp. Dividing by the total weight
   * keeps the result in 0..1 while preserving every difference.
   *
   * Three cases, deliberately different:
   *  - no embedder at all: the score is pure word overlap, identical to the lexical
   *    service, so thresholds tuned before embeddings existed still behave the same.
   *  - a record with a vector: the blend.
   *  - a record with no vector yet: the same blend with similarity 0. It still competes,
   *    but it cannot outrank a genuine semantic match on word overlap alone — an
   *    un-embedded record carries strictly less information, and pretending otherwise
   *    would let a backfill backlog dominate recall. Running the backfill fixes it.
   */
  private scoreFor(
    record: MemoryRecord,
    queryText: string,
    queryVector: readonly number[] | undefined,
    vectors: Map<string, readonly number[]> | undefined,
  ): number {
    const lexical = lexicalScore(queryText, memoryRecordText(record));
    if (queryVector === undefined) {
      return lexical;
    }

    const vector = vectors?.get(record.id);
    const similarity = vector === undefined ? 0 : this.rescale(dotProduct(queryVector, vector));
    return (similarity + this.lexicalWeight * lexical) / (1 + this.lexicalWeight);
  }

  /** Maps a raw cosine onto 0..1 where 0 is "no better than unrelated". */
  private rescale(similarity: number): number {
    if (similarity <= this.similarityFloor) {
      return 0;
    }
    return (similarity - this.similarityFloor) / (1 - this.similarityFloor);
  }

  private async embedQuery(text: string): Promise<readonly number[] | undefined> {
    if (this.embedder === undefined || text.trim().length === 0) {
      return undefined;
    }
    try {
      const result = await this.embedder.embed({ texts: [text], kind: "query" });
      const vector = result.vectors[0];
      return vector === undefined ? undefined : normalizeVector(vector);
    } catch (error) {
      // Recall quality is worth degrading; a failed retrieval is not worth losing the
      // window over, so this falls back to word overlap and says so.
      this.logger.warn("Embedding the query failed; falling back to word overlap.", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async vectors(): Promise<Map<string, readonly number[]>> {
    if (this.cache !== undefined) {
      return this.cache;
    }
    const stored = await this.embeddings.findAll();
    const cache = new Map<string, readonly number[]>();
    for (const embedding of stored) {
      // Vectors from different models share no space. Rather than silently comparing
      // them, keep the first model seen and report the rest as needing a reindex.
      this.cachedModel ??= embedding.model;
      if (embedding.model !== this.cachedModel) {
        continue;
      }
      cache.set(embedding.recordId, embedding.vector);
    }
    if (stored.length !== cache.size) {
      this.logger.warn("Some memory embeddings come from a different model and were ignored.", {
        stored: stored.length,
        usable: cache.size,
        model: this.cachedModel ?? "unknown",
      });
    }
    this.cache = cache;
    return cache;
  }
}

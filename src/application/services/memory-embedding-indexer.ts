import type { EmbeddingPort } from "../ports/embedding.js";
import type { LoggerPort } from "../ports/logger.js";
import type { MemoryEmbeddingRepositoryPort } from "../ports/memory-embedding-repository.js";
import type { MemoryRecordRepositoryPort } from "../ports/memory-record-repository.js";
import type { MemoryRecord, MemoryRecordType } from "../../domain/memory/memory-record.js";
import { memoryRecordText } from "../../domain/memory/memory-record.js";
import { normalizeVector } from "../../shared/vector.js";

/** Texts embedded per request during a backfill. One call per record would be wasteful. */
export const DEFAULT_BACKFILL_BATCH_SIZE = 32;

export interface MemoryEmbeddingBackfillResult {
  readonly alreadyIndexed: number;
  readonly indexed: number;
  readonly failed: number;
}

/**
 * Keeps memory vectors in step with memory records.
 *
 * A decorator rather than another constructor argument on the use case: indexing is a
 * consequence of saving a record, and the use case already takes fourteen positional
 * dependencies. Wrapping the repository means the pipeline needs no knowledge of
 * embeddings at all, and removing the embedding role removes this wrapper.
 */
export class EmbeddingIndexingMemoryRecordRepository implements MemoryRecordRepositoryPort {
  public constructor(
    private readonly inner: MemoryRecordRepositoryPort,
    private readonly embeddings: MemoryEmbeddingRepositoryPort,
    private readonly embedder: EmbeddingPort,
    private readonly logger: LoggerPort,
    /** Called after a successful write so a cached vector set can be dropped. */
    private readonly onIndexed: () => void = () => {},
  ) {}

  /**
   * Saves the record, then indexes it.
   *
   * Indexing failure is logged and swallowed. An embedding is an enhancement to recall;
   * losing the memory record itself because a vector call timed out would trade
   * something durable for something rebuildable, and `backfill` can always catch up.
   */
  public async save(record: MemoryRecord): Promise<void> {
    await this.inner.save(record);
    try {
      await this.index([record]);
      this.onIndexed();
    } catch (error) {
      this.logger.warn("Memory record saved without an embedding; run a reindex to catch up.", {
        recordId: record.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public async findAll(): Promise<readonly MemoryRecord[]> {
    return this.inner.findAll();
  }

  public async findByType(type: MemoryRecordType): Promise<readonly MemoryRecord[]> {
    return this.inner.findByType(type);
  }

  public async findByProjectId(projectId: string): Promise<readonly MemoryRecord[]> {
    return this.inner.findByProjectId(projectId);
  }

  /**
   * Embeds every record that has no vector yet.
   *
   * Needed whenever the embedding role is switched on after records already exist, or
   * after a write-time failure. Safe to run repeatedly: already-indexed records are
   * skipped, so it costs nothing when there is nothing to do.
   */
  public async backfill(batchSize = DEFAULT_BACKFILL_BATCH_SIZE): Promise<MemoryEmbeddingBackfillResult> {
    const indexed = new Set(await this.embeddings.indexedRecordIds());
    const pending = (await this.inner.findAll()).filter((record) => !indexed.has(record.id));
    let succeeded = 0;
    let failed = 0;

    for (let start = 0; start < pending.length; start += batchSize) {
      const batch = pending.slice(start, start + batchSize);
      try {
        await this.index(batch);
        succeeded += batch.length;
      } catch (error) {
        // One bad batch must not abandon the rest: a backfill that stops halfway leaves
        // recall silently partial.
        failed += batch.length;
        this.logger.warn("A memory embedding batch failed during backfill.", {
          batchSize: batch.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (succeeded > 0) {
      this.onIndexed();
    }
    return { alreadyIndexed: indexed.size, indexed: succeeded, failed };
  }

  /** Records with no text produce no vector: an empty string embeds to noise. */
  private async index(records: readonly MemoryRecord[]): Promise<void> {
    const embeddable = records
      .map((record) => ({ record, text: memoryRecordText(record).trim() }))
      .filter((entry) => entry.text.length > 0);
    if (embeddable.length === 0) {
      return;
    }

    const result = await this.embedder.embed({
      texts: embeddable.map((entry) => entry.text),
      kind: "document",
    });
    if (result.vectors.length !== embeddable.length) {
      throw new Error(`Embedding returned ${result.vectors.length} vectors for ${embeddable.length} records.`);
    }

    for (let index = 0; index < embeddable.length; index += 1) {
      const entry = embeddable[index];
      const vector = result.vectors[index];
      if (entry === undefined || vector === undefined) {
        continue;
      }
      await this.embeddings.save({
        recordId: entry.record.id,
        model: result.model,
        // Normalised on the way in so every query is a dot product, never a division.
        vector: normalizeVector(vector),
      });
    }
  }
}

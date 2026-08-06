/**
 * A stored vector for one memory record.
 *
 * Vectors are unit length, so cosine similarity is a plain dot product. Normalising once
 * at write time keeps every query cheap.
 */
export interface MemoryEmbedding {
  readonly recordId: string;
  /** Model that produced the vector. Vectors from different models are not comparable. */
  readonly model: string;
  readonly vector: readonly number[];
}

/**
 * Storage for memory embeddings.
 *
 * Deliberately not a vector index. Every searchable field of a memory record lives inside
 * an AES-GCM payload with a random IV, so SQLite cannot compare or index the contents;
 * an encrypted vector is equally opaque to an extension like sqlite-vec. Retrieval
 * therefore loads and scores in process, which at one owner's corpus size is a
 * microsecond-scale dot product and needs no native dependency.
 */
export interface MemoryEmbeddingRepositoryPort {
  save(embedding: MemoryEmbedding): Promise<void>;
  /** Every stored vector. Callers are expected to cache rather than reload per query. */
  findAll(): Promise<readonly MemoryEmbedding[]>;
  /** Record ids that already have a vector, for deciding what a backfill still owes. */
  indexedRecordIds(): Promise<readonly string[]>;
}

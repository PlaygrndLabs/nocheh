import type { EmbeddingIndexingMemoryRecordRepository } from "../../../application/services/memory-embedding-indexer.js";
import type { JsonHandler } from "../router.js";

/**
 * Memory index maintenance.
 *
 * Backfilling is a paid model call per record, so it is never automatic on boot. Switching
 * the embedding role on for a corpus that already exists, or recovering from a write-time
 * failure, is an explicit action.
 */
export function createMemoryRoutes(
  indexer: EmbeddingIndexingMemoryRecordRepository | undefined,
): { readonly reindex: JsonHandler; readonly status: JsonHandler } {
  return {
    status: async () => {
      if (indexer === undefined) {
        return {
          status: 200,
          body: {
            ok: true,
            embeddingConfigured: false,
            detail: "No embedding model is configured. Recall uses word overlap only.",
          },
        };
      }
      return { status: 200, body: { ok: true, embeddingConfigured: true } };
    },

    reindex: async () => {
      if (indexer === undefined) {
        return {
          status: 409,
          body: { ok: false, error: "No embedding model is configured. Set AI_EMBEDDING_PROVIDER first." },
        };
      }
      const result = await indexer.backfill();
      return { status: 200, body: { ok: true, ...result } };
    },
  };
}

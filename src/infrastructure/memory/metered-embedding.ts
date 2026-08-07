import type { EmbeddingPort, EmbeddingRequest, EmbeddingResult } from "../../application/ports/embedding.js";
import type { MetricsCollectorPort } from "../../application/ports/metrics.js";

/**
 * Counts what embedding calls cost.
 *
 * A decorator rather than a metrics argument on every caller, because the read path and
 * the write path embed for different reasons and would otherwise each need the same three
 * lines. Wrapping the port once means recall, write-through indexing and backfill are all
 * counted by construction, and a caller added later cannot forget.
 *
 * Recall runs on every analysed window, so this is the difference between an embedding
 * bill that shows up in `/api/metrics` and one that shows up on an invoice.
 */
export class MeteredEmbedding implements EmbeddingPort {
  public constructor(
    private readonly inner: EmbeddingPort,
    private readonly metrics: MetricsCollectorPort,
  ) {}

  public async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const result = await this.inner.embed(request);
    if (result.tokenUsage !== undefined) {
      this.metrics.recordAiTokenUsage(result.tokenUsage);
    }
    return result;
  }
}

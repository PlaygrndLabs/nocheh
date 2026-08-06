import type {
  EmbeddingPort,
  EmbeddingRequest,
  EmbeddingResult,
} from "../../application/ports/embedding.js";
import { DEFAULT_MODEL_REQUEST_TIMEOUT_MS, fetchWithTimeout } from "../http/fetch-with-timeout.js";

type FetchLike = typeof fetch;

export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiEmbeddingConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

interface GeminiBatchEmbedResponse {
  readonly embeddings?: readonly { readonly values?: readonly number[] }[];
}

/**
 * Gemini embeddings via `batchEmbedContents`.
 *
 * Gemini expresses the query/document asymmetry as `taskType`:
 * RETRIEVAL_QUERY for the question, RETRIEVAL_DOCUMENT for stored text. Mixing them
 * degrades recall quietly, which is why the port carries the distinction.
 */
export class GeminiEmbedding implements EmbeddingPort {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  public constructor(
    private readonly config: GeminiEmbeddingConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.baseUrl = config.baseUrl ?? GEMINI_DEFAULT_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
  }

  public async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (request.texts.length === 0) {
      return { model: this.config.model, vectors: [] };
    }

    const taskType = request.kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
    const url = `${this.baseUrl}/models/${this.config.model}:batchEmbedContents`;
    const response = await fetchWithTimeout(this.fetchImpl, url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this.config.apiKey,
      },
      body: JSON.stringify({
        requests: request.texts.map((text) => ({
          model: `models/${this.config.model}`,
          content: { parts: [{ text }] },
          taskType,
        })),
      }),
    }, { timeoutMs: this.timeoutMs, label: "Gemini embedding" });

    if (!response.ok) {
      throw new Error(`Gemini embedding failed with status ${response.status}: ${await response.text()}`);
    }

    const parsed = (await response.json()) as GeminiBatchEmbedResponse;
    const embeddings = parsed.embeddings ?? [];
    if (embeddings.length !== request.texts.length) {
      throw new Error(`Gemini embedding returned ${embeddings.length} vectors for ${request.texts.length} inputs.`);
    }

    return {
      model: this.config.model,
      vectors: embeddings.map((embedding, index) => {
        const vector = embedding.values;
        if (vector === undefined || vector.length === 0) {
          throw new Error(`Gemini embedding returned no vector for input ${index}.`);
        }
        return vector;
      }),
    };
  }
}

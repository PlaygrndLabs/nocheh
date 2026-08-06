import type {
  EmbeddingPort,
  EmbeddingRequest,
  EmbeddingResult,
} from "../../application/ports/embedding.js";
import type { AiTokenUsage } from "../../domain/observability/audit.js";
import { DEFAULT_MODEL_REQUEST_TIMEOUT_MS, fetchWithTimeout } from "../http/fetch-with-timeout.js";

type FetchLike = typeof fetch;

/** NVIDIA's embedding endpoint, sibling of the chat-completions one. */
export const NVIDIA_DEFAULT_EMBEDDING_URL = "https://integrate.api.nvidia.com/v1/embeddings";

const PROVIDER = "nvidia";

export interface NvidiaEmbeddingConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /**
   * Sends `input_type`, which the nv-embedqa family requires and rejects requests
   * without. Disable for a symmetric model whose endpoint refuses the field.
   */
  readonly sendInputType?: boolean;
}

interface OpenAiCompatibleEmbeddingResponse {
  readonly data?: readonly {
    readonly index?: number;
    readonly embedding?: readonly number[];
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly total_tokens?: number;
  };
}

/**
 * NVIDIA API Catalog embeddings.
 *
 * OpenAI-shaped apart from `input_type`, which nv-embedqa models require to distinguish a
 * question from stored text. ADR-0010 records that NVIDIA's audio format also deviated
 * from OpenAI's, so this wire shape is written to be verifiable and adjustable rather
 * than assumed correct.
 */
export class NvidiaEmbedding implements EmbeddingPort {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly sendInputType: boolean;

  public constructor(
    private readonly config: NvidiaEmbeddingConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.baseUrl = config.baseUrl ?? NVIDIA_DEFAULT_EMBEDDING_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
    this.sendInputType = config.sendInputType ?? true;
  }

  public async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (request.texts.length === 0) {
      return { model: this.config.model, vectors: [] };
    }

    const response = await fetchWithTimeout(this.fetchImpl, this.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        input: request.texts,
        encoding_format: "float",
        ...(this.sendInputType ? { input_type: request.kind === "query" ? "query" : "passage" } : {}),
      }),
    }, { timeoutMs: this.timeoutMs, label: "NVIDIA embedding" });

    if (!response.ok) {
      throw new Error(`NVIDIA embedding failed with status ${response.status}: ${await response.text()}`);
    }

    const parsed = (await response.json()) as OpenAiCompatibleEmbeddingResponse;
    return {
      model: this.config.model,
      vectors: orderedVectors(parsed, request.texts.length),
      ...(tokenUsage(parsed, this.config.model) === undefined
        ? {}
        : { tokenUsage: tokenUsage(parsed, this.config.model) as AiTokenUsage }),
    };
  }
}

/**
 * Restores request order and refuses a short or malformed response.
 *
 * A silently dropped vector would shift every later text onto the wrong record, so a
 * count mismatch has to fail rather than be padded.
 */
function orderedVectors(
  response: OpenAiCompatibleEmbeddingResponse,
  expected: number,
): readonly (readonly number[])[] {
  const data = response.data ?? [];
  if (data.length !== expected) {
    throw new Error(`NVIDIA embedding returned ${data.length} vectors for ${expected} inputs.`);
  }
  const vectors: (readonly number[])[] = [];
  for (let index = 0; index < expected; index += 1) {
    const entry = data.find((item) => item.index === index) ?? data[index];
    const vector = entry?.embedding;
    if (vector === undefined || vector.length === 0) {
      throw new Error(`NVIDIA embedding returned no vector for input ${index}.`);
    }
    vectors.push(vector);
  }
  return vectors;
}

function tokenUsage(
  response: OpenAiCompatibleEmbeddingResponse,
  model: string,
): AiTokenUsage | undefined {
  const usage = response.usage;
  if (usage === undefined) {
    return undefined;
  }
  const inputTokens = usage.prompt_tokens ?? usage.total_tokens ?? 0;
  // Embedding produces vectors, not tokens, so output is always zero.
  return { provider: PROVIDER, model, inputTokens, outputTokens: 0, totalTokens: inputTokens };
}

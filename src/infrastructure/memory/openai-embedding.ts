import type {
  EmbeddingPort,
  EmbeddingRequest,
  EmbeddingResult,
} from "../../application/ports/embedding.js";
import type { AiTokenUsage } from "../../domain/observability/audit.js";
import { DEFAULT_MODEL_REQUEST_TIMEOUT_MS, fetchWithTimeout } from "../http/fetch-with-timeout.js";

type FetchLike = typeof fetch;

export const OPENAI_DEFAULT_EMBEDDING_URL = "https://api.openai.com/v1/embeddings";

const PROVIDER = "openai";

export interface OpenAiEmbeddingConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

interface OpenAiEmbeddingResponse {
  readonly data?: readonly {
    readonly index?: number;
    readonly embedding?: readonly number[];
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly total_tokens?: number;
  };
}

/** OpenAI embeddings. Query/document asymmetry is not required by this model family. */
export class OpenAiEmbedding implements EmbeddingPort {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  public constructor(
    private readonly config: OpenAiEmbeddingConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.baseUrl = config.baseUrl ?? OPENAI_DEFAULT_EMBEDDING_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
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
      }),
    }, { timeoutMs: this.timeoutMs, label: "OpenAI embedding" });

    if (!response.ok) {
      throw new Error(`OpenAI embedding failed with status ${response.status}: ${await response.text()}`);
    }

    const parsed = (await response.json()) as OpenAiEmbeddingResponse;
    const usage = tokenUsage(parsed, this.config.model);
    return {
      model: this.config.model,
      vectors: orderedVectors(parsed, request.texts.length),
      ...(usage === undefined ? {} : { tokenUsage: usage }),
    };
  }
}

function orderedVectors(
  response: OpenAiEmbeddingResponse,
  expected: number,
): readonly (readonly number[])[] {
  const data = response.data ?? [];
  if (data.length !== expected) {
    throw new Error(`OpenAI embedding returned ${data.length} vectors for ${expected} inputs.`);
  }
  const vectors: (readonly number[])[] = [];
  for (let index = 0; index < expected; index += 1) {
    const entry = data.find((item) => item.index === index) ?? data[index];
    const vector = entry?.embedding;
    if (vector === undefined || vector.length === 0) {
      throw new Error(`OpenAI embedding returned no vector for input ${index}.`);
    }
    vectors.push(vector);
  }
  return vectors;
}

function tokenUsage(response: OpenAiEmbeddingResponse, model: string): AiTokenUsage | undefined {
  const usage = response.usage;
  if (usage === undefined) {
    return undefined;
  }
  const inputTokens = usage.prompt_tokens ?? usage.total_tokens ?? 0;
  return { provider: PROVIDER, model, inputTokens, outputTokens: 0, totalTokens: inputTokens };
}

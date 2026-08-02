import type {
  TextCompletionInput,
  TextCompletionPort,
  TextCompletionResult,
} from "../../application/ports/text-completion.js";
import type { AiTokenUsage } from "../../domain/observability/audit.js";
import { DEFAULT_MODEL_REQUEST_TIMEOUT_MS, fetchWithTimeout } from "../http/fetch-with-timeout.js";

type FetchLike = typeof fetch;

const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_MAX_TOKENS = 1024;

export interface OpenAiCompatibleTextCompletionConfig {
  /** Request timeout in milliseconds. */
  readonly timeoutMs?: number;
  readonly provider: string;
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

interface OpenAiCompatibleResponse {
  readonly choices?: readonly {
    readonly message?: { readonly content?: string | null };
    readonly finish_reason?: string;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
}

/** Single-turn completion against any OpenAI-compatible chat endpoint. */
export class OpenAiCompatibleTextCompletion implements TextCompletionPort {
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;

  public constructor(
    private readonly config: OpenAiCompatibleTextCompletionConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.temperature = config.temperature ?? 0;
  }

  public async complete(input: TextCompletionInput): Promise<TextCompletionResult> {
    const response = await fetchWithTimeout(this.fetchImpl, this.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: input.maxTokens ?? this.maxTokens,
        temperature: this.temperature,
        stream: false,
        ...(input.jsonOutput === true ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      }),
    }, { timeoutMs: this.timeoutMs, label: `${this.config.provider} completion` });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${this.config.provider} completion failed with status ${response.status}: ${text}`);
    }

    const parsed = (await response.json()) as OpenAiCompatibleResponse;
    const text = parsed.choices?.[0]?.message?.content ?? "";
    const finishReason = parsed.choices?.[0]?.finish_reason;
    if (text.trim().length === 0) {
      // Reasoning models spend hidden tokens before emitting anything, so hitting the
      // cap yields an empty message rather than partial output. Say so plainly:
      // "returned no content" sends an operator looking in the wrong place.
      if (finishReason === "length") {
        throw new Error(
          `${this.config.provider} completion hit the ${input.maxTokens ?? this.maxTokens} output token limit before producing any content. Raise the limit for this role.`,
        );
      }
      throw new Error(
        `${this.config.provider} completion returned no content (finish_reason: ${finishReason ?? "unknown"})`,
      );
    }

    return { text, tokenUsage: tokenUsage(parsed, this.config.provider, this.config.model) };
  }
}

function tokenUsage(response: OpenAiCompatibleResponse, provider: string, model: string): AiTokenUsage {
  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;
  return { provider, model, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

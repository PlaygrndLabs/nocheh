import type {
  TextCompletionInput,
  TextCompletionPort,
  TextCompletionResult,
} from "../../application/ports/text-completion.js";
import type { AiTokenUsage } from "../../domain/observability/audit.js";
import { DEFAULT_MODEL_REQUEST_TIMEOUT_MS, fetchWithTimeout } from "../http/fetch-with-timeout.js";

type FetchLike = typeof fetch;

const PROVIDER = "anthropic";
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_API_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 1024;

export interface AnthropicTextCompletionConfig {
  /** Request timeout in milliseconds. */
  readonly timeoutMs?: number;
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiVersion?: string;
  readonly maxTokens?: number;
}

interface AnthropicResponse {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly stop_reason?: string;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
}

/** Single-turn completion against the Anthropic Messages API. */
export class AnthropicTextCompletion implements TextCompletionPort {
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  public constructor(
    private readonly config: AnthropicTextCompletionConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  public async complete(input: TextCompletionInput): Promise<TextCompletionResult> {
    const response = await fetchWithTimeout(this.fetchImpl, this.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": this.apiVersion,
        "x-api-key": this.config.apiKey,
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: input.maxTokens ?? this.maxTokens,
        system: input.system,
        messages: [{ role: "user", content: [{ type: "text", text: input.user }] }],
      }),
    }, { timeoutMs: this.timeoutMs, label: "Anthropic completion" });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic completion failed with status ${response.status}: ${text}`);
    }

    const parsed = (await response.json()) as AnthropicResponse;
    const text = (parsed.content ?? [])
      .filter((block) => block.type === "text" || block.type === undefined)
      .map((block) => block.text ?? "")
      .join("");
    if (text.trim().length === 0) {
      throw new Error(
        `Anthropic completion returned no content (stop_reason: ${parsed.stop_reason ?? "unknown"})`,
      );
    }

    return { text, tokenUsage: tokenUsage(parsed, this.config.model) };
  }
}

function tokenUsage(response: AnthropicResponse, model: string): AiTokenUsage {
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  return { provider: PROVIDER, model, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

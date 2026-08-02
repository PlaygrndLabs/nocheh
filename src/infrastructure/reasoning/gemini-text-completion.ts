import type {
  TextCompletionInput,
  TextCompletionPort,
  TextCompletionResult,
} from "../../application/ports/text-completion.js";
import type { AiTokenUsage } from "../../domain/observability/audit.js";
import { DEFAULT_MODEL_REQUEST_TIMEOUT_MS, fetchWithTimeout } from "../http/fetch-with-timeout.js";

type FetchLike = typeof fetch;

const PROVIDER = "gemini";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MAX_TOKENS = 1024;

export interface GeminiTextCompletionConfig {
  /** Request timeout in milliseconds. */
  readonly timeoutMs?: number;
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
}

interface GeminiResponse {
  readonly candidates?: readonly {
    readonly content?: { readonly parts?: readonly { readonly text?: string }[] };
    readonly finishReason?: string;
  }[];
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
  };
}

/** Single-turn completion against the Gemini generateContent API. */
export class GeminiTextCompletion implements TextCompletionPort {
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  public constructor(
    private readonly config: GeminiTextCompletionConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  public async complete(input: TextCompletionInput): Promise<TextCompletionResult> {
    const url = `${this.baseUrl}/models/${encodeURIComponent(this.config.model)}:generateContent`;
    const response = await fetchWithTimeout(this.fetchImpl, url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Header auth keeps the key out of the URL and out of any request log.
        "x-goog-api-key": this.config.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: input.system }] },
        contents: [{ role: "user", parts: [{ text: input.user }] }],
        generationConfig: {
          maxOutputTokens: input.maxTokens ?? this.maxTokens,
          temperature: 0,
          ...(input.jsonOutput === true ? { responseMimeType: "application/json" } : {}),
        },
      }),
    }, { timeoutMs: this.timeoutMs, label: "Gemini completion" });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gemini completion failed with status ${response.status}: ${text}`);
    }

    const parsed = (await response.json()) as GeminiResponse;
    const text = (parsed.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
    if (text.trim().length === 0) {
      throw new Error(
        `Gemini completion returned no content (finishReason: ${parsed.candidates?.[0]?.finishReason ?? "unknown"})`,
      );
    }

    return { text, tokenUsage: tokenUsage(parsed, this.config.model) };
  }
}

function tokenUsage(response: GeminiResponse, model: string): AiTokenUsage {
  const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
  return { provider: PROVIDER, model, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

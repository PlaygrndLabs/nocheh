import { Buffer } from "node:buffer";
import type {
  MediaUnderstandingInput,
  MediaUnderstandingPort,
  MediaUnderstandingResult,
} from "../../application/ports/media-understanding.js";
import type { MessageAttachment } from "../../domain/messaging/message-attachment.js";
import type { AiTokenUsage } from "../../domain/observability/audit.js";
import {
  MediaNotPerceivedError,
  mediaUnderstandingSystemPrompt,
  parseUnderstanding,
} from "./nvidia-omni-media-understanding.js";
import { DEFAULT_MODEL_REQUEST_TIMEOUT_MS, fetchWithTimeout } from "../http/fetch-with-timeout.js";

type FetchLike = typeof fetch;

const PROVIDER = "gemini";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MAX_TOKENS = 512;

export interface GeminiMediaUnderstandingConfig {
  /** Request timeout in milliseconds. */
  readonly timeoutMs?: number;
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly supportedKinds?: readonly MessageAttachment["kind"][];
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

/**
 * Turns image and audio bytes into text through the Gemini generateContent API.
 *
 * Useful for voice notes specifically: Gemini accepts OGG/Opus inline, which is what
 * Telegram sends, so no ffmpeg transcoding step is needed.
 */
export class GeminiMediaUnderstanding implements MediaUnderstandingPort {
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly supportedKinds: readonly MessageAttachment["kind"][];
  private readonly timeoutMs: number;

  public constructor(
    private readonly config: GeminiMediaUnderstandingConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.supportedKinds = config.supportedKinds ?? ["image", "audio"];
  }

  public supports(kind: MessageAttachment["kind"]): boolean {
    return this.supportedKinds.includes(kind);
  }

  public async understand(input: MediaUnderstandingInput): Promise<MediaUnderstandingResult> {
    const { attachment, hint } = input;
    const instruction = hint === undefined
      ? "Describe this attachment."
      : `Describe this attachment. The message it was sent with says: ${hint}`;

    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: mediaUnderstandingSystemPrompt(attachment.kind) }] },
      contents: [{
        role: "user",
        parts: [
          { text: instruction },
          { inlineData: { mimeType: attachment.mimeType, data: Buffer.from(attachment.bytes).toString("base64") } },
        ],
      }],
      generationConfig: {
        maxOutputTokens: this.maxTokens,
        temperature: 0,
        responseMimeType: "application/json",
      },
    });

    const url = `${this.baseUrl}/models/${encodeURIComponent(this.config.model)}:generateContent`;
    const response = await fetchWithTimeout(this.fetchImpl, url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Header auth keeps the key out of the URL and out of any request log.
        "x-goog-api-key": this.config.apiKey,
      },
      body,
    }, { timeoutMs: this.timeoutMs, label: "Gemini media understanding" });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gemini media understanding failed with status ${response.status}: ${text}`);
    }

    const parsed = (await response.json()) as GeminiResponse;
    const content = (parsed.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("");
    if (content.trim().length === 0) {
      throw new Error(
        `Gemini media understanding returned no content (finishReason: ${parsed.candidates?.[0]?.finishReason ?? "unknown"})`,
      );
    }

    const output = parseUnderstanding(content);
    if (!output.perceived) {
      throw new MediaNotPerceivedError(
        `Gemini media understanding could not access the ${attachment.kind} attachment.`,
      );
    }
    return {
      understanding: {
        description: output.description,
        ...(output.transcript === undefined ? {} : { transcript: output.transcript }),
        confidence: output.confidence,
        provider: PROVIDER,
        model: this.config.model,
      },
      tokenUsage: tokenUsage(parsed, this.config.model),
    };
  }
}

function tokenUsage(response: GeminiResponse, model: string): AiTokenUsage {
  const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
  return {
    provider: PROVIDER,
    model,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

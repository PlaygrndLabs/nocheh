import { Buffer } from "node:buffer";
import type {
  MediaUnderstandingInput,
  MediaUnderstandingPort,
  MediaUnderstandingResult,
} from "../../application/ports/media-understanding.js";
import type { MessageAttachment } from "../../domain/messaging/message-attachment.js";
import type { AiTokenUsage } from "../../domain/observability/audit.js";
import { stripCodeFence } from "./memory-graph-analysis-mapping.js";
import { DEFAULT_MODEL_REQUEST_TIMEOUT_MS, fetchWithTimeout } from "../http/fetch-with-timeout.js";

type FetchLike = typeof fetch;

const PROVIDER = "nvidia";
const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
/**
 * Generous because omni models are reasoning models. Asking for a JSON object
 * suppresses the reasoning trace in practice, but when it is not suppressed a
 * one-sentence answer measured ~460 completion tokens, so a small cap truncates.
 */
const DEFAULT_MAX_TOKENS = 1536;
/** Perception should describe what is there, not speculate. */
const DEFAULT_TEMPERATURE = 0;

export interface NvidiaOmniMediaUnderstandingConfig {
  /** Request timeout in milliseconds. */
  readonly timeoutMs?: number;
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** Attachment kinds this model can read. Omni models handle both image and audio. */
  readonly supportedKinds?: readonly MessageAttachment["kind"][];
  readonly jsonResponseFormat?: boolean;
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

/**
 * Turns image and audio bytes into text through an OpenAI-compatible omni model on
 * the NVIDIA API Catalog.
 *
 * Transport only. Content-block shapes are verified against the live endpoint:
 * `image_url` for images and `audio_url` for audio, both taking a base64 data URL.
 * The declared mime type is advisory — the endpoint sniffs the bytes — but it is
 * sent correctly anyway.
 */
export class NvidiaOmniMediaUnderstanding implements MediaUnderstandingPort {
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly supportedKinds: readonly MessageAttachment["kind"][];
  private readonly jsonResponseFormat: boolean;
  private readonly timeoutMs: number;

  public constructor(
    private readonly config: NvidiaOmniMediaUnderstandingConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.temperature = config.temperature ?? DEFAULT_TEMPERATURE;
    this.supportedKinds = config.supportedKinds ?? ["image", "audio"];
    this.jsonResponseFormat = config.jsonResponseFormat ?? true;
  }

  public supports(kind: MessageAttachment["kind"]): boolean {
    return this.supportedKinds.includes(kind);
  }

  public async understand(input: MediaUnderstandingInput): Promise<MediaUnderstandingResult> {
    const body = JSON.stringify({
      model: this.config.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream: false,
      ...(this.jsonResponseFormat ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: mediaUnderstandingSystemPrompt(input.attachment.kind) },
        { role: "user", content: userContent(input) },
      ],
    });


    const response = await fetchWithTimeout(this.fetchImpl, this.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body,
    }, { timeoutMs: this.timeoutMs, label: "NVIDIA media understanding" });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`NVIDIA media understanding failed with status ${response.status}: ${text}`);
    }

    const parsed = (await response.json()) as OpenAiCompatibleResponse;
    const content = parsed.choices?.[0]?.message?.content ?? "";
    if (content.trim().length === 0) {
      throw new Error(
        `NVIDIA media understanding returned no content (finish_reason: ${parsed.choices?.[0]?.finish_reason ?? "unknown"})`,
      );
    }

    const output = parseUnderstanding(content);
    if (!output.perceived) {
      // The call succeeded but the model says it never saw the media. Treated as a
      // failure so the useless answer is not cached and the attachment can be
      // retried, rather than being permanently "described" as unavailable.
      throw new MediaNotPerceivedError(
        `NVIDIA media understanding could not access the ${input.attachment.kind} attachment.`,
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

/**
 * Raised when a perception call succeeds but the model reports it could not access
 * the attachment. Observed intermittently, so it must not poison the cache.
 */
export class MediaNotPerceivedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MediaNotPerceivedError";
  }
}

/**
 * Instructs the perception model for one specific attachment kind.
 *
 * Kind-specific on purpose. A prompt that mentions both image and audio measurably
 * confuses the omni model: it sometimes replies "No attachment provided." for a
 * clip it did receive, or calls an audio clip "the image". Since image and audio
 * are separate roles anyway, the model is only ever told about the one it has.
 *
 * The credential instruction is defence in depth, not the protection itself. It is
 * honoured inconsistently — in testing a spoken password was omitted but a password
 * written on a whiteboard was transcribed verbatim — so the secret guard still runs
 * over every description and transcript.
 */
export function mediaUnderstandingSystemPrompt(kind: MessageAttachment["kind"]): string {
  const shared = [
    "You convert one attachment into text for a personal assistant's memory pipeline.",
    "Describe only what is actually present. Never invent details, names, or numbers.",
    "If a password, API key, token, private key, seed phrase, or connection string appears,",
    "do NOT reproduce it. Write [credential omitted] in its place and say a credential was present.",
    "",
    "Return only JSON with these fields and nothing else:",
    "{ \"perceived\": boolean, \"description\": string, \"transcript\": string | null, \"confidence\": number }",
    "perceived is false ONLY if you cannot access or decode the attachment at all.",
    "confidence is between 0 and 1 and reflects how sure you are the description is accurate.",
  ];

  if (kind === "audio") {
    return [
      "You are given exactly ONE audio clip. It is audio, never an image.",
      ...shared,
      "transcript: the speech, verbatim, in its original language. Use null when there is no speech.",
      "description: what the clip is about, in one or two sentences.",
    ].join("\n");
  }

  return [
    "You are given exactly ONE image. It is an image, never audio.",
    ...shared,
    "description: what the image shows, including any legible text, diagram, or handwriting.",
    "transcript: always null for an image.",
  ].join("\n");
}

interface UnderstandingOutput {
  readonly description: string;
  readonly transcript?: string;
  readonly confidence: number;
  readonly perceived: boolean;
}

/** Provider-neutral parsing of the perception contract, shared by media adapters. */
export function parseUnderstanding(content: string): UnderstandingOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(content.trim()));
  } catch {
    // A model that ignored the JSON instruction still produced a usable description.
    const description = content.trim();
    return { description, confidence: 0.5, perceived: true };
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Media understanding output is not a JSON object.");
  }

  const record = parsed as Record<string, unknown>;
  // Absent means the model did not use the field; only an explicit false is a miss.
  const perceived = record.perceived !== false;
  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (description.length === 0 && perceived) {
    throw new Error("Media understanding output is missing a description.");
  }

  const transcript = typeof record.transcript === "string" && record.transcript.trim().length > 0
    ? record.transcript.trim()
    : undefined;
  const rawConfidence = typeof record.confidence === "number" ? record.confidence : 0.6;
  return {
    description,
    ...(transcript === undefined ? {} : { transcript }),
    confidence: Math.min(1, Math.max(0, rawConfidence)),
    perceived,
  };
}

/** Builds the multimodal user turn. Bytes are inlined as base64 data URLs. */
function userContent(input: MediaUnderstandingInput): readonly Record<string, unknown>[] {
  const { attachment, hint } = input;
  const base64 = Buffer.from(attachment.bytes).toString("base64");
  const instruction = hint === undefined
    ? "Describe this attachment."
    : `Describe this attachment. The message it was sent with says: ${hint}`;
  const url = `data:${attachment.mimeType};base64,${base64}`;

  // Verified against the live endpoint: audio uses an `audio_url` block mirroring
  // `image_url`, NOT the OpenAI `input_audio` shape. Sending `input_audio` returns
  // 400 "data did not match any variant of untagged enum
  // ChatCompletionRequestUserMessageContent".
  if (attachment.kind === "audio") {
    return [
      { type: "text", text: instruction },
      { type: "audio_url", audio_url: { url } },
    ];
  }

  return [
    { type: "text", text: instruction },
    { type: "image_url", image_url: { url } },
  ];
}

function tokenUsage(response: OpenAiCompatibleResponse, model: string): AiTokenUsage {
  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;
  return {
    provider: PROVIDER,
    model,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

import type { ConversationAnalysisInput } from "../../application/ports/memory-graph-analyzer.js";
import type {
  MemoryGraphAnalysis,
  MemoryGraphAnalyzerPort,
} from "../../application/ports/memory-graph-analyzer.js";
import type { AiTokenUsage } from "../../domain/observability/audit.js";
import {
  analysisSystemPrompt,
  analysisUserPrompt,
  buildMemoryGraphAnalysis,
  createTokenUsage,
  parseAnalysisJson,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MINIMUM_CONFIDENCE,
} from "./memory-graph-analysis-mapping.js";
import { DEFAULT_MODEL_REQUEST_TIMEOUT_MS, fetchWithTimeout } from "../http/fetch-with-timeout.js";

const PROVIDER = "nvidia";

/** NVIDIA API catalog is OpenAI-compatible. */
export const NVIDIA_DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

/** Low temperature: analysis is extraction, not creative writing. */
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TOP_P = 0.7;
/**
 * Analysis needs a far longer budget than the other roles. Measured: a two-message
 * window with media descriptions took ~240s, which also exceeds Node's own default
 * socket timeout, so this must stay explicit.
 */
const ANALYSIS_REQUEST_TIMEOUT_MS = 280_000;

export interface NvidiaMemoryGraphAnalyzerConfig {
  readonly apiKey: string;
  /** Model id as listed by GET /v1/models, for example z-ai/glm-5.2. */
  readonly model: string;
  readonly baseUrl?: string;
  readonly minimumConfidence?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  /**
   * Sends response_format: { type: "json_object" }. Enabled by default because
   * GLM-5.2 advertises structured output. Disable if the endpoint rejects it.
   */
  readonly jsonResponseFormat?: boolean;
  /**
   * Request timeout in milliseconds. Analysis is the slowest call in the pipeline:
   * a real window against z-ai/glm-5.2 measured over 200 seconds.
   */
  readonly timeoutMs?: number;
}

interface OpenAiCompatibleResponse {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string | null;
      /** Reasoning models expose their trace here. Never used as durable output. */
      readonly reasoning_content?: string | null;
    };
    readonly finish_reason?: string;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
}

/**
 * NVIDIA-hosted OpenAI-compatible transport for the shared memory graph analysis
 * prompt (https://integrate.api.nvidia.com). Model ids come from the provider
 * catalog, for example z-ai/glm-5.2.
 * Prompt and domain mapping live in memory-graph-analysis-mapping.ts.
 */
export class NvidiaMemoryGraphAnalyzer implements MemoryGraphAnalyzerPort {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly minimumConfidence: number;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly topP: number;
  private readonly jsonResponseFormat: boolean;
  private readonly timeoutMs: number;

  public constructor(config: NvidiaMemoryGraphAnalyzerConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl ?? NVIDIA_DEFAULT_BASE_URL;
    this.minimumConfidence = config.minimumConfidence ?? DEFAULT_MINIMUM_CONFIDENCE;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.temperature = config.temperature ?? DEFAULT_TEMPERATURE;
    this.topP = config.topP ?? DEFAULT_TOP_P;
    this.jsonResponseFormat = config.jsonResponseFormat ?? true;
    this.timeoutMs = config.timeoutMs ?? ANALYSIS_REQUEST_TIMEOUT_MS;
  }

  public async analyze(input: ConversationAnalysisInput): Promise<MemoryGraphAnalysis> {
    const body = JSON.stringify({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      top_p: this.topP,
      stream: false,
      ...(this.jsonResponseFormat ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: analysisSystemPrompt() },
        { role: "user", content: analysisUserPrompt(input) },
      ],
    });

    const response = await fetchWithTimeout(fetch, this.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body,
    }, { timeoutMs: this.timeoutMs, label: "NVIDIA analysis" });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`NVIDIA response failed with status ${response.status}: ${text}`);
    }

    const parsed = JSON.parse(text) as OpenAiCompatibleResponse;
    const usage = tokenUsage(parsed, this.model);
    return buildMemoryGraphAnalysis({
      rawOutput: this.parseOutput(parsed),
      provider: PROVIDER,
      minimumConfidence: this.minimumConfidence,
      // Source references are resolved from the window, never taken from the model.
      window: input.window,
      ...(usage === undefined ? {} : { tokenUsage: usage }),
    });
  }

  /**
   * Extracts the JSON payload. Truncated output (finish_reason "length") is
   * reported as a budget problem instead of a misleading JSON parse error,
   * whether the model stopped before or midway through the JSON.
   */
  private parseOutput(response: OpenAiCompatibleResponse): unknown {
    const choice = response.choices?.[0];
    const content = choice?.message?.content ?? "";
    const truncated = choice?.finish_reason === "length";
    const budgetError = new Error(
      `NVIDIA response hit the ${this.maxTokens} output token limit before completing its JSON. Raise MAX_AI_OUTPUT_TOKENS or shrink the analysis window.`,
    );

    if (content.trim().length === 0 && truncated) {
      throw budgetError;
    }
    try {
      return parseAnalysisJson(content, `NVIDIA ${this.model}`);
    } catch (error) {
      if (truncated) {
        throw budgetError;
      }
      throw error;
    }
  }
}

function tokenUsage(response: OpenAiCompatibleResponse, model: string): AiTokenUsage | undefined {
  const usage = response.usage;
  if (usage === undefined) {
    return undefined;
  }
  return createTokenUsage(PROVIDER, model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0);
}

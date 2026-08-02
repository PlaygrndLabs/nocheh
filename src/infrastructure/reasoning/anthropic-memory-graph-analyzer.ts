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
import { fetchWithTimeout } from "../http/fetch-with-timeout.js";

const PROVIDER = "anthropic";
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_API_VERSION = "2023-06-01";
const ANALYSIS_REQUEST_TIMEOUT_MS = 280_000;

export interface AnthropicMemoryGraphAnalyzerConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly apiVersion?: string;
  readonly baseUrl?: string;
  readonly minimumConfidence?: number;
  readonly maxTokens?: number;
  /** Request timeout in milliseconds. Analysis windows can be slow. */
  readonly timeoutMs?: number;
}

interface AnthropicClaudeResponse {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
}

/**
 * Anthropic Messages API transport for the shared memory graph analysis prompt.
 * Prompt and domain mapping live in memory-graph-analysis-mapping.ts.
 */
export class AnthropicMemoryGraphAnalyzer implements MemoryGraphAnalyzerPort {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly minimumConfidence: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  public constructor(config: AnthropicMemoryGraphAnalyzerConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.minimumConfidence = config.minimumConfidence ?? DEFAULT_MINIMUM_CONFIDENCE;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.timeoutMs = config.timeoutMs ?? ANALYSIS_REQUEST_TIMEOUT_MS;
  }

  public async analyze(input: ConversationAnalysisInput): Promise<MemoryGraphAnalysis> {
    const body = JSON.stringify({
      model: this.model,
      max_tokens: this.maxTokens,
      system: analysisSystemPrompt(),
      messages: [{
        role: "user",
        content: [{ type: "text", text: analysisUserPrompt(input) }],
      }],
    });

    const response = await fetchWithTimeout(fetch, this.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": this.apiVersion,
        "x-api-key": this.apiKey,
      },
      body,
    }, { timeoutMs: this.timeoutMs, label: "Anthropic analysis" });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Anthropic response failed with status ${response.status}: ${text}`);
    }

    const parsed = JSON.parse(text) as AnthropicClaudeResponse;
    const usage = tokenUsage(parsed, this.model);
    return buildMemoryGraphAnalysis({
      rawOutput: parseAnalysisJson(outputText(parsed), "Anthropic Claude"),
      provider: PROVIDER,
      minimumConfidence: this.minimumConfidence,
      // Source references are resolved from the window, never taken from the model.
      window: input.window,
      ...(usage === undefined ? {} : { tokenUsage: usage }),
    });
  }
}

function outputText(response: AnthropicClaudeResponse): string {
  return response.content
    ?.filter((content) => content.type === "text" || content.type === undefined)
    .map((content) => content.text)
    .filter((value): value is string => value !== undefined)
    .join("") ?? "";
}

function tokenUsage(response: AnthropicClaudeResponse, model: string): AiTokenUsage | undefined {
  const usage = response.usage;
  if (usage === undefined) {
    return undefined;
  }
  return createTokenUsage(PROVIDER, model, usage.input_tokens ?? 0, usage.output_tokens ?? 0);
}

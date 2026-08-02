import type { AiTokenUsage } from "../../domain/observability/audit.js";

export interface TextCompletionInput {
  readonly system: string;
  readonly user: string;
  readonly maxTokens?: number;
  /** Request a JSON object response when the provider supports it. */
  readonly jsonOutput?: boolean;
}

export interface TextCompletionResult {
  readonly text: string;
  readonly tokenUsage?: AiTokenUsage;
}

/**
 * Minimal single-turn text completion.
 *
 * Exists so small, prompt-only jobs (currently the secret guard) can be provider
 * agnostic without each one reimplementing transport. The richer analysis path keeps
 * its own port because its output contract is far more involved.
 */
export interface TextCompletionPort {
  complete(input: TextCompletionInput): Promise<TextCompletionResult>;
}

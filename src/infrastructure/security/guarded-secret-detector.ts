import type { SecretDetectorPort } from "../../application/ports/secret-detector.js";
import type { LoggerPort } from "../../application/ports/logger.js";
import type { RedactedContent } from "../../domain/security/redaction.js";
import { SecretGuardUnavailableError } from "./llm-secret-detector.js";

/** What to do when the guard model is unavailable. */
export type SecretGuardFailurePolicy = "fail_closed" | "degrade_to_patterns";

export interface GuardedSecretDetectorConfig {
  readonly onFailure?: SecretGuardFailurePolicy;
}

/**
 * The authoritative pre-analysis secret gate.
 *
 * The model-backed guard is primary because pattern rules cannot see a credential
 * written as prose or spoken aloud. The pattern detector is the emergency fallback,
 * used only when the guard is unavailable.
 *
 * With the default `fail_closed` policy a guard outage stops the window: pattern
 * redaction is applied so nothing unredacted is persisted or logged, and then the
 * error is rethrown so no text reaches the analysis model. `degrade_to_patterns`
 * trades that strictness for availability and is loud about it.
 */
export class GuardedSecretDetector implements SecretDetectorPort {
  private readonly onFailure: SecretGuardFailurePolicy;

  public constructor(
    private readonly guard: SecretDetectorPort,
    private readonly patterns: SecretDetectorPort,
    private readonly logger: LoggerPort,
    config: GuardedSecretDetectorConfig = {},
  ) {
    this.onFailure = config.onFailure ?? "fail_closed";
  }

  public async redact(text: string): Promise<RedactedContent> {
    const results = await this.redactMany([text]);
    return results[0] ?? { text, findings: [] };
  }

  public async redactMany(texts: readonly string[]): Promise<readonly RedactedContent[]> {
    try {
      return await this.guard.redactMany(texts);
    } catch (error) {
      if (!(error instanceof SecretGuardUnavailableError)) {
        throw error;
      }

      const fallback = await this.patterns.redactMany(texts);
      const patternFindings = fallback.reduce((total, result) => total + result.findings.length, 0);
      if (this.onFailure === "fail_closed") {
        this.logger.error("Secret guard unavailable; refusing to analyse this window.", {
          error: error.message,
          patternFindings,
          policy: this.onFailure,
        });
        // Rethrown so the caller keeps the window buffered and retries later. Pattern
        // redaction already ran, so nothing unredacted was persisted in the meantime.
        throw error;
      }

      this.logger.warn("Secret guard unavailable; degrading to pattern rules only.", {
        error: error.message,
        patternFindings,
        policy: this.onFailure,
      });
      return fallback;
    }
  }
}

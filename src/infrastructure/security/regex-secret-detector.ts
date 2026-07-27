import type { RedactedContent } from "../../domain/security/redaction.js";
import { DEFAULT_REDACTION_PLACEHOLDER, renderPlaceholder } from "../../domain/security/redaction-policy.js";
import type { SecretDetectorPort } from "../../application/ports/secret-detector.js";
import { BUILT_IN_SECRET_PATTERNS } from "./built-in-secret-patterns.js";
import { redactWithPatterns } from "./redaction-engine.js";

/**
 * Always-on regex detector using the full built-in catalog. Kept as a simple,
 * dependency-free default; use {@link ConfigurableSecretDetector} when categories
 * and custom patterns must be configurable.
 */
export class RegexSecretDetector implements SecretDetectorPort {
  /** Redacts known sensitive spans and returns finding metadata without secret values. */
  public redact(text: string): RedactedContent {
    return redactWithPatterns(
      text,
      BUILT_IN_SECRET_PATTERNS,
      (kind) => renderPlaceholder(DEFAULT_REDACTION_PLACEHOLDER, kind),
    );
  }
}

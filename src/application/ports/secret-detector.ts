import type { RedactedContent } from "../../domain/security/redaction.js";

/**
 * Detects and redacts sensitive data before external processing or persistence.
 *
 * `redact` may be asynchronous so a model-backed detector can slot in behind the
 * same port. `redactMany` exists so such a detector can inspect a whole conversation
 * window in a single call instead of one call per field.
 */
export interface SecretDetectorPort {
  redact(text: string): RedactedContent | Promise<RedactedContent>;
  /**
   * Redacts several independent texts, preserving order and length of the input.
   * Each result corresponds to the input at the same index.
   */
  redactMany(texts: readonly string[]): Promise<readonly RedactedContent[]>;
}

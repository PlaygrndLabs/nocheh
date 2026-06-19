import type { RedactedContent } from "../../domain/security/redaction.js";

/** Detects and redacts sensitive data before external processing or persistence. */
export interface SecretDetectorPort {
  redact(text: string): RedactedContent;
}

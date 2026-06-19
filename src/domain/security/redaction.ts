/** Sensitive data categories that must not cross persistence or provider boundaries. */
export type SensitiveFindingKind =
  | "api_key"
  | "access_token"
  | "private_key"
  | "seed_phrase"
  | "password"
  | "connection_secret";

/** A sensitive span detected in input text. */
export interface SensitiveFinding {
  readonly kind: SensitiveFindingKind;
  readonly start: number;
  readonly end: number;
}

/** Sanitized text and metadata describing what was removed. */
export interface RedactedContent {
  readonly text: string;
  readonly findings: readonly SensitiveFinding[];
}

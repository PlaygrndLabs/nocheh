import type { CompiledSecretPattern } from "./redaction-engine.js";

/**
 * Built-in, high-signal secret patterns grouped by category. Shared by the
 * always-on `RegexSecretDetector` and the config-driven `ConfigurableSecretDetector`.
 * Patterns favour provider-specific shapes to limit false positives.
 */
export const BUILT_IN_SECRET_PATTERNS: readonly CompiledSecretPattern[] = [
  // Private keys: PEM blocks (RSA/EC/OPENSSH/ENCRYPTED) and PGP private key blocks.
  { kind: "private_key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "private_key", regex: /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?-----END PGP PRIVATE KEY BLOCK-----/g },

  // API keys: provider-prefixed (Stripe/OpenAI/Anthropic/Google), AWS, SendGrid, Twilio.
  { kind: "api_key", regex: /\b(?:sk|pk|rk|ak|AIza)[A-Za-z0-9_-]{16,}\b/g },
  { kind: "api_key", regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g },
  { kind: "api_key", regex: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { kind: "api_key", regex: /\b(?:AC|SK)[0-9a-fA-F]{32}\b/g },

  // Access tokens: GitHub, Slack, Google OAuth, JWTs, Telegram bot tokens, Bearer headers.
  { kind: "access_token", regex: /\bgh[opsur]_[A-Za-z0-9]{20,}\b/g },
  { kind: "access_token", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: "access_token", regex: /\bxox[baprse]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "access_token", regex: /\bya29\.[A-Za-z0-9._-]{20,}\b/g },
  { kind: "access_token", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: "access_token", regex: /\b\d{8,10}:[A-Za-z0-9_-]{32,48}\b/g },
  { kind: "access_token", regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },

  // Connection secrets: DB/broker URIs, any credentials-in-URL, and inbound webhooks.
  { kind: "connection_secret", regex: /\b(?:postgres|postgresql|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver|clickhouse):\/\/[^\s]+/gi },
  { kind: "connection_secret", regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s]+/gi },
  { kind: "connection_secret", regex: /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gi },
  { kind: "connection_secret", regex: /\bhttps:\/\/discord(?:app)?\.com\/api\/webhooks\/[A-Za-z0-9/_-]+/gi },

  // Passwords, passphrases, and client secrets given as key/value assignments.
  { kind: "password", regex: /\b(?:password|passwd|pwd|passphrase|secret|client[_-]?secret)\s*[:=]\s*['"]?[^'"\s]{6,}/gi },

  // Crypto seed / recovery phrases (11-23 words after the label).
  { kind: "seed_phrase", regex: /\b(?:seed phrase|mnemonic|(?:secret )?recovery phrase)\s*[:=]\s*(?:[a-z]+[\s,]+){11,23}[a-z]+\b/gi },
];

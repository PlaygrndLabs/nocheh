import { DEFAULT_REDACTION_POLICY, type RedactionPolicy } from "../security/redaction-policy.js";

/**
 * Global, DB-backed application configuration.
 *
 * Each field is an independently persisted section keyed by name in `app_config`.
 * New feature sections are added here with a default; no schema migration required.
 * Secrets are intentionally excluded and remain in the environment.
 */
export interface AppConfig {
  readonly redaction: RedactionPolicy;
}

/** Section keys used as `app_config` primary keys. */
export const APP_CONFIG_KEYS = {
  redaction: "redaction",
} as const;

export const DEFAULT_APP_CONFIG: AppConfig = {
  redaction: DEFAULT_REDACTION_POLICY,
};

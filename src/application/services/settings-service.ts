import type { AppConfigRepositoryPort } from "../ports/app-config-repository.js";
import type { LoggerPort } from "../ports/logger.js";
import type { RedactionPolicyProvider } from "../ports/redaction-policy-provider.js";
import {
  APP_CONFIG_KEYS,
  DEFAULT_APP_CONFIG,
  type AppConfig,
} from "../../domain/config/app-config.js";
import {
  DEFAULT_REDACTION_POLICY,
  normalizeRedactionPolicy,
  type RedactionPolicy,
  type RedactionPolicyPatch,
} from "../../domain/security/redaction-policy.js";

/**
 * Global configuration service backed by the DB.
 *
 * Holds a synchronous in-memory cache so hot-path consumers (e.g. the secret
 * detector) can read config without awaiting. `init()` hydrates the cache at
 * boot; setters validate, persist, then refresh the cache so changes apply
 * live without a restart.
 */
export class SettingsService implements RedactionPolicyProvider {
  private cache: AppConfig = DEFAULT_APP_CONFIG;

  public constructor(
    private readonly repository: AppConfigRepositoryPort,
    private readonly logger?: LoggerPort,
  ) {}

  /** Loads persisted config into the cache. Call once before serving traffic. */
  public async init(): Promise<void> {
    const raw = await this.repository.getAll();
    this.cache = {
      redaction: this.parseRedaction(raw[APP_CONFIG_KEYS.redaction]),
    };
  }

  public getConfig(): AppConfig {
    return this.cache;
  }

  public currentRedactionPolicy(): RedactionPolicy {
    return this.cache.redaction;
  }

  /** Validates and persists a redaction policy patch, then refreshes the cache. */
  public async updateRedactionPolicy(patch: RedactionPolicyPatch): Promise<RedactionPolicy> {
    const next = normalizeRedactionPolicy(patch, this.cache.redaction);
    await this.repository.set(APP_CONFIG_KEYS.redaction, JSON.stringify(next), false);
    this.cache = { ...this.cache, redaction: next };
    return next;
  }

  private parseRedaction(rawValue: string | undefined): RedactionPolicy {
    if (rawValue === undefined) {
      return DEFAULT_REDACTION_POLICY;
    }
    try {
      const parsed = JSON.parse(rawValue) as RedactionPolicyPatch;
      return normalizeRedactionPolicy(parsed, DEFAULT_REDACTION_POLICY);
    } catch (error) {
      this.logger?.warn("Failed to parse stored redaction policy; using defaults.", {
        error: error instanceof Error ? error.message : String(error),
      });
      return DEFAULT_REDACTION_POLICY;
    }
  }
}

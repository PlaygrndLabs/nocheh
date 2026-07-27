import { randomUUID } from "node:crypto";
import type { JsonHandler } from "../router.js";
import type { SettingsService } from "../../../application/services/settings-service.js";
import {
  REDACTION_CATEGORIES,
  type CustomRedactionPattern,
  type RedactionPolicyPatch,
} from "../../../domain/security/redaction-policy.js";

export interface ConfigRoutes {
  readonly get: JsonHandler;
  readonly putRedaction: JsonHandler;
}

/** Global application configuration. First section: the redaction policy. */
export function createConfigRoutes(settings: SettingsService): ConfigRoutes {
  return {
    get: async () => ({
      status: 200,
      body: {
        ok: true,
        config: settings.getConfig(),
        redactionCategories: REDACTION_CATEGORIES,
      },
    }),

    putRedaction: async ({ body }) => {
      try {
        const patch = buildRedactionPatch((body ?? {}) as Record<string, unknown>);
        const redaction = await settings.updateRedactionPolicy(patch);
        return { status: 200, body: { ok: true, redaction } };
      } catch (error) {
        return {
          status: 400,
          body: { ok: false, error: error instanceof Error ? error.message : String(error) },
        };
      }
    },
  };
}

function buildRedactionPatch(body: Record<string, unknown>): RedactionPolicyPatch {
  const patch: {
    categories?: Record<string, unknown>;
    customPatterns?: readonly unknown[];
    placeholder?: unknown;
  } = {};

  if (isRecord(body.categories)) {
    patch.categories = body.categories;
  }
  if (typeof body.placeholder === "string") {
    patch.placeholder = body.placeholder;
  }
  if (Array.isArray(body.customPatterns)) {
    // Assign stable ids to any new entries before domain validation runs.
    patch.customPatterns = body.customPatterns.map(withId);
  }

  return patch;
}

function withId(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if (typeof value.id === "string" && value.id.length > 0) {
    return value;
  }
  return { ...value, id: randomUUID() } satisfies Partial<CustomRedactionPattern> & Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

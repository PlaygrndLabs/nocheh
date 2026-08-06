import {
  AI_MODEL_ROLES,
  AI_PROVIDERS,
  aiModelEnvKeys,
  aiProviderEnvKeys,
  aiProviderSecretEnvKeys,
  aiRoleProviderEnvKeys,
  findAiProvider,
  normalizeAiProviderId,
  providersForRole,
  requiredAiProviderEnvKeys,
  type AiModelRole,
  type AiProviderDescriptor,
} from "../../../application/config/ai-provider-catalog.js";
import type { EnvStorePort } from "../../../application/ports/env-store.js";
import type { JsonHandler } from "../router.js";

/** Environment keys the client is allowed to write. Provider keys come from the catalog. */
export const WRITABLE_ENV_KEYS = [
  ...aiRoleProviderEnvKeys(),
  ...aiProviderEnvKeys(),
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_URL",
  "TELEGRAM_ALLOWED_CHAT_IDS",
  "TELEGRAM_ALLOWED_USER_IDS",
  "MESSAGE_ANALYSIS_MODE",
  "LIVE_ANALYSIS_INTERVAL_SECONDS",
  "LIVE_MAX_MESSAGES_PER_BATCH",
  "MAX_AI_CONTEXT_TOKENS",
  "MAX_AI_OUTPUT_TOKENS",
  "MAX_RETRIEVED_MEMORIES",
  "MAX_RECENT_MESSAGES",
  "SUMMARY_EVERY_MESSAGES",
  "SUMMARY_EVERY_MINUTES",
  "MEDIA_MAX_ATTACHMENTS_PER_WINDOW",
  "MEDIA_MAX_DOWNLOAD_BYTES",
  "MEDIA_MAX_INLINE_BYTES",
  "SECRET_GUARD_MAX_ATTEMPTS",
  "NVIDIA_EMBEDDING_INPUT_TYPE",
] as const;

const SECRET_KEYS = [...aiProviderSecretEnvKeys(), "TELEGRAM_BOT_TOKEN"];

const STATUS_PRESENCE_KEYS = [
  ...new Set([
    ...SECRET_KEYS,
    ...aiModelEnvKeys(),
    "TELEGRAM_WEBHOOK_URL",
    "LOCAL_ENCRYPTION_SECRET",
  ]),
];

export interface SetupRoutes {
  readonly getEnv: JsonHandler;
  readonly putEnv: JsonHandler;
  readonly getStatus: JsonHandler;
}

/** Setup/configuration routes. Exposes presence only, never secret values. */
export function createSetupRoutes(envStore: EnvStorePort): SetupRoutes {
  return {
    getEnv: async () => {
      const presence = await envStore.presence(WRITABLE_ENV_KEYS);
      const keys: Record<string, "set" | "unset"> = {};
      for (const key of WRITABLE_ENV_KEYS) {
        keys[key] = presence[key] ? "set" : "unset";
      }
      return { status: 200, body: { ok: true, keys } };
    },

    putEnv: async ({ body }) => {
      const values = (body as { values?: Record<string, unknown> } | undefined)?.values;
      if (values === undefined || typeof values !== "object") {
        return { status: 400, body: { ok: false, error: "Expected { values: { KEY: string } }" } };
      }

      const writable: Record<string, string> = {};
      const rejected: string[] = [];
      for (const [key, value] of Object.entries(values)) {
        if ((WRITABLE_ENV_KEYS as readonly string[]).includes(key) && typeof value === "string") {
          writable[key] = value;
        } else {
          rejected.push(key);
        }
      }

      const updated = await envStore.setMany(writable);
      return { status: 200, body: { ok: true, updated, rejected, restartRequired: true } };
    },

    getStatus: async () => {
      const presence = await envStore.presence(STATUS_PRESENCE_KEYS);
      const values = await envStore.read();
      const roles = AI_MODEL_ROLES.map((role) => {
        const providerId = normalizeAiProviderId(values[role.providerEnvKey]);
        const provider = findAiProvider(providerId);
        const supportsRole = provider !== undefined && provider.roles[role.id] !== undefined;
        const ready = supportsRole
          && requiredAiProviderEnvKeys(provider, role.id).every((key) => presence[key] ?? false);
        return {
          id: role.id,
          label: role.label,
          purpose: role.purpose,
          whenUnset: role.whenUnset,
          providerEnvKey: role.providerEnvKey,
          provider: providerId ?? "none",
          // A provider selected for a role it cannot fill is a misconfiguration, not readiness.
          supported: supportsRole,
          ready,
          model: roleModel(provider, role.id, values),
          providers: providersForRole(role.id).map((candidate) => ({
            id: candidate.id,
            label: candidate.label,
            apiKeyEnvKey: candidate.apiKeyEnvKey,
            modelEnvKey: candidate.roles[role.id]?.modelEnvKey,
            defaultModel: candidate.roles[role.id]?.defaultModel,
            modelRequired: candidate.roles[role.id]?.defaultModel === undefined,
            notes: candidate.roles[role.id]?.notes ?? candidate.notes,
          })),
        };
      });
      const textRole = roles.find((role) => role.id === "text_analysis");
      return {
        status: 200,
        body: {
          ok: true,
          // Kept for the existing dashboard contract: text analysis is the primary role.
          hasAiKey: textRole?.ready ?? false,
          aiProvider: textRole?.provider ?? "none",
          aiModel: textRole?.model,
          roles,
          providers: AI_PROVIDERS.map((candidate) => ({
            id: candidate.id,
            label: candidate.label,
            apiKeyEnvKey: candidate.apiKeyEnvKey,
            // Presence only. The credential itself is never read back.
            hasApiKey: presence[candidate.apiKeyEnvKey] ?? false,
            notes: candidate.notes,
            roles: Object.keys(candidate.roles),
          })),
          hasBotToken: presence.TELEGRAM_BOT_TOKEN ?? false,
          botConnected: (presence.TELEGRAM_BOT_TOKEN ?? false) && (presence.TELEGRAM_WEBHOOK_URL ?? false),
          webhookUrl: values.TELEGRAM_WEBHOOK_URL,
          encryptionConfigured: presence.LOCAL_ENCRYPTION_SECRET ?? false,
        },
      };
    },
  };
}

/** Model ids are not secrets, so the active one can be echoed back to the dashboard. */
function roleModel(
  provider: AiProviderDescriptor | undefined,
  role: AiModelRole,
  values: Record<string, string>,
): string | undefined {
  const support = provider?.roles[role];
  if (support === undefined) {
    return undefined;
  }
  const configured = values[support.modelEnvKey]?.trim();
  return configured === undefined || configured.length === 0 ? support.defaultModel : configured;
}

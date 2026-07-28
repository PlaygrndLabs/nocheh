import {
  AI_PROVIDERS,
  aiProviderEnvKeys,
  aiProviderSecretEnvKeys,
  findAiProvider,
  normalizeAiProviderId,
  requiredAiProviderEnvKeys,
  type AiProviderDescriptor,
} from "../../../application/config/ai-provider-catalog.js";
import type { EnvStorePort } from "../../../application/ports/env-store.js";
import type { JsonHandler } from "../router.js";

/** Environment keys the client is allowed to write. Provider keys come from the catalog. */
export const WRITABLE_ENV_KEYS = [
  "AI_PROVIDER",
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
] as const;

const SECRET_KEYS = [...aiProviderSecretEnvKeys(), "TELEGRAM_BOT_TOKEN"];

const STATUS_PRESENCE_KEYS = [
  ...new Set([
    ...SECRET_KEYS,
    ...AI_PROVIDERS.map((provider) => provider.modelEnvKey),
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
      const providerId = normalizeAiProviderId(values.AI_PROVIDER);
      const provider = findAiProvider(providerId);
      const providerReady = provider !== undefined
        && requiredAiProviderEnvKeys(provider).every((key) => presence[key] ?? false);
      return {
        status: 200,
        body: {
          ok: true,
          hasAiKey: providerReady,
          aiProvider: providerId ?? "none",
          aiModel: aiModel(provider, values),
          providers: AI_PROVIDERS.map((candidate) => ({
            id: candidate.id,
            label: candidate.label,
            apiKeyEnvKey: candidate.apiKeyEnvKey,
            modelEnvKey: candidate.modelEnvKey,
            defaultModel: candidate.defaultModel,
            modelRequired: candidate.defaultModel === undefined,
            notes: candidate.notes,
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
function aiModel(provider: AiProviderDescriptor | undefined, values: Record<string, string>): string | undefined {
  if (provider === undefined) {
    return undefined;
  }
  const configured = values[provider.modelEnvKey]?.trim();
  return configured === undefined || configured.length === 0 ? provider.defaultModel : configured;
}

import type { EnvStorePort } from "../../../application/ports/env-store.js";
import type { JsonHandler } from "../router.js";

/** Environment keys the client is allowed to write. */
export const WRITABLE_ENV_KEYS = [
  "AI_PROVIDER",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEDROCK_REGION",
  "AWS_BEDROCK_MODEL_ID",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_URL",
  "MESSAGE_ANALYSIS_MODE",
  "LIVE_ANALYSIS_INTERVAL_SECONDS",
  "LIVE_MAX_MESSAGES_PER_BATCH",
  "MAX_AI_CONTEXT_TOKENS",
  "MAX_RETRIEVED_MEMORIES",
  "MAX_RECENT_MESSAGES",
  "SUMMARY_EVERY_MESSAGES",
  "SUMMARY_EVERY_MINUTES",
] as const;

const SECRET_KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "TELEGRAM_BOT_TOKEN"];

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
      const presence = await envStore.presence([...SECRET_KEYS, "AWS_BEDROCK_MODEL_ID", "TELEGRAM_WEBHOOK_URL", "LOCAL_ENCRYPTION_SECRET"]);
      const values = await envStore.read();
      const aiProvider = values.AI_PROVIDER;
      const hasBedrockConfig = aiProvider === "bedrock"
        && (presence.AWS_ACCESS_KEY_ID ?? false)
        && (presence.AWS_SECRET_ACCESS_KEY ?? false)
        && (presence.AWS_BEDROCK_MODEL_ID ?? false);
      return {
        status: 200,
        body: {
          ok: true,
          hasAiKey: hasBedrockConfig,
          aiProvider: aiProvider ?? "none",
          hasBotToken: presence.TELEGRAM_BOT_TOKEN ?? false,
          botConnected: (presence.TELEGRAM_BOT_TOKEN ?? false) && (presence.TELEGRAM_WEBHOOK_URL ?? false),
          webhookUrl: values.TELEGRAM_WEBHOOK_URL,
          encryptionConfigured: presence.LOCAL_ENCRYPTION_SECRET ?? false,
        },
      };
    },
  };
}

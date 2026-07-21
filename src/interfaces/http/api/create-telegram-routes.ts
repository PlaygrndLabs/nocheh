import type { EnvStorePort } from "../../../application/ports/env-store.js";
import type { TelegramClientPort } from "../../../application/ports/telegram-client.js";
import type { JsonHandler } from "../router.js";

export interface TelegramRoutes {
  readonly connect: JsonHandler;
  readonly status: JsonHandler;
  readonly getAccess: JsonHandler;
  readonly putAccess: JsonHandler;
}

/** Routes for connecting a Telegram bot and inspecting its webhook state. */
export function createTelegramRoutes(client: TelegramClientPort, envStore: EnvStorePort): TelegramRoutes {
  return {
    connect: async ({ body }) => {
      const { token, webhookUrl } = (body ?? {}) as { token?: unknown; webhookUrl?: unknown };
      if (typeof token !== "string" || token.length === 0 || typeof webhookUrl !== "string" || webhookUrl.length === 0) {
        return { status: 400, body: { ok: false, error: "Expected { token: string, webhookUrl: string }" } };
      }

      let bot;
      try {
        bot = await client.getMe(token);
      } catch (error) {
        return { status: 400, body: { ok: false, error: `Invalid bot token: ${message(error)}` } };
      }

      try {
        await client.setWebhook(token, webhookUrl);
      } catch (error) {
        return { status: 502, body: { ok: false, error: `setWebhook failed: ${message(error)}`, bot } };
      }

      await envStore.setMany({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_URL: webhookUrl });
      return { status: 200, body: { ok: true, bot, webhookUrl } };
    },

    status: async () => {
      const values = await envStore.read();
      const token = values.TELEGRAM_BOT_TOKEN;
      if (token === undefined || token.length === 0) {
        return { status: 200, body: { ok: true, connected: false } };
      }

      try {
        const [bot, webhook] = await Promise.all([client.getMe(token), client.getWebhookInfo(token)]);
        return { status: 200, body: { ok: true, connected: webhook.url.length > 0, bot, webhook } };
      } catch (error) {
        return { status: 200, body: { ok: true, connected: false, error: message(error) } };
      }
    },

    getAccess: async () => {
      const values = await envStore.read();
      return {
        status: 200,
        body: {
          ok: true,
          allowedChatIds: splitCsv(values.TELEGRAM_ALLOWED_CHAT_IDS),
          allowedUserIds: splitCsv(values.TELEGRAM_ALLOWED_USER_IDS),
        },
      };
    },

    putAccess: async ({ body }) => {
      const value = isRecord(body) ? body : {};
      const allowedChatIds = normalizeIdList(value.allowedChatIds);
      const allowedUserIds = normalizeIdList(value.allowedUserIds);
      if (allowedChatIds === undefined || allowedUserIds === undefined) {
        return { status: 400, body: { ok: false, error: "Expected allowedChatIds and allowedUserIds as string arrays." } };
      }
      const updates = {
        TELEGRAM_ALLOWED_CHAT_IDS: allowedChatIds.join(","),
        TELEGRAM_ALLOWED_USER_IDS: allowedUserIds.join(","),
      };
      await envStore.setMany(updates);
      process.env.TELEGRAM_ALLOWED_CHAT_IDS = updates.TELEGRAM_ALLOWED_CHAT_IDS;
      process.env.TELEGRAM_ALLOWED_USER_IDS = updates.TELEGRAM_ALLOWED_USER_IDS;
      return { status: 200, body: { ok: true, allowedChatIds, allowedUserIds } };
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function splitCsv(value: string | undefined): readonly string[] {
  return unique((value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0));
}

function normalizeIdList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ids = value.map((item) => typeof item === "string" ? item.trim() : "").filter((item) => item.length > 0);
  if (ids.some((item) => !/^-?\d+$/.test(item))) {
    return undefined;
  }
  return unique(ids);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

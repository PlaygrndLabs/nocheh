import type { EnvStorePort } from "../../../application/ports/env-store.js";
import type { TelegramClientPort } from "../../../application/ports/telegram-client.js";
import type { JsonHandler } from "../router.js";

export interface TelegramRoutes {
  readonly connect: JsonHandler;
  readonly status: JsonHandler;
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
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

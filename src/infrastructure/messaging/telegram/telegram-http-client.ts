import type {
  TelegramBotInfo,
  TelegramClientPort,
  TelegramWebhookInfo,
} from "../../../application/ports/telegram-client.js";

type FetchLike = typeof fetch;

interface TelegramEnvelope<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
}

/** Calls the Telegram Bot API over HTTPS using the global fetch (Node 22+). */
export class TelegramHttpClient implements TelegramClientPort {
  public constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = "https://api.telegram.org",
  ) {}

  public async getMe(token: string): Promise<TelegramBotInfo> {
    const result = await this.call<{ id: number; username?: string; first_name: string }>(token, "getMe");
    return {
      id: result.id,
      firstName: result.first_name,
      ...(result.username === undefined ? {} : { username: result.username }),
    };
  }

  public async setWebhook(token: string, url: string): Promise<void> {
    await this.call(token, "setWebhook", { url });
  }

  public async getWebhookInfo(token: string): Promise<TelegramWebhookInfo> {
    const result = await this.call<{ url: string; pending_update_count?: number; last_error_message?: string }>(
      token,
      "getWebhookInfo",
    );
    return {
      url: result.url,
      ...(result.pending_update_count === undefined ? {} : { pendingUpdateCount: result.pending_update_count }),
      ...(result.last_error_message === undefined ? {} : { lastErrorMessage: result.last_error_message }),
    };
  }

  private async call<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });

    const envelope = (await response.json()) as TelegramEnvelope<T>;
    if (!envelope.ok || envelope.result === undefined) {
      throw new Error(envelope.description ?? `Telegram ${method} failed with status ${response.status}`);
    }
    return envelope.result;
  }
}

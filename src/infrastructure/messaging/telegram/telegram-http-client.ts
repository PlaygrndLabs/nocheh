import type {
  TelegramBotInfo,
  TelegramClientPort,
  TelegramFileInfo,
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
    // message_reaction requires the bot to be an administrator in the chat to receive updates.
    await this.call(token, "setWebhook", {
      url,
      allowed_updates: ["message", "edited_message", "message_reaction"],
    });
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

  public async getFile(token: string, fileId: string): Promise<TelegramFileInfo> {
    const result = await this.call<{ file_id: string; file_path?: string; file_size?: number }>(
      token,
      "getFile",
      { file_id: fileId },
    );
    if (result.file_path === undefined || result.file_path.length === 0) {
      throw new Error(`Telegram getFile returned no file_path for ${fileId}`);
    }
    return {
      fileId: result.file_id,
      path: result.file_path,
      ...(result.file_size === undefined ? {} : { sizeBytes: result.file_size }),
    };
  }

  /**
   * File bytes live on a different host path than the API methods and are not
   * JSON, so this deliberately bypasses `call`.
   */
  public async downloadFile(token: string, path: string, maxBytes: number): Promise<Uint8Array> {
    const response = await this.fetchImpl(`${this.baseUrl}/file/bot${token}/${path}`);
    if (!response.ok) {
      throw new Error(`Telegram file download failed with status ${response.status}`);
    }

    // Trust the advertised length when present so an oversized file is rejected
    // before any of it is buffered.
    const advertised = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(advertised) && advertised > maxBytes) {
      throw new Error(`Telegram file is ${advertised} bytes, above the ${maxBytes} byte limit`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Telegram file is ${bytes.byteLength} bytes, above the ${maxBytes} byte limit`);
    }
    return bytes;
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

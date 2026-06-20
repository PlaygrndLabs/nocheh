/** Identity of a Telegram bot as returned by getMe. */
export interface TelegramBotInfo {
  readonly id: number;
  readonly username?: string;
  readonly firstName: string;
}

/** Current webhook registration state. */
export interface TelegramWebhookInfo {
  readonly url: string;
  readonly pendingUpdateCount?: number;
  readonly lastErrorMessage?: string;
}

/** Outbound boundary for the Telegram Bot API calls the dashboard needs. */
export interface TelegramClientPort {
  /** Validates a token and returns the bot identity. Throws on an invalid token. */
  getMe(token: string): Promise<TelegramBotInfo>;
  /** Registers the webhook URL with Telegram. Throws on failure. */
  setWebhook(token: string, url: string): Promise<void>;
  /** Returns the current webhook registration. */
  getWebhookInfo(token: string): Promise<TelegramWebhookInfo>;
}

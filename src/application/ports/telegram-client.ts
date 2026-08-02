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

/** A file handle resolved by getFile. `path` expires roughly an hour after issue. */
export interface TelegramFileInfo {
  readonly fileId: string;
  readonly path: string;
  readonly sizeBytes?: number;
}

/** Outbound boundary for the Telegram Bot API calls the client needs. */
export interface TelegramClientPort {
  /** Validates a token and returns the bot identity. Throws on an invalid token. */
  getMe(token: string): Promise<TelegramBotInfo>;
  /** Registers the webhook URL with Telegram. Throws on failure. */
  setWebhook(token: string, url: string): Promise<void>;
  /** Returns the current webhook registration. */
  getWebhookInfo(token: string): Promise<TelegramWebhookInfo>;
  /** Resolves a file_id to a download path. The path is short-lived; download immediately. */
  getFile(token: string, fileId: string): Promise<TelegramFileInfo>;
  /**
   * Downloads file bytes. Rejects once maxBytes is exceeded rather than buffering
   * an unbounded upload.
   */
  downloadFile(token: string, path: string, maxBytes: number): Promise<Uint8Array>;
}

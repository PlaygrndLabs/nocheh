import type { IncomingMessage } from "../../../application/dto/incoming-message.js";

interface TelegramChat {
  readonly id: number | string;
}

interface TelegramUser {
  readonly id: number;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly username?: string;
}

interface TelegramMessage {
  readonly message_id: number;
  readonly date: number;
  readonly chat: TelegramChat;
  readonly from?: TelegramUser;
  readonly text?: string;
}

/** Minimal Telegram webhook update shape required for Phase 1 ingestion. */
export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly edited_message?: TelegramMessage;
}

/** Converts Telegram-specific webhook payloads into platform-neutral messages. */
export class TelegramUpdateMapper {
  /** Maps supported Telegram message updates; returns undefined for unsupported updates. */
  public toIncomingMessage(update: TelegramUpdate): IncomingMessage | undefined {
    const message = update.message ?? update.edited_message;
    if (message?.text === undefined || message.from === undefined) {
      return undefined;
    }

    const senderDisplayName = this.displayName(message.from);
    return {
      platform: "telegram",
      conversationId: String(message.chat.id),
      messageId: String(message.message_id),
      senderId: String(message.from.id),
      ...(senderDisplayName === undefined ? {} : { senderDisplayName }),
      text: message.text,
      occurredAt: new Date(message.date * 1000),
    };
  }

  private displayName(user: TelegramUser): string | undefined {
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
    return name || user.username;
  }
}

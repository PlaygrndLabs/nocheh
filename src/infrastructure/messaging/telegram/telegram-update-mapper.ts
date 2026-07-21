import type { IncomingMessage } from "../../../application/dto/incoming-message.js";
import type { IncomingReactionEvent } from "../../../application/dto/incoming-reaction-event.js";

interface TelegramChat {
  readonly id: number | string;
}

interface TelegramUser {
  readonly id: number;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly username?: string;
}

interface TelegramReplyToMessage {
  readonly message_id: number;
}

interface TelegramMessage {
  readonly message_id: number;
  readonly date: number;
  readonly chat: TelegramChat;
  readonly from?: TelegramUser;
  readonly text?: string;
  readonly reply_to_message?: TelegramReplyToMessage;
}

interface TelegramReactionType {
  readonly type?: string;
  readonly emoji?: string;
  readonly custom_emoji_id?: string;
}

interface TelegramMessageReactionUpdated {
  readonly chat: TelegramChat;
  readonly message_id: number;
  readonly user?: TelegramUser;
  readonly date: number;
  readonly new_reaction?: readonly TelegramReactionType[];
}

/** Minimal Telegram webhook update shape required for ingestion. */
export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly edited_message?: TelegramMessage;
  readonly message_reaction?: TelegramMessageReactionUpdated;
}

/** Converts Telegram-specific webhook payloads into platform-neutral messages and reactions. */
export class TelegramUpdateMapper {
  /** Maps supported Telegram message updates; returns undefined for unsupported updates. */
  public toIncomingMessage(update: TelegramUpdate): IncomingMessage | undefined {
    const message = update.message ?? update.edited_message;
    if (message?.text === undefined || message.from === undefined) {
      return undefined;
    }

    const senderDisplayName = this.displayName(message.from);
    const replyToMessageId = message.reply_to_message === undefined
      ? undefined
      : String(message.reply_to_message.message_id);
    return {
      platform: "telegram",
      conversationId: String(message.chat.id),
      messageId: String(message.message_id),
      senderId: String(message.from.id),
      ...(senderDisplayName === undefined ? {} : { senderDisplayName }),
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
      text: message.text,
      occurredAt: new Date(message.date * 1000),
    };
  }

  /** Maps a Telegram `message_reaction` update into a platform-neutral reaction event. */
  public toIncomingReaction(update: TelegramUpdate): IncomingReactionEvent | undefined {
    const reaction = update.message_reaction;
    if (reaction === undefined || reaction.user === undefined) {
      return undefined;
    }

    const emojis = (reaction.new_reaction ?? [])
      .map((item) => item.emoji ?? item.custom_emoji_id)
      .filter((value): value is string => value !== undefined && value.length > 0);

    const reactorDisplayName = this.displayName(reaction.user);
    return {
      platform: "telegram",
      conversationId: String(reaction.chat.id),
      targetMessageId: String(reaction.message_id),
      reactorId: String(reaction.user.id),
      ...(reactorDisplayName === undefined ? {} : { reactorDisplayName }),
      reactions: emojis.map((emoji) => ({ emoji, reactorId: String(reaction.user?.id) })),
      occurredAt: new Date(reaction.date * 1000),
    };
  }

  private displayName(user: TelegramUser): string | undefined {
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
    return name || user.username;
  }
}

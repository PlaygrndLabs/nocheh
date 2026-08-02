import type { IncomingMessage } from "../../../application/dto/incoming-message.js";
import type { IncomingReactionEvent } from "../../../application/dto/incoming-reaction-event.js";
import type {
  MessageAttachment,
  MessageAttachmentVariant,
} from "../../../domain/messaging/message-attachment.js";

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

/** Common shape of every Telegram file object. */
interface TelegramFileBase {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly file_size?: number;
}

interface TelegramPhotoSize extends TelegramFileBase {
  readonly width: number;
  readonly height: number;
}

interface TelegramVoice extends TelegramFileBase {
  readonly duration: number;
  readonly mime_type?: string;
}

interface TelegramAudio extends TelegramFileBase {
  readonly duration: number;
  readonly mime_type?: string;
  readonly file_name?: string;
  readonly title?: string;
  readonly performer?: string;
}

interface TelegramDocument extends TelegramFileBase {
  readonly mime_type?: string;
  readonly file_name?: string;
  readonly thumbnail?: TelegramPhotoSize;
}

interface TelegramVideo extends TelegramFileBase {
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly mime_type?: string;
  readonly file_name?: string;
  readonly thumbnail?: TelegramPhotoSize;
}

interface TelegramVideoNote extends TelegramFileBase {
  readonly length: number;
  readonly duration: number;
  readonly thumbnail?: TelegramPhotoSize;
}

interface TelegramAnimation extends TelegramFileBase {
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly mime_type?: string;
  readonly file_name?: string;
}

interface TelegramSticker extends TelegramFileBase {
  readonly width: number;
  readonly height: number;
  readonly is_animated?: boolean;
  readonly is_video?: boolean;
  readonly emoji?: string;
  readonly set_name?: string;
}

interface TelegramMessage {
  readonly message_id: number;
  readonly date: number;
  readonly chat: TelegramChat;
  readonly from?: TelegramUser;
  readonly text?: string;
  /** Media messages carry their body here, not in `text`. */
  readonly caption?: string;
  readonly reply_to_message?: TelegramReplyToMessage;
  readonly media_group_id?: string;
  readonly photo?: readonly TelegramPhotoSize[];
  readonly voice?: TelegramVoice;
  readonly audio?: TelegramAudio;
  readonly document?: TelegramDocument;
  readonly video?: TelegramVideo;
  readonly video_note?: TelegramVideoNote;
  readonly animation?: TelegramAnimation;
  readonly sticker?: TelegramSticker;
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
    if (message === undefined || message.from === undefined) {
      return undefined;
    }

    // Media messages put their body in `caption`. A media-only message has neither,
    // and is still meaningful because the attachments carry the content.
    const text = message.text ?? message.caption ?? "";
    const attachments = this.toAttachments(message);
    if (text.length === 0 && attachments.length === 0) {
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
      text,
      occurredAt: new Date(message.date * 1000),
      ...(attachments.length === 0 ? {} : { attachments }),
    };
  }

  /** Describes why an update produced no message, for logging unhandled updates. */
  public describeUnsupportedUpdate(update: TelegramUpdate): string {
    const message = update.message ?? update.edited_message;
    if (message === undefined) {
      if (update.message_reaction !== undefined) {
        return "message_reaction without a user";
      }
      return "update carries neither message nor message_reaction";
    }
    if (message.from === undefined) {
      return "message without a sender";
    }
    return "message with no text, caption, or supported attachment";
  }

  private toAttachments(message: TelegramMessage): readonly MessageAttachment[] {
    const attachments: MessageAttachment[] = [];

    // Telegram sends one photo in several resolutions. They collapse into a single
    // attachment whose variants let a perception adapter respect its payload cap.
    if (message.photo !== undefined && message.photo.length > 0) {
      const variants: MessageAttachmentVariant[] = [...message.photo]
        .sort((left, right) => (left.file_size ?? left.width * left.height) - (right.file_size ?? right.width * right.height))
        .map((size) => ({
          fileId: size.file_id,
          fileUniqueId: size.file_unique_id,
          ...(size.file_size === undefined ? {} : { sizeBytes: size.file_size }),
          width: size.width,
          height: size.height,
        }));
      const largest = variants[variants.length - 1];
      if (largest !== undefined) {
        attachments.push({
          kind: "image",
          fileUniqueId: largest.fileUniqueId,
          fileId: largest.fileId,
          mimeType: "image/jpeg",
          ...(largest.sizeBytes === undefined ? {} : { sizeBytes: largest.sizeBytes }),
          ...(largest.width === undefined ? {} : { width: largest.width }),
          ...(largest.height === undefined ? {} : { height: largest.height }),
          variants,
        });
      }
    }

    if (message.voice !== undefined) {
      attachments.push({
        kind: "audio",
        fileUniqueId: message.voice.file_unique_id,
        fileId: message.voice.file_id,
        // Telegram voice notes are OGG/Opus unless the client says otherwise.
        mimeType: message.voice.mime_type ?? "audio/ogg",
        ...(message.voice.file_size === undefined ? {} : { sizeBytes: message.voice.file_size }),
        durationSeconds: message.voice.duration,
      });
    }

    if (message.audio !== undefined) {
      const fileName = message.audio.file_name ?? message.audio.title;
      attachments.push({
        kind: "audio",
        fileUniqueId: message.audio.file_unique_id,
        fileId: message.audio.file_id,
        ...(message.audio.mime_type === undefined ? {} : { mimeType: message.audio.mime_type }),
        ...(message.audio.file_size === undefined ? {} : { sizeBytes: message.audio.file_size }),
        durationSeconds: message.audio.duration,
        ...(fileName === undefined ? {} : { fileName }),
      });
    }

    if (message.document !== undefined) {
      // Images sent as files arrive as documents, so the mime type decides the kind.
      const isImage = message.document.mime_type?.startsWith("image/") === true;
      attachments.push({
        kind: isImage ? "image" : "document",
        fileUniqueId: message.document.file_unique_id,
        fileId: message.document.file_id,
        ...(message.document.mime_type === undefined ? {} : { mimeType: message.document.mime_type }),
        ...(message.document.file_size === undefined ? {} : { sizeBytes: message.document.file_size }),
        ...(message.document.file_name === undefined ? {} : { fileName: message.document.file_name }),
      });
    }

    if (message.video !== undefined) {
      attachments.push({
        kind: "video",
        fileUniqueId: message.video.file_unique_id,
        fileId: message.video.file_id,
        ...(message.video.mime_type === undefined ? {} : { mimeType: message.video.mime_type }),
        ...(message.video.file_size === undefined ? {} : { sizeBytes: message.video.file_size }),
        durationSeconds: message.video.duration,
        width: message.video.width,
        height: message.video.height,
        ...(message.video.file_name === undefined ? {} : { fileName: message.video.file_name }),
      });
    }

    if (message.video_note !== undefined) {
      attachments.push({
        kind: "video",
        fileUniqueId: message.video_note.file_unique_id,
        fileId: message.video_note.file_id,
        mimeType: "video/mp4",
        ...(message.video_note.file_size === undefined ? {} : { sizeBytes: message.video_note.file_size }),
        durationSeconds: message.video_note.duration,
      });
    }

    if (message.animation !== undefined) {
      attachments.push({
        kind: "video",
        fileUniqueId: message.animation.file_unique_id,
        fileId: message.animation.file_id,
        ...(message.animation.mime_type === undefined ? {} : { mimeType: message.animation.mime_type }),
        ...(message.animation.file_size === undefined ? {} : { sizeBytes: message.animation.file_size }),
        durationSeconds: message.animation.duration,
        width: message.animation.width,
        height: message.animation.height,
        ...(message.animation.file_name === undefined ? {} : { fileName: message.animation.file_name }),
      });
    }

    if (message.sticker !== undefined) {
      const fileName = message.sticker.emoji ?? message.sticker.set_name;
      attachments.push({
        kind: "sticker",
        fileUniqueId: message.sticker.file_unique_id,
        fileId: message.sticker.file_id,
        ...(message.sticker.file_size === undefined ? {} : { sizeBytes: message.sticker.file_size }),
        width: message.sticker.width,
        height: message.sticker.height,
        ...(fileName === undefined ? {} : { fileName }),
      });
    }

    return attachments;
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

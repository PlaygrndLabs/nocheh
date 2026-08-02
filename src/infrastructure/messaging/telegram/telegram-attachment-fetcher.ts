import {
  AttachmentFetchError,
  type AttachmentFetcherPort,
} from "../../../application/ports/attachment-fetcher.js";
import type { FetchedAttachment } from "../../../application/ports/media-understanding.js";
import type { TelegramClientPort } from "../../../application/ports/telegram-client.js";
import type { MessageAttachment } from "../../../domain/messaging/message-attachment.js";

/** Fallback mime types when Telegram does not report one. */
const DEFAULT_MIME_TYPES: Record<MessageAttachment["kind"], string> = {
  image: "image/jpeg",
  audio: "audio/ogg",
  video: "video/mp4",
  document: "application/octet-stream",
  sticker: "image/webp",
};

/**
 * Downloads Telegram attachment bytes on demand.
 *
 * The bot token is read lazily so a token added through the dashboard takes effect
 * without a restart, matching how the rest of the Telegram wiring behaves.
 */
export class TelegramAttachmentFetcher implements AttachmentFetcherPort {
  public constructor(
    private readonly client: TelegramClientPort,
    private readonly token: () => string | undefined,
  ) {}

  public supports(platform: string): boolean {
    return platform === "telegram";
  }

  public async fetch(attachment: MessageAttachment, maxBytes: number): Promise<FetchedAttachment> {
    const token = this.token();
    if (token === undefined || token.length === 0) {
      throw new AttachmentFetchError("Telegram bot token is not configured; cannot download attachments.");
    }

    try {
      // getFile paths expire in about an hour, so resolve and download back to back.
      const file = await this.client.getFile(token, attachment.fileId);
      if (file.sizeBytes !== undefined && file.sizeBytes > maxBytes) {
        throw new AttachmentFetchError(
          `Attachment is ${file.sizeBytes} bytes, above the ${maxBytes} byte limit.`,
        );
      }
      const bytes = await this.client.downloadFile(token, file.path, maxBytes);
      return {
        kind: attachment.kind,
        mimeType: attachment.mimeType ?? mimeFromPath(file.path) ?? DEFAULT_MIME_TYPES[attachment.kind],
        bytes,
        fileId: attachment.fileId,
      };
    } catch (error) {
      if (error instanceof AttachmentFetchError) {
        throw error;
      }
      throw new AttachmentFetchError(
        `Failed to download Telegram attachment ${attachment.fileUniqueId}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

const EXTENSION_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/opus",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  flac: "audio/flac",
};

/** Telegram file paths carry the real extension even when the message omits a mime type. */
function mimeFromPath(path: string): string | undefined {
  const extension = path.split(".").pop()?.toLowerCase();
  return extension === undefined ? undefined : EXTENSION_MIME_TYPES[extension];
}

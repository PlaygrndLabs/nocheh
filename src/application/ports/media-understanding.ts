import type {
  MessageAttachment,
  MessageAttachmentUnderstanding,
} from "../../domain/messaging/message-attachment.js";
import type { AiTokenUsage } from "../../domain/observability/audit.js";

/** Raw bytes of one attachment, held only long enough to be turned into text. */
export interface FetchedAttachment {
  readonly kind: MessageAttachment["kind"];
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  /** Which rendition was downloaded, for auditing size decisions. */
  readonly fileId: string;
}

export interface MediaUnderstandingInput {
  readonly attachment: FetchedAttachment;
  /** Message text or caption, when present. Helps the model resolve ambiguous images. */
  readonly hint?: string;
}

export interface MediaUnderstandingResult {
  readonly understanding: MessageAttachmentUnderstanding;
  readonly tokenUsage?: AiTokenUsage;
}

/**
 * Turns image and audio bytes into text.
 *
 * This is the only port that receives unredacted raw media. Whatever provider is
 * wired here must be trusted accordingly: a photographed password or a key read
 * aloud reaches it before any redaction is possible.
 */
export interface MediaUnderstandingPort {
  understand(input: MediaUnderstandingInput): Promise<MediaUnderstandingResult>;
  /** False when the configured model cannot handle this attachment kind. */
  supports(kind: MessageAttachment["kind"]): boolean;
}

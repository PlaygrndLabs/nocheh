import type { MessageAttachment } from "../../domain/messaging/message-attachment.js";

/** A reaction attached to a message (e.g. a Telegram emoji reaction). */
export interface MessageReaction {
  readonly emoji: string;
  readonly reactorId?: string;
  readonly reactorDisplayName?: string;
}

/** Platform-neutral message accepted by application use cases. */
export interface IncomingMessage {
  readonly platform: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly senderDisplayName?: string;
  /**
   * Message body, or a caption for media messages. Empty for media-only
   * messages: the meaning then lives in `attachments`.
   */
  readonly text: string;
  readonly occurredAt: Date;
  /** Id of the message this one replies to, when the platform exposes it. */
  readonly replyToMessageId?: string;
  /** Current reaction snapshot on this message, when known. */
  readonly reactions?: readonly MessageReaction[];
  /** Non-text content sent with this message. */
  readonly attachments?: readonly MessageAttachment[];
}

/** True when a message carries no text and no understandable attachment. */
export function isEmptyMessage(message: IncomingMessage): boolean {
  return message.text.trim().length === 0 && (message.attachments ?? []).length === 0;
}

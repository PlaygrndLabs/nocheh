import type { MessageAttachment } from "../messaging/message-attachment.js";

export interface BufferedMessage {
  readonly platform: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly senderDisplayName?: string;
  readonly text: string;
  readonly occurredAt: Date;
  readonly bufferedAt: Date;
  readonly replyToMessageId?: string;
  /**
   * Attachment identity and shape, never bytes. Understanding runs at flush time,
   * so buffered attachments normally carry no derived text yet.
   */
  readonly attachments?: readonly MessageAttachment[];
  /**
   * How many times a flush of this message was abandoned because the secret guard
   * was unavailable. Bounds retries so one poisonous window cannot stall a
   * conversation forever.
   */
  readonly guardAttempts?: number;
  /**
   * Set once retries are exhausted. Quarantined messages are excluded from windows
   * and kept for the owner to inspect rather than analysed or deleted.
   */
  readonly quarantinedAt?: Date;
}

/** True when this message has been set aside after repeated guard failures. */
export function isQuarantined(message: BufferedMessage): boolean {
  return message.quarantinedAt !== undefined;
}

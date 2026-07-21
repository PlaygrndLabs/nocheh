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
  readonly text: string;
  readonly occurredAt: Date;
  /** Id of the message this one replies to, when the platform exposes it. */
  readonly replyToMessageId?: string;
  /** Current reaction snapshot on this message, when known. */
  readonly reactions?: readonly MessageReaction[];
}

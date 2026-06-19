export interface BufferedMessage {
  readonly platform: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly senderDisplayName?: string;
  readonly text: string;
  readonly occurredAt: Date;
  readonly bufferedAt: Date;
}

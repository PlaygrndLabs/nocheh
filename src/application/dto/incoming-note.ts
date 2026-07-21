/**
 * A manual note from Mak: an authoritative instruction to add or correct knowledge,
 * sent outside ordinary group chatter (via the dashboard or a Telegram /note command).
 */
export interface NoteInput {
  readonly conversationId: string;
  readonly text: string;
  readonly authorId?: string;
  readonly authorDisplayName?: string;
  readonly occurredAt?: Date;
}

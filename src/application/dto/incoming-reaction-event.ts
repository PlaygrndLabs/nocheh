import type { MessageReaction } from "./incoming-message.js";

/**
 * A reaction change on an earlier message (e.g. a Telegram `message_reaction` update).
 * Reactions arrive after the fact and are interpreted by the brain to update prior knowledge
 * (for example, a done-style reaction may close the task that message produced).
 */
export interface IncomingReactionEvent {
  readonly platform: string;
  readonly conversationId: string;
  readonly targetMessageId: string;
  readonly reactorId: string;
  readonly reactorDisplayName?: string;
  /** The current reaction set on the target message from this actor. */
  readonly reactions: readonly MessageReaction[];
  readonly occurredAt: Date;
}

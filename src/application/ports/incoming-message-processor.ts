import type { ConversationWindow } from "../dto/conversation-window.js";
import type { IncomingMessage } from "../dto/incoming-message.js";
import type { IncomingReactionEvent } from "../dto/incoming-reaction-event.js";
import type { NoteInput } from "../dto/incoming-note.js";

/** Processes a single platform-neutral message (immediate mode). */
export interface IncomingMessageProcessorPort {
  execute(message: IncomingMessage): Promise<unknown>;
}

/** Processes an ordered conversation window in one analysis pass (batch mode). */
export interface ConversationWindowProcessorPort {
  executeWindow(window: ConversationWindow): Promise<unknown>;
}

/** Processes a reaction change against knowledge derived from the target message. */
export interface ReactionProcessorPort {
  executeReaction(event: IncomingReactionEvent): Promise<unknown>;
}

/** Processes a manual note from Mak as an authoritative knowledge update. */
export interface NoteProcessorPort {
  executeNote(input: NoteInput): Promise<unknown>;
}

/** Convenience alias for downstreams that accept every entry point. */
export type ConversationProcessorPort =
  IncomingMessageProcessorPort & ConversationWindowProcessorPort & ReactionProcessorPort & NoteProcessorPort;

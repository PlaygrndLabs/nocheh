import type { ConversationWindow } from "../dto/conversation-window.js";
import type { IncomingMessage } from "../dto/incoming-message.js";
import type { IncomingReactionEvent } from "../dto/incoming-reaction-event.js";
import type { NoteInput } from "../dto/incoming-note.js";
import type { GroupAssistantSettings } from "../../domain/assistant/group-assistant-settings.js";

/** Processes a single platform-neutral message (immediate mode). */
export interface IncomingMessageProcessorPort {
  execute(message: IncomingMessage): Promise<unknown>;
}

/** Processes an ordered conversation window in one analysis pass (batch mode). */
export interface ConversationWindowProcessorPort {
  /**
   * @param settings Already-resolved settings for this conversation. Passed rather than
   * looked up again because the caller resolves them from stored rows plus environment
   * defaults, and a second lookup downstream would see only the stored half.
   */
  executeWindow(window: ConversationWindow, settings?: GroupAssistantSettings): Promise<unknown>;
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

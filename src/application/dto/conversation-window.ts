import type { IncomingMessage } from "./incoming-message.js";
import type { ProjectHint } from "../../domain/assistant/project-hint.js";

export type { ProjectHint };

/**
 * An ordered slice of one conversation handed to the brain for a single analysis pass.
 *
 * Every message keeps its own id, sender, and timestamp so the analyzer can reason
 * about who said what, how messages relate, and attribute each produced fact to a
 * concrete source message id (never a synthetic batch id).
 */
export interface ConversationWindow {
  readonly platform: string;
  readonly conversationId: string;
  /** Redacted messages in chronological order. */
  readonly messages: readonly IncomingMessage[];
  /** Optional guidance about project structure for this conversation. */
  readonly projectHint?: ProjectHint;
  /**
   * Optional out-of-band instruction from Mak (a manual note) that should be
   * treated as an authoritative correction rather than ordinary group chatter.
   */
  readonly note?: string;
}

/** Builds a single-message window, used for immediate-mode processing. */
export function singleMessageWindow(message: IncomingMessage): ConversationWindow {
  return {
    platform: message.platform,
    conversationId: message.conversationId,
    messages: [message],
  };
}

/** Returns the last message in a window, used to derive representative metadata. */
export function windowAnchor(window: ConversationWindow): IncomingMessage | undefined {
  return window.messages[window.messages.length - 1];
}

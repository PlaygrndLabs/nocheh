import type { BufferedMessage } from "../../domain/assistant/buffered-message.js";

export interface LiveMessageBufferRepositoryPort {
  append(message: BufferedMessage): Promise<void>;
  findByConversationId(conversationId: string): Promise<readonly BufferedMessage[]>;
  remove(conversationId: string, messageIds: readonly string[]): Promise<void>;
  /**
   * Conversations with anything buffered. Needed by the scheduled flush sweep, which
   * must find due batches without waiting for the next inbound message.
   */
  conversationIds(): Promise<readonly string[]>;
}

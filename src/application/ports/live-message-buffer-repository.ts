import type { BufferedMessage } from "../../domain/assistant/buffered-message.js";

export interface LiveMessageBufferRepositoryPort {
  append(message: BufferedMessage): Promise<void>;
  findByConversationId(conversationId: string): Promise<readonly BufferedMessage[]>;
  remove(conversationId: string, messageIds: readonly string[]): Promise<void>;
}

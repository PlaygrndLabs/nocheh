import type { LiveMessageBufferRepositoryPort } from "../../application/ports/live-message-buffer-repository.js";
import type { BufferedMessage } from "../../domain/assistant/buffered-message.js";
import type { EncryptedJsonFileStore } from "../memory/encrypted-json-file-store.js";

interface StoredBufferedMessage extends Omit<BufferedMessage, "occurredAt" | "bufferedAt" | "quarantinedAt"> {
  readonly occurredAt: string;
  readonly bufferedAt: string;
  readonly quarantinedAt?: string;
}

/** Local encrypted buffer for short-lived sanitized live messages. */
export class LocalLiveMessageBufferRepository implements LiveMessageBufferRepositoryPort {
  public constructor(private readonly store: EncryptedJsonFileStore<readonly StoredBufferedMessage[]>) {}

  public async append(message: BufferedMessage): Promise<void> {
    const records = await this.store.read();
    const next = records.filter((record) =>
      !(record.conversationId === message.conversationId && record.messageId === message.messageId),
    );
    await this.store.write([...next, this.serialize(message)]);
  }

  public async findByConversationId(conversationId: string): Promise<readonly BufferedMessage[]> {
    return (await this.store.read())
      .filter((record) => record.conversationId === conversationId)
      .map((record) => this.deserialize(record));
  }

  public async remove(conversationId: string, messageIds: readonly string[]): Promise<void> {
    const ids = new Set(messageIds);
    const records = await this.store.read();
    await this.store.write(records.filter((record) =>
      record.conversationId !== conversationId || !ids.has(record.messageId),
    ));
  }

  public async conversationIds(): Promise<readonly string[]> {
    return [...new Set((await this.store.read()).map((record) => record.conversationId))];
  }

  private serialize(message: BufferedMessage): StoredBufferedMessage {
    const { quarantinedAt, ...rest } = message;
    return {
      ...rest,
      occurredAt: message.occurredAt.toISOString(),
      bufferedAt: message.bufferedAt.toISOString(),
      ...(quarantinedAt === undefined ? {} : { quarantinedAt: quarantinedAt.toISOString() }),
    };
  }

  private deserialize(record: StoredBufferedMessage): BufferedMessage {
    const { quarantinedAt, ...rest } = record;
    return {
      ...rest,
      occurredAt: new Date(record.occurredAt),
      bufferedAt: new Date(record.bufferedAt),
      ...(quarantinedAt === undefined ? {} : { quarantinedAt: new Date(quarantinedAt) }),
    };
  }
}

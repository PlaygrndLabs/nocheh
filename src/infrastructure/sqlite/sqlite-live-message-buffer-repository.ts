import type { EncryptionPort } from "../../application/ports/encryption.js";
import type { LiveMessageBufferRepositoryPort } from "../../application/ports/live-message-buffer-repository.js";
import type { BufferedMessage } from "../../domain/assistant/buffered-message.js";
import { EncryptedJsonCodec } from "./encrypted-json-codec.js";
import type { SqliteDatabase } from "./sqlite-database.js";

interface BufferRow {
  readonly payload: string;
}

interface StoredBufferedMessage extends Omit<BufferedMessage, "occurredAt" | "bufferedAt"> {
  readonly occurredAt: string;
  readonly bufferedAt: string;
}

export class SqliteLiveMessageBufferRepository implements LiveMessageBufferRepositoryPort {
  private readonly codec: EncryptedJsonCodec;

  public constructor(
    private readonly database: SqliteDatabase,
    encryption: EncryptionPort,
  ) {
    this.codec = new EncryptedJsonCodec(encryption);
  }

  public async append(message: BufferedMessage): Promise<void> {
    const stored = this.serialize(message);
    const payload = await this.codec.encode(stored);
    this.database.prepare(`
      INSERT INTO live_message_buffer (conversation_id, message_id, occurred_at, buffered_at, payload)
      VALUES (@conversationId, @messageId, @occurredAt, @bufferedAt, @payload)
      ON CONFLICT(conversation_id, message_id) DO UPDATE SET
        occurred_at = excluded.occurred_at,
        buffered_at = excluded.buffered_at,
        payload = excluded.payload
    `).run({
      conversationId: stored.conversationId,
      messageId: stored.messageId,
      occurredAt: stored.occurredAt,
      bufferedAt: stored.bufferedAt,
      payload,
    });
  }

  public async findByConversationId(conversationId: string): Promise<readonly BufferedMessage[]> {
    const rows = this.database
      .prepare("SELECT payload FROM live_message_buffer WHERE conversation_id = ? ORDER BY buffered_at ASC")
      .all(conversationId) as BufferRow[];
    return Promise.all(rows.map(async (row) => this.deserialize(await this.codec.decode<StoredBufferedMessage>(row.payload))));
  }

  public async remove(conversationId: string, messageIds: readonly string[]): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    const removeOne = this.database.prepare(
      "DELETE FROM live_message_buffer WHERE conversation_id = ? AND message_id = ?",
    );
    const removeMany = this.database.transaction((ids: readonly string[]) => {
      for (const id of ids) {
        removeOne.run(conversationId, id);
      }
    });
    removeMany(messageIds);
  }

  private serialize(message: BufferedMessage): StoredBufferedMessage {
    return {
      ...message,
      occurredAt: message.occurredAt.toISOString(),
      bufferedAt: message.bufferedAt.toISOString(),
    };
  }

  private deserialize(record: StoredBufferedMessage): BufferedMessage {
    return {
      ...record,
      occurredAt: new Date(record.occurredAt),
      bufferedAt: new Date(record.bufferedAt),
    };
  }
}

import type { EncryptionPort } from "../../application/ports/encryption.js";
import type { MediaUnderstandingCachePort } from "../../application/ports/media-understanding-cache.js";
import type { MessageAttachmentUnderstanding } from "../../domain/messaging/message-attachment.js";
import { EncryptedJsonCodec } from "./encrypted-json-codec.js";
import type { SqliteDatabase } from "./sqlite-database.js";

interface CacheRow {
  readonly payload: string;
}

/**
 * Caches derived attachment text so a resent or forwarded file is not paid for twice.
 *
 * Descriptions and transcripts can quote a conversation, so the payload is encrypted
 * like every other derived artefact.
 */
export class SqliteMediaUnderstandingCache implements MediaUnderstandingCachePort {
  private readonly codec: EncryptedJsonCodec;

  public constructor(
    private readonly database: SqliteDatabase,
    encryption: EncryptionPort,
  ) {
    this.codec = new EncryptedJsonCodec(encryption);
  }

  public async find(fileUniqueId: string): Promise<MessageAttachmentUnderstanding | undefined> {
    const row = this.database
      .prepare("SELECT payload FROM media_understanding WHERE file_unique_id = ?")
      .get(fileUniqueId) as CacheRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return this.codec.decode<MessageAttachmentUnderstanding>(row.payload);
  }

  public async save(fileUniqueId: string, understanding: MessageAttachmentUnderstanding): Promise<void> {
    const payload = await this.codec.encode(understanding);
    this.database.prepare(`
      INSERT INTO media_understanding (file_unique_id, payload, created_at)
      VALUES (@fileUniqueId, @payload, @createdAt)
      ON CONFLICT(file_unique_id) DO UPDATE SET
        payload = excluded.payload,
        created_at = excluded.created_at
    `).run({ fileUniqueId, payload, createdAt: new Date().toISOString() });
  }
}

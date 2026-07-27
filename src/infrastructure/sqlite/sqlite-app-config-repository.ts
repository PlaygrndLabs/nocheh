import type { AppConfigRepositoryPort } from "../../application/ports/app-config-repository.js";
import type { EncryptionPort } from "../../application/ports/encryption.js";
import { EncryptedJsonCodec } from "./encrypted-json-codec.js";
import type { SqliteDatabase } from "./sqlite-database.js";

interface ConfigRow {
  readonly key: string;
  readonly value: string;
  readonly encrypted: number;
}

export class SqliteAppConfigRepository implements AppConfigRepositoryPort {
  private readonly codec: EncryptedJsonCodec;

  public constructor(
    private readonly database: SqliteDatabase,
    encryption: EncryptionPort,
  ) {
    this.codec = new EncryptedJsonCodec(encryption);
  }

  public async getAll(): Promise<Record<string, string>> {
    const rows = this.database
      .prepare("SELECT key, value, encrypted FROM app_config")
      .all() as ConfigRow[];

    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.encrypted === 1 ? await this.codec.decode<string>(row.value) : row.value;
    }
    return result;
  }

  public async set(key: string, value: string, encrypted = false): Promise<void> {
    const stored = encrypted ? await this.codec.encode(value) : value;
    this.database.prepare(`
      INSERT INTO app_config (key, value, encrypted, updated_at)
      VALUES (@key, @value, @encrypted, @updatedAt)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        encrypted = excluded.encrypted,
        updated_at = excluded.updated_at
    `).run({
      key,
      value: stored,
      encrypted: encrypted ? 1 : 0,
      updatedAt: new Date().toISOString(),
    });
  }
}

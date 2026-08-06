import { Buffer } from "node:buffer";
import type { EncryptionPort } from "../../application/ports/encryption.js";
import type {
  MemoryEmbedding,
  MemoryEmbeddingRepositoryPort,
} from "../../application/ports/memory-embedding-repository.js";
import type { ClockPort } from "../../application/ports/clock.js";
import type { SqliteDatabase } from "./sqlite-database.js";

interface EmbeddingRow {
  readonly record_id: string;
  readonly model: string;
  readonly dimensions: number;
  readonly vector: string;
}

/**
 * Stores memory vectors as encrypted base64 float32.
 *
 * JSON would cost roughly four times as much: a 1024-dimension vector is about 20 KB as
 * a JSON number array against about 5.5 KB as base64 float32, and every query decrypts
 * the whole set once. Float32 is also the precision embedding APIs serve, so nothing is
 * lost by not storing float64.
 */
export class SqliteMemoryEmbeddingRepository implements MemoryEmbeddingRepositoryPort {
  public constructor(
    private readonly database: SqliteDatabase,
    private readonly encryption: EncryptionPort,
    private readonly clock: ClockPort,
  ) {}

  public async save(embedding: MemoryEmbedding): Promise<void> {
    const vector = await this.encryption.encryptUtf8(encodeVector(embedding.vector));
    this.database.prepare(`
      INSERT INTO memory_embeddings (record_id, model, dimensions, vector, created_at)
      VALUES (@recordId, @model, @dimensions, @vector, @createdAt)
      ON CONFLICT(record_id) DO UPDATE SET
        model = excluded.model,
        dimensions = excluded.dimensions,
        vector = excluded.vector,
        created_at = excluded.created_at
    `).run({
      recordId: embedding.recordId,
      model: embedding.model,
      dimensions: embedding.vector.length,
      vector,
      createdAt: this.clock.now().toISOString(),
    });
  }

  public async findAll(): Promise<readonly MemoryEmbedding[]> {
    const rows = this.database
      .prepare("SELECT record_id, model, dimensions, vector FROM memory_embeddings")
      .all() as EmbeddingRow[];
    return Promise.all(rows.map(async (row) => ({
      recordId: row.record_id,
      model: row.model,
      vector: decodeVector(await this.encryption.decryptUtf8(row.vector)),
    })));
  }

  public async indexedRecordIds(): Promise<readonly string[]> {
    const rows = this.database
      .prepare("SELECT record_id FROM memory_embeddings")
      .all() as { readonly record_id: string }[];
    return rows.map((row) => row.record_id);
  }
}

function encodeVector(vector: readonly number[]): string {
  const floats = Float32Array.from(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString("base64");
}

function decodeVector(encoded: string): readonly number[] {
  const bytes = Buffer.from(encoded, "base64");
  // Copied rather than viewed: a Buffer from the pool can sit at an offset that is not a
  // multiple of 4, which a Float32Array view rejects.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return Array.from(new Float32Array(copy.buffer));
}

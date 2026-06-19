import type { MemoryRecord } from "../../domain/memory/memory-record.js";

/** Stores durable structured knowledge records without raw message history. */
export interface MemoryRecordRepositoryPort {
  save(record: MemoryRecord): Promise<void>;
  findAll(): Promise<readonly MemoryRecord[]>;
}

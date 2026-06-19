import type { MemoryRecord, MemoryRecordType } from "../../domain/memory/memory-record.js";

/** Stores durable structured knowledge records without raw message history. */
export interface MemoryRecordRepositoryPort {
  save(record: MemoryRecord): Promise<void>;
  findAll(): Promise<readonly MemoryRecord[]>;
  findByType(type: MemoryRecordType): Promise<readonly MemoryRecord[]>;
  findByProjectId(projectId: string): Promise<readonly MemoryRecord[]>;
}

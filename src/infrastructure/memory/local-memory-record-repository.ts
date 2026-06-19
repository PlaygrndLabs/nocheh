import type { MemoryRecordRepositoryPort } from "../../application/ports/memory-record-repository.js";
import type { MemoryRecord } from "../../domain/memory/memory-record.js";
import { Task, type TaskSnapshot } from "../../domain/tasks/task.js";
import type { EncryptedJsonFileStore } from "./encrypted-json-file-store.js";

interface StoredMemoryRecord extends Omit<MemoryRecord, "createdAt" | "updatedAt" | "task"> {
  readonly task?: StoredTaskSnapshot;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface StoredTaskSnapshot extends Omit<TaskSnapshot, "createdAt" | "updatedAt" | "dueAt" | "source"> {
  readonly dueAt?: string;
  readonly source: Omit<TaskSnapshot["source"], "occurredAt"> & { readonly occurredAt: string };
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Local encrypted repository for structured memory records. */
export class LocalMemoryRecordRepository implements MemoryRecordRepositoryPort {
  public constructor(private readonly store: EncryptedJsonFileStore<readonly StoredMemoryRecord[]>) {}

  /** Saves or replaces a structured memory record. */
  public async save(record: MemoryRecord): Promise<void> {
    const records = await this.store.read();
    const next = records.filter((candidate) => candidate.id !== record.id);
    await this.store.write([...next, this.serialize(record)]);
  }

  /** Returns all structured memory records in local storage. */
  public async findAll(): Promise<readonly MemoryRecord[]> {
    return (await this.store.read()).map((record) => this.deserialize(record));
  }

  private serialize(record: MemoryRecord): StoredMemoryRecord {
    return {
      id: record.id,
      kind: record.kind,
      ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
      ...(record.task === undefined ? {} : { task: this.serializeTask(record.task.toSnapshot()) }),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private deserialize(record: StoredMemoryRecord): MemoryRecord {
    return {
      id: record.id,
      kind: record.kind,
      ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
      ...(record.task === undefined ? {} : { task: Task.rehydrate(this.deserializeTask(record.task)) }),
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
    };
  }

  private serializeTask(snapshot: TaskSnapshot): StoredTaskSnapshot {
    const { dueAt, source, createdAt, updatedAt, ...rest } = snapshot;
    return {
      ...rest,
      source: {
        ...source,
        occurredAt: source.occurredAt.toISOString(),
      },
      ...(dueAt === undefined ? {} : { dueAt: dueAt.toISOString() }),
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    };
  }

  private deserializeTask(record: StoredTaskSnapshot): TaskSnapshot {
    const { dueAt, source, createdAt, updatedAt, ...rest } = record;
    return {
      ...rest,
      source: {
        ...source,
        occurredAt: new Date(source.occurredAt),
      },
      ...(dueAt === undefined ? {} : { dueAt: new Date(dueAt) }),
      createdAt: new Date(createdAt),
      updatedAt: new Date(updatedAt),
    };
  }
}

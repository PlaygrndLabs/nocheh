import type { TaskRepositoryPort } from "../../application/ports/task-repository.js";
import { Task, type TaskId, type TaskSnapshot } from "../../domain/tasks/task.js";
import type { EncryptedJsonFileStore } from "./encrypted-json-file-store.js";

interface StoredTaskRecord extends Omit<TaskSnapshot, "createdAt" | "updatedAt" | "dueAt" | "source"> {
  readonly dueAt?: string;
  readonly source: Omit<TaskSnapshot["source"], "occurredAt"> & { readonly occurredAt: string };
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Local encrypted file-backed task repository. */
export class LocalTaskRepository implements TaskRepositoryPort {
  public constructor(private readonly store: EncryptedJsonFileStore<readonly StoredTaskRecord[]>) {}

  /** Saves or replaces a task in the local authoritative store. */
  public async save(task: Task): Promise<void> {
    const records = await this.store.read();
    const next = records.filter((record) => record.id !== task.id);
    await this.store.write([...next, this.serialize(task)]);
  }

  /** Finds a task by internal identifier. */
  public async findById(id: TaskId): Promise<Task | undefined> {
    const record = (await this.store.read()).find((candidate) => candidate.id === id);
    return record === undefined ? undefined : this.deserialize(record);
  }

  /** Returns tasks that are not completed or cancelled. */
  public async findOpen(): Promise<readonly Task[]> {
    return (await this.store.read())
      .filter((record) => record.status === "open" || record.status === "in_progress")
      .map((record) => this.deserialize(record));
  }

  private serialize(task: Task): StoredTaskRecord {
    const snapshot = task.toSnapshot();
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

  private deserialize(record: StoredTaskRecord): Task {
    const { dueAt, source, createdAt, updatedAt, ...rest } = record;
    return Task.rehydrate({
      ...rest,
      source: {
        ...source,
        occurredAt: new Date(source.occurredAt),
      },
      ...(dueAt === undefined ? {} : { dueAt: new Date(dueAt) }),
      createdAt: new Date(createdAt),
      updatedAt: new Date(updatedAt),
    });
  }
}

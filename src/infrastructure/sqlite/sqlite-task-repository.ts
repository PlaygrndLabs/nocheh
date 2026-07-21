import type { TaskRepositoryPort } from "../../application/ports/task-repository.js";
import { Task, type TaskId, type TaskSnapshot } from "../../domain/tasks/task.js";
import type { EncryptionPort } from "../../application/ports/encryption.js";
import type { SqliteDatabase } from "./sqlite-database.js";
import { EncryptedJsonCodec } from "./encrypted-json-codec.js";

interface TaskRow {
  readonly payload: string;
}

interface StoredTaskRecord extends Omit<TaskSnapshot, "createdAt" | "updatedAt" | "dueAt" | "source"> {
  readonly dueAt?: string;
  readonly source: Omit<TaskSnapshot["source"], "occurredAt"> & { readonly occurredAt: string };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class SqliteTaskRepository implements TaskRepositoryPort {
  private readonly codec: EncryptedJsonCodec;

  public constructor(
    private readonly database: SqliteDatabase,
    encryption: EncryptionPort,
  ) {
    this.codec = new EncryptedJsonCodec(encryption);
  }

  public async save(task: Task): Promise<void> {
    const record = this.serialize(task);
    const payload = await this.codec.encode(record);
    this.database.prepare(`
      INSERT INTO tasks (id, status, priority, due_at, created_at, updated_at, payload)
      VALUES (@id, @status, @priority, @dueAt, @createdAt, @updatedAt, @payload)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        priority = excluded.priority,
        due_at = excluded.due_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        payload = excluded.payload
    `).run({
      id: record.id,
      status: record.status,
      priority: record.priority,
      dueAt: record.dueAt ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      payload,
    });
  }

  public async findById(id: TaskId): Promise<Task | undefined> {
    const row = this.database.prepare("SELECT payload FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row === undefined ? undefined : this.deserialize(await this.codec.decode<StoredTaskRecord>(row.payload));
  }

  public async findOpen(): Promise<readonly Task[]> {
    const rows = this.database
      .prepare("SELECT payload FROM tasks WHERE status IN ('open', 'in_progress') ORDER BY updated_at ASC")
      .all() as TaskRow[];
    return Promise.all(rows.map(async (row) => this.deserialize(await this.codec.decode<StoredTaskRecord>(row.payload))));
  }

  public async findBySourceMessageId(messageId: string): Promise<readonly Task[]> {
    const rows = this.database.prepare("SELECT payload FROM tasks ORDER BY updated_at DESC").all() as TaskRow[];
    const tasks = await Promise.all(rows.map(async (row) => this.deserialize(await this.codec.decode<StoredTaskRecord>(row.payload))));
    return tasks.filter((task) => task.source.messageId === messageId);
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

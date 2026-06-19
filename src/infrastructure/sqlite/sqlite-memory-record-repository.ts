import type { MemoryRecordRepositoryPort } from "../../application/ports/memory-record-repository.js";
import type { EncryptionPort } from "../../application/ports/encryption.js";
import type {
  BlockerMemory,
  DeadlineMemory,
  DecisionMemory,
  MemoryRecord,
  MemoryRecordType,
  MemorySource,
  ProjectMemory,
  ProjectReference,
  SummaryMemory,
} from "../../domain/memory/memory-record.js";
import { Task, type TaskSnapshot } from "../../domain/tasks/task.js";
import { EncryptedJsonCodec } from "./encrypted-json-codec.js";
import type { SqliteDatabase } from "./sqlite-database.js";

interface MemoryRow {
  readonly payload: string;
}

interface StoredMemoryRecord {
  readonly id: string;
  readonly type: MemoryRecordType;
  readonly source: StoredMemorySource;
  readonly timestamp: string;
  readonly confidence: number;
  readonly project?: ProjectReference;
  readonly task?: StoredTaskSnapshot;
  readonly decision?: DecisionMemory;
  readonly projectMemory?: ProjectMemory;
  readonly deadline?: StoredDeadlineMemory;
  readonly blocker?: BlockerMemory;
  readonly summary?: SummaryMemory;
}

interface StoredMemorySource extends Omit<MemorySource, "occurredAt"> {
  readonly occurredAt: string;
}

interface StoredDeadlineMemory extends Omit<DeadlineMemory, "dueAt"> {
  readonly dueAt?: string;
}

interface StoredTaskSnapshot extends Omit<TaskSnapshot, "createdAt" | "updatedAt" | "dueAt" | "source"> {
  readonly dueAt?: string;
  readonly source: Omit<TaskSnapshot["source"], "occurredAt"> & { readonly occurredAt: string };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class SqliteMemoryRecordRepository implements MemoryRecordRepositoryPort {
  private readonly codec: EncryptedJsonCodec;

  public constructor(
    private readonly database: SqliteDatabase,
    encryption: EncryptionPort,
  ) {
    this.codec = new EncryptedJsonCodec(encryption);
  }

  public async save(record: MemoryRecord): Promise<void> {
    const stored = this.serialize(record);
    const payload = await this.codec.encode(stored);
    this.database.prepare(`
      INSERT INTO memory_records (id, type, project_id, timestamp, confidence, payload)
      VALUES (@id, @type, @projectId, @timestamp, @confidence, @payload)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        project_id = excluded.project_id,
        timestamp = excluded.timestamp,
        confidence = excluded.confidence,
        payload = excluded.payload
    `).run({
      id: stored.id,
      type: stored.type,
      projectId: stored.project?.id ?? null,
      timestamp: stored.timestamp,
      confidence: stored.confidence,
      payload,
    });
  }

  public async findAll(): Promise<readonly MemoryRecord[]> {
    return this.decodeRows(this.database.prepare("SELECT payload FROM memory_records ORDER BY timestamp ASC").all() as MemoryRow[]);
  }

  public async findByType(type: MemoryRecordType): Promise<readonly MemoryRecord[]> {
    return this.decodeRows(
      this.database.prepare("SELECT payload FROM memory_records WHERE type = ? ORDER BY timestamp ASC").all(type) as MemoryRow[],
    );
  }

  public async findByProjectId(projectId: string): Promise<readonly MemoryRecord[]> {
    return this.decodeRows(
      this.database.prepare("SELECT payload FROM memory_records WHERE project_id = ? ORDER BY timestamp ASC").all(projectId) as MemoryRow[],
    );
  }

  private async decodeRows(rows: readonly MemoryRow[]): Promise<readonly MemoryRecord[]> {
    return Promise.all(rows.map(async (row) => this.deserialize(await this.codec.decode<StoredMemoryRecord>(row.payload))));
  }

  private serialize(record: MemoryRecord): StoredMemoryRecord {
    return {
      id: record.id,
      type: record.type,
      source: this.serializeSource(record.source),
      timestamp: record.timestamp.toISOString(),
      confidence: record.confidence,
      ...(record.project === undefined ? {} : { project: record.project }),
      ...(record.task === undefined ? {} : { task: this.serializeTask(record.task.toSnapshot()) }),
      ...(record.decision === undefined ? {} : { decision: record.decision }),
      ...(record.projectMemory === undefined ? {} : { projectMemory: record.projectMemory }),
      ...(record.deadline === undefined ? {} : { deadline: this.serializeDeadline(record.deadline) }),
      ...(record.blocker === undefined ? {} : { blocker: record.blocker }),
      ...(record.summary === undefined ? {} : { summary: record.summary }),
    };
  }

  private deserialize(record: StoredMemoryRecord): MemoryRecord {
    const task = record.task === undefined ? undefined : Task.rehydrate(this.deserializeTask(record.task));
    return {
      id: record.id,
      type: record.type,
      source: this.deserializeSource(record.source),
      timestamp: new Date(record.timestamp),
      confidence: record.confidence,
      ...(record.project === undefined ? {} : { project: record.project }),
      ...(task === undefined ? {} : { task }),
      ...(record.decision === undefined ? {} : { decision: record.decision }),
      ...(record.projectMemory === undefined ? {} : { projectMemory: record.projectMemory }),
      ...(record.deadline === undefined ? {} : { deadline: this.deserializeDeadline(record.deadline) }),
      ...(record.blocker === undefined ? {} : { blocker: record.blocker }),
      ...(record.summary === undefined ? {} : { summary: record.summary }),
    };
  }

  private serializeSource(source: MemorySource): StoredMemorySource {
    return {
      ...source,
      occurredAt: source.occurredAt.toISOString(),
    };
  }

  private deserializeSource(source: StoredMemorySource): MemorySource {
    return {
      ...source,
      occurredAt: new Date(source.occurredAt),
    };
  }

  private serializeDeadline(deadline: DeadlineMemory): StoredDeadlineMemory {
    const { dueAt, ...rest } = deadline;
    return {
      ...rest,
      ...(dueAt === undefined ? {} : { dueAt: dueAt.toISOString() }),
    };
  }

  private deserializeDeadline(deadline: StoredDeadlineMemory): DeadlineMemory {
    const { dueAt, ...rest } = deadline;
    return {
      ...rest,
      ...(dueAt === undefined ? {} : { dueAt: new Date(dueAt) }),
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

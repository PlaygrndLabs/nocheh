import type { MemoryRecordRepositoryPort } from "../../application/ports/memory-record-repository.js";
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
import type { EncryptedJsonFileStore } from "./encrypted-json-file-store.js";

interface StoredMemoryRecord {
  readonly id: string;
  readonly type?: MemoryRecordType;
  readonly kind?: "task";
  readonly source?: StoredMemorySource;
  readonly timestamp?: string;
  readonly confidence?: number;
  readonly project?: ProjectReference;
  readonly projectId?: string;
  readonly task?: StoredTaskSnapshot;
  readonly decision?: DecisionMemory;
  readonly projectMemory?: ProjectMemory;
  readonly deadline?: StoredDeadlineMemory;
  readonly blocker?: BlockerMemory;
  readonly summary?: SummaryMemory;
  readonly createdAt?: string;
  readonly updatedAt?: string;
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

  /** Returns all records of one memory type. */
  public async findByType(type: MemoryRecordType): Promise<readonly MemoryRecord[]> {
    return (await this.findAll()).filter((record) => record.type === type);
  }

  /** Returns all records linked to a project. */
  public async findByProjectId(projectId: string): Promise<readonly MemoryRecord[]> {
    return (await this.findAll()).filter((record) => record.project?.id === projectId);
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
    const source = record.source === undefined
      ? task?.source ?? this.legacySource(record)
      : this.deserializeSource(record.source);
    const timestamp = new Date(record.timestamp ?? record.updatedAt ?? record.createdAt ?? source.occurredAt.toISOString());
    const type = record.type ?? (record.kind === "task" ? "Task" : "Summary");

    return {
      id: record.id,
      type,
      source,
      timestamp,
      confidence: record.confidence ?? 1,
      ...(record.project === undefined && record.projectId === undefined
        ? {}
        : { project: record.project ?? { id: record.projectId ?? "project:unknown", name: record.projectId ?? "Unknown" } }),
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

  private legacySource(record: StoredMemoryRecord): MemorySource {
    return {
      platform: "unknown",
      conversationId: "unknown",
      messageId: record.id,
      occurredAt: new Date(record.createdAt ?? record.updatedAt ?? new Date(0).toISOString()),
    };
  }
}

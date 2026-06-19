import type { AuditRepositoryPort } from "../../application/ports/audit-repository.js";
import type { EncryptionPort } from "../../application/ports/encryption.js";
import type {
  AuditedExtractedTask,
  ProcessingAuditRecord,
  ProcessingAuditStep,
} from "../../domain/observability/audit.js";
import type { TaskValidationWarning } from "../../domain/tasks/task-validation.js";
import { EncryptedJsonCodec } from "./encrypted-json-codec.js";
import type { SqliteDatabase } from "./sqlite-database.js";

interface AuditRow {
  readonly payload: string;
}

interface StoredAuditRecord extends Omit<ProcessingAuditRecord, "receivedAt" | "processedAt" | "steps" | "extractedTasks"> {
  readonly receivedAt: string;
  readonly processedAt: string;
  readonly steps: readonly StoredAuditStep[];
  readonly extractedTasks: readonly StoredAuditedExtractedTask[];
}

interface StoredAuditStep extends Omit<ProcessingAuditStep, "startedAt" | "completedAt"> {
  readonly startedAt: string;
  readonly completedAt: string;
}

interface StoredAuditedExtractedTask extends Omit<AuditedExtractedTask, "processingTimestamp" | "warnings"> {
  readonly processingTimestamp: string;
  readonly warnings: readonly TaskValidationWarning[];
}

export class SqliteAuditRepository implements AuditRepositoryPort {
  private readonly codec: EncryptedJsonCodec;

  public constructor(
    private readonly database: SqliteDatabase,
    encryption: EncryptionPort,
  ) {
    this.codec = new EncryptedJsonCodec(encryption);
  }

  public async save(record: ProcessingAuditRecord): Promise<void> {
    const stored = this.serialize(record);
    const payload = await this.codec.encode(stored);
    this.database.prepare(`
      INSERT INTO audit_records (id, received_at, processed_at, payload)
      VALUES (@id, @receivedAt, @processedAt, @payload)
      ON CONFLICT(id) DO UPDATE SET
        received_at = excluded.received_at,
        processed_at = excluded.processed_at,
        payload = excluded.payload
    `).run({
      id: stored.id,
      receivedAt: stored.receivedAt,
      processedAt: stored.processedAt,
      payload,
    });
  }

  public async findRecent(limit: number): Promise<readonly ProcessingAuditRecord[]> {
    const rows = this.database
      .prepare("SELECT payload FROM audit_records ORDER BY processed_at DESC LIMIT ?")
      .all(limit) as AuditRow[];
    return Promise.all(rows.map(async (row) => this.deserialize(await this.codec.decode<StoredAuditRecord>(row.payload))));
  }

  private serialize(record: ProcessingAuditRecord): StoredAuditRecord {
    return {
      ...record,
      receivedAt: record.receivedAt.toISOString(),
      processedAt: record.processedAt.toISOString(),
      steps: record.steps.map((step) => ({
        ...step,
        startedAt: step.startedAt.toISOString(),
        completedAt: step.completedAt.toISOString(),
      })),
      extractedTasks: record.extractedTasks.map((task) => ({
        ...task,
        processingTimestamp: task.processingTimestamp.toISOString(),
      })),
    };
  }

  private deserialize(record: StoredAuditRecord): ProcessingAuditRecord {
    return {
      ...record,
      receivedAt: new Date(record.receivedAt),
      processedAt: new Date(record.processedAt),
      steps: record.steps.map((step) => ({
        ...step,
        startedAt: new Date(step.startedAt),
        completedAt: new Date(step.completedAt),
      })),
      extractedTasks: record.extractedTasks.map((task) => ({
        ...task,
        processingTimestamp: new Date(task.processingTimestamp),
      })),
    };
  }
}

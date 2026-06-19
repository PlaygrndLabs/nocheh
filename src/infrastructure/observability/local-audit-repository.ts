import type { AuditRepositoryPort } from "../../application/ports/audit-repository.js";
import type {
  AuditedExtractedTask,
  ProcessingAuditRecord,
  ProcessingAuditStep,
} from "../../domain/observability/audit.js";
import type { TaskValidationWarning } from "../../domain/tasks/task-validation.js";
import type { EncryptedJsonFileStore } from "../memory/encrypted-json-file-store.js";

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

/** Local encrypted file-backed audit trail repository. */
export class LocalAuditRepository implements AuditRepositoryPort {
  public constructor(private readonly store: EncryptedJsonFileStore<readonly StoredAuditRecord[]>) {}

  /** Saves or replaces a processing audit record. */
  public async save(record: ProcessingAuditRecord): Promise<void> {
    const records = await this.store.read();
    const next = records.filter((candidate) => candidate.id !== record.id);
    await this.store.write([...next, this.serialize(record)]);
  }

  /** Returns recent audit records ordered newest first. */
  public async findRecent(limit: number): Promise<readonly ProcessingAuditRecord[]> {
    return (await this.store.read())
      .slice()
      .sort((left, right) => Date.parse(right.processedAt) - Date.parse(left.processedAt))
      .slice(0, limit)
      .map((record) => this.deserialize(record));
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

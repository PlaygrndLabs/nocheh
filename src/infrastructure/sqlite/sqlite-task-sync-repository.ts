import type { ExternalTask } from "../../application/ports/task-provider.js";
import type { TaskSyncRepositoryPort } from "../../application/ports/task-sync-repository.js";
import type { EncryptionPort } from "../../application/ports/encryption.js";
import type { TaskId } from "../../domain/tasks/task.js";
import { EncryptedJsonCodec } from "./encrypted-json-codec.js";
import type { SqliteDatabase } from "./sqlite-database.js";

interface TaskSyncRow {
  readonly payload: string;
}

export class SqliteTaskSyncRepository implements TaskSyncRepositoryPort {
  private readonly codec: EncryptedJsonCodec;

  public constructor(
    private readonly database: SqliteDatabase,
    encryption: EncryptionPort,
  ) {
    this.codec = new EncryptedJsonCodec(encryption);
  }

  public async findByTaskId(taskId: TaskId): Promise<ExternalTask | undefined> {
    const row = this.database.prepare("SELECT payload FROM task_sync WHERE task_id = ?").get(taskId) as TaskSyncRow | undefined;
    return row === undefined ? undefined : this.codec.decode<ExternalTask>(row.payload);
  }

  public async save(externalTask: ExternalTask): Promise<void> {
    const payload = await this.codec.encode(externalTask);
    this.database.prepare(`
      INSERT INTO task_sync (task_id, provider, external_id, payload)
      VALUES (@taskId, @provider, @externalId, @payload)
      ON CONFLICT(task_id) DO UPDATE SET
        provider = excluded.provider,
        external_id = excluded.external_id,
        payload = excluded.payload
    `).run({ ...externalTask, payload });
  }
}

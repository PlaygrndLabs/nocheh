import type { ExternalTask } from "../../application/ports/task-provider.js";
import type { TaskSyncRepositoryPort } from "../../application/ports/task-sync-repository.js";
import type { TaskId } from "../../domain/tasks/task.js";
import type { EncryptedJsonFileStore } from "./encrypted-json-file-store.js";

/** Local encrypted repository for task-provider sync mappings. */
export class LocalTaskSyncRepository implements TaskSyncRepositoryPort {
  public constructor(private readonly store: EncryptedJsonFileStore<readonly ExternalTask[]>) {}

  /** Finds provider sync state by internal task identifier. */
  public async findByTaskId(taskId: TaskId): Promise<ExternalTask | undefined> {
    return (await this.store.read()).find((record) => record.taskId === taskId);
  }

  /** Saves or replaces a provider sync mapping. */
  public async save(externalTask: ExternalTask): Promise<void> {
    const records = await this.store.read();
    const next = records.filter((record) => record.taskId !== externalTask.taskId);
    await this.store.write([...next, externalTask]);
  }
}

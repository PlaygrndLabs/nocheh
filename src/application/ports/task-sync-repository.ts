import type { TaskId } from "../../domain/tasks/task.js";
import type { ExternalTask } from "./task-provider.js";

/** Persists mapping between internal tasks and external task-provider records. */
export interface TaskSyncRepositoryPort {
  findByTaskId(taskId: TaskId): Promise<ExternalTask | undefined>;
  save(externalTask: ExternalTask): Promise<void>;
}

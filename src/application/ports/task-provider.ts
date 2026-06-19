import type { Task, TaskId } from "../../domain/tasks/task.js";

/** External provider state for a synchronized task. */
export interface ExternalTask {
  readonly provider: string;
  readonly externalId: string;
  readonly taskId: TaskId;
}

/** Synchronizes internal tasks to an external task provider such as Notion. */
export interface TaskProviderPort {
  upsertTask(task: Task, existing?: ExternalTask): Promise<ExternalTask>;
}

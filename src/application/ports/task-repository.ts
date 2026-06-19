import type { Task, TaskId } from "../../domain/tasks/task.js";

/** Stores internal tasks as the authoritative local state. */
export interface TaskRepositoryPort {
  save(task: Task): Promise<void>;
  findById(id: TaskId): Promise<Task | undefined>;
  findOpen(): Promise<readonly Task[]>;
}

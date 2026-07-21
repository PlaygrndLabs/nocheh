import type { Task, TaskId } from "../../domain/tasks/task.js";

/** Stores internal tasks as the authoritative local state. */
export interface TaskRepositoryPort {
  save(task: Task): Promise<void>;
  findById(id: TaskId): Promise<Task | undefined>;
  findOpen(): Promise<readonly Task[]>;
  /** Finds tasks whose source message matches the given id (used to link reactions to prior tasks). */
  findBySourceMessageId(messageId: string): Promise<readonly Task[]>;
}

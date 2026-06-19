import { randomUUID } from "node:crypto";

/** Stable internal task identifier. */
export type TaskId = string;

/** Task lifecycle status owned by the domain. */
export type TaskStatus = "open" | "in_progress" | "completed" | "cancelled";

/** Priority used for local ranking and external task sync. */
export type TaskPriority = "low" | "medium" | "high" | "urgent";

/** Reference to the sanitized origin that caused a domain object to exist. */
export interface SourceReference {
  readonly platform: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly occurredAt: Date;
}

/** Input required to create a task. */
export interface CreateTaskInput {
  readonly title: string;
  readonly description?: string;
  readonly dueAt?: Date;
  readonly assignee?: string;
  readonly priority?: TaskPriority;
  readonly source: SourceReference;
}

/** Serialized task shape used by repositories to rehydrate domain entities. */
export interface TaskSnapshot {
  readonly id: TaskId;
  readonly title: string;
  readonly description?: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly dueAt?: Date;
  readonly assignee?: string;
  readonly source: SourceReference;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Domain entity representing an actionable item extracted from conversation. */
export class Task {
  private constructor(
    public readonly id: TaskId,
    public readonly title: string,
    public readonly description: string | undefined,
    public readonly status: TaskStatus,
    public readonly priority: TaskPriority,
    public readonly dueAt: Date | undefined,
    public readonly assignee: string | undefined,
    public readonly source: SourceReference,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}

  /** Creates a new open task after enforcing core task invariants. */
  public static create(input: CreateTaskInput, now: Date = new Date()): Task {
    const title = input.title.trim();
    if (title.length < 3) {
      throw new Error("Task title must contain at least 3 characters.");
    }

    return new Task(
      randomUUID(),
      title,
      input.description?.trim() || undefined,
      "open",
      input.priority ?? "medium",
      input.dueAt,
      input.assignee?.trim() || undefined,
      input.source,
      now,
      now,
    );
  }

  /** Rehydrates a task from trusted repository data. */
  public static rehydrate(snapshot: TaskSnapshot): Task {
    return new Task(
      snapshot.id,
      snapshot.title,
      snapshot.description,
      snapshot.status,
      snapshot.priority,
      snapshot.dueAt,
      snapshot.assignee,
      snapshot.source,
      snapshot.createdAt,
      snapshot.updatedAt,
    );
  }

  /** Converts this task into a persistence-safe snapshot. */
  public toSnapshot(): TaskSnapshot {
    const snapshot: TaskSnapshot = {
      id: this.id,
      title: this.title,
      status: this.status,
      priority: this.priority,
      source: this.source,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };

    return {
      ...snapshot,
      ...(this.description === undefined ? {} : { description: this.description }),
      ...(this.dueAt === undefined ? {} : { dueAt: this.dueAt }),
      ...(this.assignee === undefined ? {} : { assignee: this.assignee }),
    };
  }

  /** Returns a copy with a new external sync-friendly status. */
  public withStatus(status: TaskStatus, now: Date = new Date()): Task {
    return new Task(
      this.id,
      this.title,
      this.description,
      status,
      this.priority,
      this.dueAt,
      this.assignee,
      this.source,
      this.createdAt,
      now,
    );
  }
}

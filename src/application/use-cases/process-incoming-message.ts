import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "../dto/incoming-message.js";
import type { ClockPort } from "../ports/clock.js";
import type { LoggerPort } from "../ports/logger.js";
import type { MemoryRecordRepositoryPort } from "../ports/memory-record-repository.js";
import type { SecretDetectorPort } from "../ports/secret-detector.js";
import type { TaskExtractorPort } from "../ports/task-extractor.js";
import type { TaskProviderPort } from "../ports/task-provider.js";
import type { TaskRepositoryPort } from "../ports/task-repository.js";
import type { TaskSyncRepositoryPort } from "../ports/task-sync-repository.js";
import { TaskCandidatePolicy } from "../../domain/tasks/task-extraction.js";
import { Task } from "../../domain/tasks/task.js";

/** Result of processing one incoming message through the Phase 1 pipeline. */
export interface ProcessIncomingMessageResult {
  readonly createdTaskIds: readonly string[];
  readonly redactedFindingCount: number;
}

/** Coordinates redaction, extraction, local persistence, and basic task sync. */
export class ProcessIncomingMessageUseCase {
  private readonly candidatePolicy = new TaskCandidatePolicy();

  public constructor(
    private readonly secretDetector: SecretDetectorPort,
    private readonly taskExtractor: TaskExtractorPort,
    private readonly taskRepository: TaskRepositoryPort,
    private readonly memoryRecordRepository: MemoryRecordRepositoryPort,
    private readonly taskSyncRepository: TaskSyncRepositoryPort,
    private readonly taskProvider: TaskProviderPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
  ) {}

  /** Processes a platform-neutral message without persisting raw message text. */
  public async execute(message: IncomingMessage): Promise<ProcessIncomingMessageResult> {
    const redacted = this.secretDetector.redact(message.text);
    const sanitizedMessage: IncomingMessage = {
      ...message,
      text: redacted.text,
    };

    const candidates = await this.taskExtractor.extractTasks(sanitizedMessage);
    const actionable = this.candidatePolicy.actionable(candidates);
    const createdTaskIds: string[] = [];

    for (const candidate of actionable) {
      const task = Task.create(
        {
          ...candidate,
          source: {
            platform: message.platform,
            conversationId: message.conversationId,
            messageId: message.messageId,
            occurredAt: message.occurredAt,
          },
        },
        this.clock.now(),
      );

      await this.taskRepository.save(task);
      await this.memoryRecordRepository.save({
        id: randomUUID(),
        kind: "task",
        task,
        createdAt: this.clock.now(),
        updatedAt: this.clock.now(),
      });
      const existing = await this.taskSyncRepository.findByTaskId(task.id);
      const external = await this.taskProvider.upsertTask(task, existing);
      await this.taskSyncRepository.save(external);
      createdTaskIds.push(task.id);
    }

    this.logger.info("Processed incoming message", {
      platform: message.platform,
      conversationId: message.conversationId,
      messageId: message.messageId,
      createdTaskCount: createdTaskIds.length,
      redactedFindingCount: redacted.findings.length,
    });

    return {
      createdTaskIds,
      redactedFindingCount: redacted.findings.length,
    };
  }
}

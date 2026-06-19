import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "../dto/incoming-message.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.js";
import { NoopAuditRepository } from "../ports/audit-repository.js";
import type { ClockPort } from "../ports/clock.js";
import type { LoggerPort } from "../ports/logger.js";
import type { ExtractedMemoryCandidate, MemoryExtractorPort } from "../ports/memory-extractor.js";
import { NoopMemoryExtractor } from "../ports/memory-extractor.js";
import type { MemoryRecordRepositoryPort } from "../ports/memory-record-repository.js";
import type { MetricsCollectorPort } from "../ports/metrics.js";
import { NoopMetricsCollector } from "../ports/metrics.js";
import type { SecretDetectorPort } from "../ports/secret-detector.js";
import type { TaskExtractorPort } from "../ports/task-extractor.js";
import type { TaskProviderPort } from "../ports/task-provider.js";
import type { TaskRepositoryPort } from "../ports/task-repository.js";
import type { TaskSyncRepositoryPort } from "../ports/task-sync-repository.js";
import { Task } from "../../domain/tasks/task.js";
import type { MemoryRecord } from "../../domain/memory/memory-record.js";
import type { AuditedExtractedTask, ProcessingAuditStep, ProcessingStepName, ProcessingStepStatus } from "../../domain/observability/audit.js";
import { TaskValidationService } from "../../domain/tasks/task-validation.js";

/** Result of processing one incoming message through the Phase 1 pipeline. */
export interface ProcessIncomingMessageResult {
  readonly createdTaskIds: readonly string[];
  readonly createdMemoryRecordIds: readonly string[];
  readonly redactedFindingCount: number;
  readonly validationWarningCount: number;
  readonly failedSyncCount: number;
}

/** Coordinates redaction, extraction, local persistence, and basic task sync. */
export class ProcessIncomingMessageUseCase {
  private readonly validationService = new TaskValidationService();

  public constructor(
    private readonly secretDetector: SecretDetectorPort,
    private readonly taskExtractor: TaskExtractorPort,
    private readonly taskRepository: TaskRepositoryPort,
    private readonly memoryRecordRepository: MemoryRecordRepositoryPort,
    private readonly taskSyncRepository: TaskSyncRepositoryPort,
    private readonly taskProvider: TaskProviderPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly auditRepository: AuditRepositoryPort = new NoopAuditRepository(),
    private readonly metrics: MetricsCollectorPort = new NoopMetricsCollector(),
    private readonly memoryExtractor: MemoryExtractorPort = new NoopMemoryExtractor(),
  ) {}

  /** Processes a platform-neutral message without persisting raw message text. */
  public async execute(message: IncomingMessage): Promise<ProcessIncomingMessageResult> {
    const startedAt = this.clock.now();
    const steps: ProcessingAuditStep[] = [];
    const errorLogs: string[] = [];
    const extractedTasks: AuditedExtractedTask[] = [];
    const createdTaskIds: string[] = [];
    const createdMemoryRecordIds: string[] = [];
    let failedSyncCount = 0;

    steps.push(step("telegram_message", "succeeded", startedAt, this.clock.now(), {
      platform: message.platform,
      conversationId: message.conversationId,
      messageId: message.messageId,
    }));

    const secretDetectionStartedAt = this.clock.now();
    const redacted = this.secretDetector.redact(message.text);
    steps.push(step("secret_detection", "succeeded", secretDetectionStartedAt, this.clock.now(), {
      findingCount: redacted.findings.length,
    }));
    steps.push(step("redaction", "succeeded", secretDetectionStartedAt, this.clock.now(), {
      redacted: redacted.findings.length > 0,
      previewLength: preview(redacted.text).length,
    }));
    this.metrics.recordRedactionEvents(redacted.findings.length);

    const sanitizedMessage: IncomingMessage = {
      ...message,
      text: redacted.text,
    };

    const memoryExtractionStartedAt = this.clock.now();
    const memoryCandidates = await this.memoryExtractor.extractMemory(sanitizedMessage);
    steps.push(step("memory_extraction", "succeeded", memoryExtractionStartedAt, this.clock.now(), {
      candidateCount: memoryCandidates.length,
    }));

    const persistenceStartedAt = this.clock.now();
    for (const candidate of memoryCandidates) {
      const record = this.createMemoryRecord(candidate, sanitizedMessage);
      await this.memoryRecordRepository.save(record);
      createdMemoryRecordIds.push(record.id);
    }
    steps.push(step("memory_persistence", "succeeded", persistenceStartedAt, this.clock.now(), {
      recordCount: memoryCandidates.length,
    }));

    const extractionStartedAt = this.clock.now();
    const candidates = await this.taskExtractor.extractTasks(sanitizedMessage);
    steps.push(step("task_extraction", "succeeded", extractionStartedAt, this.clock.now(), {
      candidateCount: candidates.length,
    }));
    this.metrics.recordTasksExtracted(candidates.length);
    this.metrics.recordExtractionOutcome(candidates.length > 0);
    for (const candidate of candidates) {
      this.metrics.recordConfidence(candidate.confidence);
    }

    const validationStartedAt = this.clock.now();
    const existingTasks = await this.taskRepository.findOpen();
    const validationResults = this.validationService.validate(candidates, existingTasks, message.occurredAt);
    const validationWarnings = validationResults.flatMap((result) => result.warnings);
    steps.push(step("validation", "succeeded", validationStartedAt, this.clock.now(), {
      acceptedCount: validationResults.filter((result) => result.accepted).length,
      warningCount: validationWarnings.length,
    }));

    for (const validationResult of validationResults) {
      extractedTasks.push({
        title: validationResult.candidate.title.trim(),
        confidence: validationResult.candidate.confidence,
        extractionReason: validationResult.candidate.extractionReason,
        sourceMessageId: message.messageId,
        processingTimestamp: this.clock.now(),
        accepted: validationResult.accepted,
        warnings: validationResult.warnings,
        syncStatus: "not_attempted",
      });
    }

    for (const validationResult of validationResults.filter((result) => result.accepted)) {
      const candidate = validationResult.candidate;
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

      const persistenceStartedAt = this.clock.now();
      await this.taskRepository.save(task);
      const project = primaryProject(memoryCandidates);
      const taskMemoryRecord: MemoryRecord = {
        id: randomUUID(),
        type: "Task",
        source: task.source,
        timestamp: this.clock.now(),
        confidence: candidate.confidence,
        ...(project === undefined ? {} : { project }),
        task,
      };
      await this.memoryRecordRepository.save(taskMemoryRecord);
      createdMemoryRecordIds.push(taskMemoryRecord.id);
      steps.push(step("persistence", "succeeded", persistenceStartedAt, this.clock.now(), {
        taskId: task.id,
      }));

      const auditedTaskIndex = extractedTasks.findIndex((candidateTask) =>
        candidateTask.sourceMessageId === message.messageId
        && candidateTask.title === candidate.title.trim()
        && candidateTask.confidence === candidate.confidence
        && candidateTask.taskId === undefined,
      );
      if (auditedTaskIndex >= 0) {
        const auditedTask = extractedTasks[auditedTaskIndex];
        if (auditedTask === undefined) {
          throw new Error("Audit task index was out of bounds.");
        }
        extractedTasks[auditedTaskIndex] = {
          ...auditedTask,
          taskId: task.id,
        };
      }

      const existing = await this.taskSyncRepository.findByTaskId(task.id);
      const syncStartedAt = this.clock.now();
      try {
        const external = await this.taskProvider.upsertTask(task, existing);
        await this.taskSyncRepository.save(external);
        this.metrics.recordSyncOutcome(true);
        steps.push(step("notion_sync", "succeeded", syncStartedAt, this.clock.now(), {
          taskId: task.id,
          provider: external.provider,
          externalId: external.externalId,
        }));
        if (auditedTaskIndex >= 0) {
          const auditedTask = extractedTasks[auditedTaskIndex];
          if (auditedTask === undefined) {
            throw new Error("Audit task index was out of bounds.");
          }
          extractedTasks[auditedTaskIndex] = {
            ...auditedTask,
            taskId: task.id,
            syncStatus: "succeeded",
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        failedSyncCount += 1;
        this.metrics.recordSyncOutcome(false);
        errorLogs.push(`Notion sync failed for task ${task.id}: ${errorMessage}`);
        steps.push(step("notion_sync", "failed", syncStartedAt, this.clock.now(), {
          taskId: task.id,
        }, errorMessage));
        if (auditedTaskIndex >= 0) {
          const auditedTask = extractedTasks[auditedTaskIndex];
          if (auditedTask === undefined) {
            throw new Error("Audit task index was out of bounds.");
          }
          extractedTasks[auditedTaskIndex] = {
            ...auditedTask,
            taskId: task.id,
            syncStatus: "failed",
            syncError: errorMessage,
          };
        }
      }
      createdTaskIds.push(task.id);
    }

    const completedAt = this.clock.now();
    const latencyMs = completedAt.getTime() - startedAt.getTime();
    this.metrics.recordMessageProcessed(latencyMs);
    await this.auditRepository.save({
      id: randomUUID(),
      platform: message.platform,
      conversationId: message.conversationId,
      messageId: message.messageId,
      senderId: message.senderId,
      receivedAt: message.occurredAt,
      processedAt: completedAt,
      redactedContentPreview: preview(redacted.text),
      redactionFindingCount: redacted.findings.length,
      steps,
      extractedTasks,
      errorLogs,
      totalLatencyMs: latencyMs,
    });

    this.logger.info("Processed incoming message", {
      platform: message.platform,
      conversationId: message.conversationId,
      messageId: message.messageId,
      createdTaskCount: createdTaskIds.length,
      redactedFindingCount: redacted.findings.length,
      validationWarningCount: validationWarnings.length,
      failedSyncCount,
    });

    return {
      createdTaskIds,
      createdMemoryRecordIds,
      redactedFindingCount: redacted.findings.length,
      validationWarningCount: validationWarnings.length,
      failedSyncCount,
    };
  }

  private createMemoryRecord(candidate: ExtractedMemoryCandidate, message: IncomingMessage): MemoryRecord {
    return {
      id: randomUUID(),
      type: candidate.type,
      source: sourceFrom(message),
      timestamp: this.clock.now(),
      confidence: candidate.confidence,
      ...(candidate.project === undefined ? {} : { project: candidate.project }),
      ...memoryPayload(candidate),
    };
  }
}

function primaryProject(candidates: readonly ExtractedMemoryCandidate[]) {
  return candidates.find((candidate) => candidate.project !== undefined)?.project;
}

function sourceFrom(message: IncomingMessage) {
  return {
    platform: message.platform,
    conversationId: message.conversationId,
    messageId: message.messageId,
    occurredAt: message.occurredAt,
  };
}

function memoryPayload(candidate: ExtractedMemoryCandidate) {
  switch (candidate.type) {
    case "Decision":
      return { decision: candidate.decision };
    case "Project":
      return { projectMemory: candidate.projectMemory };
    case "Deadline":
      return { deadline: candidate.deadline };
    case "Blocker":
      return { blocker: candidate.blocker };
    case "Summary":
      return { summary: candidate.summary };
  }
}

function step(
  name: ProcessingStepName,
  status: ProcessingStepStatus,
  startedAt: Date,
  completedAt: Date,
  metadata: Record<string, string | number | boolean | null>,
  errorMessage?: string,
): ProcessingAuditStep {
  return {
    name,
    status,
    startedAt,
    completedAt,
    durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    metadata,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

function preview(text: string, maxLength = 240): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}...`;
}

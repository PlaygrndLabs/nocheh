import type { ConversationWindow } from "../dto/conversation-window.js";
import { singleMessageWindow, windowAnchor } from "../dto/conversation-window.js";
import type { IncomingMessage } from "../dto/incoming-message.js";
import type { IncomingReactionEvent } from "../dto/incoming-reaction-event.js";
import type { NoteInput } from "../dto/incoming-note.js";
import type { AuditRepositoryPort } from "../ports/audit-repository.js";
import { NoopAuditRepository } from "../ports/audit-repository.js";
import type { ClockPort } from "../ports/clock.js";
import type { IdGeneratorPort } from "../ports/id-generator.js";
import { SystemIdGenerator } from "../ports/id-generator.js";
import type { LoggerPort } from "../ports/logger.js";
import type {
  AnalysisCandidateTarget,
  AnalyzedStatusUpdate,
  AnalyzedTaskCandidate,
  ConversationAnalysisInput,
  MemoryGraphAnalyzerPort,
} from "../ports/memory-graph-analyzer.js";
import type { MemoryGraphRepositoryPort } from "../ports/memory-graph-repository.js";
import type { ExtractedMemoryCandidate } from "../ports/memory-extractor.js";
import type { MemoryRecordRepositoryPort } from "../ports/memory-record-repository.js";
import type { MetricsCollectorPort } from "../ports/metrics.js";
import { NoopMetricsCollector } from "../ports/metrics.js";
import type { SecretDetectorPort } from "../ports/secret-detector.js";
import type { SuggestionRepositoryPort } from "../ports/suggestion-repository.js";
import type { TaskProviderPort } from "../ports/task-provider.js";
import type { TaskRepositoryPort } from "../ports/task-repository.js";
import type { TaskSyncRepositoryPort } from "../ports/task-sync-repository.js";
import type { MediaUnderstandingService } from "../services/media-understanding-service.js";
import { WindowRedactionService, type WindowRedactionResult } from "../services/window-redaction-service.js";
import { describeAttachment } from "../../domain/messaging/message-attachment.js";
import { Task } from "../../domain/tasks/task.js";
import type { SourceReference } from "../../domain/tasks/task.js";
import { createMemoryEdge, createMemoryNode, type MemoryEdge } from "../../domain/memory/memory-graph.js";
import type { MemoryRecord } from "../../domain/memory/memory-record.js";
import type { AiTokenUsage, AuditedExtractedTask, ProcessingAuditStep, ProcessingStepName, ProcessingStepStatus } from "../../domain/observability/audit.js";
import { TaskValidationService } from "../../domain/tasks/task-validation.js";

/** Result of processing one conversation window through the pipeline. */
export interface ProcessIncomingMessageResult {
  readonly createdTaskIds: readonly string[];
  readonly createdMemoryRecordIds: readonly string[];
  readonly redactedFindingCount: number;
  readonly validationWarningCount: number;
  readonly failedSyncCount: number;
  readonly createdMemoryGraphNodeIds: readonly string[];
  readonly createdMemoryGraphEdgeIds: readonly string[];
  readonly createdSuggestionIds: readonly string[];
  readonly statusUpdateCount: number;
}

/** Coordinates redaction, LLM analysis, local persistence, and basic task sync over a conversation window. */
export class ProcessIncomingMessageUseCase {
  private readonly validationService = new TaskValidationService();
  private readonly windowRedaction: WindowRedactionService;

  public constructor(
    /** The pre-analysis secret gate. Wrapped in a WindowRedactionService, not used directly. */
    secretDetector: SecretDetectorPort,
    private readonly memoryGraphAnalyzer: MemoryGraphAnalyzerPort,
    private readonly taskRepository: TaskRepositoryPort,
    private readonly memoryRecordRepository: MemoryRecordRepositoryPort,
    private readonly taskSyncRepository: TaskSyncRepositoryPort,
    private readonly taskProvider: TaskProviderPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly auditRepository: AuditRepositoryPort = new NoopAuditRepository(),
    private readonly metrics: MetricsCollectorPort = new NoopMetricsCollector(),
    private readonly memoryGraphRepository?: MemoryGraphRepositoryPort,
    private readonly suggestionRepository?: SuggestionRepositoryPort,
    private readonly idGenerator: IdGeneratorPort = new SystemIdGenerator(),
    /** Absent when no perception model is configured: attachments then stay undescribed. */
    private readonly mediaUnderstanding?: MediaUnderstandingService,
  ) {
    this.windowRedaction = new WindowRedactionService(secretDetector);
  }

  /** Immediate-mode entry point: processes a single message as a one-message window. */
  public async execute(message: IncomingMessage): Promise<ProcessIncomingMessageResult> {
    return this.executeWindow(singleMessageWindow(message));
  }

  /** Batch-mode entry point: processes an ordered conversation window in a single analysis pass. */
  public async executeWindow(window: ConversationWindow): Promise<ProcessIncomingMessageResult> {
    return this.processWindow(window, { analysisStepName: "analysis" });
  }

  /**
   * Processes a manual note from Mak: an authoritative instruction that updates knowledge,
   * outside ordinary group chatter. Open tasks are offered as candidate targets so the note
   * can also correct or close them.
   */
  public async executeNote(input: NoteInput): Promise<ProcessIncomingMessageResult> {
    const occurredAt = input.occurredAt ?? this.clock.now();
    const conversationId = input.conversationId.trim().length > 0 ? input.conversationId : "notes";
    const message: IncomingMessage = {
      platform: "note",
      conversationId,
      messageId: `note:${this.idGenerator.generate()}`,
      senderId: input.authorId ?? "mak",
      ...(input.authorDisplayName === undefined ? {} : { senderDisplayName: input.authorDisplayName }),
      text: input.text,
      occurredAt,
    };
    const window: ConversationWindow = {
      platform: "note",
      conversationId,
      messages: [message],
      note: input.text,
    };
    const candidateTargets = await this.openTaskTargets();
    return this.processWindow(window, { analysisStepName: "note_analysis", candidateTargets });
  }

  private async openTaskTargets(): Promise<readonly AnalysisCandidateTarget[]> {
    const openTasks = await this.taskRepository.findOpen();
    return openTasks.map((task) => ({
      sourceMessageId: task.source.messageId,
      kind: "task" as const,
      id: task.id,
      label: task.title,
      status: task.status,
    }));
  }

  private async processWindow(
    window: ConversationWindow,
    options: { readonly analysisStepName: ProcessingStepName; readonly candidateTargets?: readonly AnalysisCandidateTarget[] },
  ): Promise<ProcessIncomingMessageResult> {
    const startedAt = this.clock.now();
    const steps: ProcessingAuditStep[] = [];
    const errorLogs: string[] = [];
    const extractedTasks: AuditedExtractedTask[] = [];
    const createdTaskIds: string[] = [];
    const createdMemoryRecordIds: string[] = [];
    const createdMemoryGraphNodeIds: string[] = [];
    const createdMemoryGraphEdgeIds: string[] = [];
    const createdSuggestionIds: string[] = [];
    let failedSyncCount = 0;

    const anchor = windowAnchor(window);
    if (anchor === undefined) {
      throw new Error("Cannot process an empty conversation window.");
    }
    const anchorMessageId = window.messages.length === 1
      ? anchor.messageId
      : `batch:${window.messages[0]?.messageId}-${anchor.messageId}`;

    steps.push(step("telegram_message", "succeeded", startedAt, this.clock.now(), {
      platform: window.platform,
      conversationId: window.conversationId,
      messageId: anchorMessageId,
      messageCount: window.messages.length,
    }));

    // Media becomes text before anything else looks at the window, because the
    // redaction and analysis steps below only understand text.
    const understoodWindow = await this.understandMedia(window, steps, errorLogs);

    const secretDetectionStartedAt = this.clock.now();
    // Covers message text plus every attachment description and transcript: derived
    // media text can carry a secret just as easily as a typed message.
    let redaction: WindowRedactionResult;
    try {
      redaction = await this.windowRedaction.execute(understoodWindow);
    } catch (error) {
      // Fail closed: the guard is what makes it safe to send this window onward, so
      // without it nothing is sent. The caller keeps the window buffered and retries.
      const message = error instanceof Error ? error.message : String(error);
      steps.push(step("secret_detection", "failed", secretDetectionStartedAt, this.clock.now(), {
        messageCount: understoodWindow.messages.length,
      }, message));
      steps.push(step("redaction", "skipped", secretDetectionStartedAt, this.clock.now(), {
        reason: "secret detection failed",
      }));
      errorLogs.push(`Secret detection failed: ${message}`);
      // Audited before rethrowing, so a stalled window is visible instead of silent.
      await this.saveAudit({
        anchor,
        anchorMessageId,
        window: understoodWindow,
        startedAt,
        steps,
        extractedTasks,
        errorLogs,
        redactedContentPreview: "(withheld: secret detection failed)",
        redactionFindingCount: 0,
      });
      this.logger.error("Secret detection failed; window not analysed.", {
        conversationId: window.conversationId,
        messageId: anchorMessageId,
        error: message,
      });
      throw error;
    }

    const sanitizedWindow = redaction.window;
    const sanitizedMessages = sanitizedWindow.messages;
    const redactionFindingCount = redaction.findingCount;
    steps.push(step("secret_detection", "succeeded", secretDetectionStartedAt, this.clock.now(), {
      findingCount: redactionFindingCount,
      segmentCount: redaction.segmentCount,
      ...Object.fromEntries(Object.entries(redaction.findingKinds).map(([kind, count]) => [`found_${kind}`, count])),
    }));
    steps.push(step("redaction", "succeeded", secretDetectionStartedAt, this.clock.now(), {
      redacted: redactionFindingCount > 0,
      messageCount: sanitizedMessages.length,
    }));
    this.metrics.recordRedactionEvents(redactionFindingCount);
    const redactedPreview = preview(sanitizedMessages.map((message) => describeForPreview(message)).join("\n"));

    const analysisStartedAt = this.clock.now();
    const analysisInput: ConversationAnalysisInput = {
      window: sanitizedWindow,
      ...(options.candidateTargets === undefined ? {} : { candidateTargets: options.candidateTargets }),
    };
    const analysis = await this.memoryGraphAnalyzer.analyze(analysisInput);
    steps.push(step(options.analysisStepName, "succeeded", analysisStartedAt, this.clock.now(), {
      memoryCount: analysis.memories.length,
      nodeCount: analysis.nodes.length,
      edgeCount: analysis.edges.length,
      suggestionCount: analysis.suggestions.length,
      taskCount: analysis.tasks.length,
      statusUpdateCount: analysis.statusUpdates.length,
      warningCount: analysis.warnings.length,
      inputTokens: analysis.tokenUsage?.inputTokens ?? 0,
      outputTokens: analysis.tokenUsage?.outputTokens ?? 0,
      totalTokens: analysis.tokenUsage?.totalTokens ?? 0,
    }));
    // Step metadata cannot hold an array, so the reasons themselves go to errorLogs.
    // A count alone is not debuggable: when a model returns a shape the contract does
    // not accept, "12 warnings" and "12 nodes dropped: node kind must be one of…" are
    // the difference between a mystery and a fix.
    for (const warning of analysis.warnings) {
      errorLogs.push(`Analysis warning: ${warning}`);
    }

    const memoryPersistenceStartedAt = this.clock.now();
    for (const memory of analysis.memories) {
      const record = this.createMemoryRecord(memory.candidate, this.sourceFor(sanitizedWindow, memory.sourceMessageId));
      await this.memoryRecordRepository.save(record);
      createdMemoryRecordIds.push(record.id);
    }
    steps.push(step("memory_persistence", "succeeded", memoryPersistenceStartedAt, this.clock.now(), {
      recordCount: analysis.memories.length,
    }));

    if (this.memoryGraphRepository !== undefined) {
      const graphPersistenceStartedAt = this.clock.now();
      const savedNodeIds = new Set<string>();
      for (const node of analysis.nodes) {
        try {
          await this.memoryGraphRepository.saveNode(node);
          savedNodeIds.add(node.id);
          createdMemoryGraphNodeIds.push(node.id);
        } catch (error) {
          errorLogs.push(`Graph node ${node.id} not stored: ${messageOf(error)}`);
        }
      }
      // memory_edges has real foreign keys to memory_nodes and foreign_keys is ON, so
      // an edge whose endpoint the model invented raises a constraint error. Left
      // unhandled that error escaped this method after nodes were already written and
      // before the audit record was saved, so one bad edge destroyed the whole
      // window's trail. Endpoints are checked first, then each save is isolated.
      let droppedEdgeCount = 0;
      for (const edge of analysis.edges) {
        const missing = await this.missingEdgeEndpoints(edge, savedNodeIds);
        if (missing.length > 0) {
          droppedEdgeCount += 1;
          errorLogs.push(`Graph edge ${edge.id} dropped: unknown node ${missing.join(" and ")}.`);
          continue;
        }
        try {
          await this.memoryGraphRepository.saveEdge(edge);
          createdMemoryGraphEdgeIds.push(edge.id);
        } catch (error) {
          droppedEdgeCount += 1;
          errorLogs.push(`Graph edge ${edge.id} not stored: ${messageOf(error)}`);
        }
      }
      steps.push(step("graph_persistence", "succeeded", graphPersistenceStartedAt, this.clock.now(), {
        nodeCount: createdMemoryGraphNodeIds.length,
        edgeCount: createdMemoryGraphEdgeIds.length,
        droppedEdgeCount,
      }));
    } else {
      steps.push(step("graph_persistence", "skipped", this.clock.now(), this.clock.now(), {
        nodeCount: analysis.nodes.length,
        edgeCount: analysis.edges.length,
      }));
    }

    if (this.suggestionRepository !== undefined) {
      const suggestionPersistenceStartedAt = this.clock.now();
      for (const suggestion of analysis.suggestions) {
        try {
          await this.suggestionRepository.save(suggestion);
          createdSuggestionIds.push(suggestion.id);
        } catch (error) {
          errorLogs.push(`Suggestion ${suggestion.id} not stored: ${messageOf(error)}`);
        }
      }
      steps.push(step("suggestion_persistence", "succeeded", suggestionPersistenceStartedAt, this.clock.now(), {
        suggestionCount: createdSuggestionIds.length,
      }));
    } else {
      steps.push(step("suggestion_persistence", "skipped", this.clock.now(), this.clock.now(), {
        suggestionCount: analysis.suggestions.length,
      }));
    }

    this.metrics.recordTasksExtracted(analysis.tasks.length);
    this.metrics.recordExtractionOutcome(analysis.tasks.length > 0);
    for (const candidate of analysis.tasks) {
      this.metrics.recordConfidence(candidate.confidence);
    }

    const validationStartedAt = this.clock.now();
    const existingTasks = await this.taskRepository.findOpen();
    const validationResults = this.validationService.validate(analysis.tasks, existingTasks, anchor.occurredAt);
    const validationWarnings = validationResults.flatMap((result) => result.warnings);
    steps.push(step("validation", "succeeded", validationStartedAt, this.clock.now(), {
      acceptedCount: validationResults.filter((result) => result.accepted).length,
      warningCount: validationWarnings.length,
    }));

    for (let index = 0; index < validationResults.length; index += 1) {
      const validationResult = validationResults[index];
      if (validationResult === undefined) {
        continue;
      }
      const candidate = analysis.tasks[index];
      extractedTasks.push({
        title: validationResult.candidate.title.trim(),
        confidence: validationResult.candidate.confidence,
        extractionReason: validationResult.candidate.extractionReason,
        sourceMessageId: candidate?.sourceMessageId ?? anchorMessageId,
        processingTimestamp: this.clock.now(),
        accepted: validationResult.accepted,
        warnings: validationResult.warnings,
        syncStatus: "not_attempted",
      });
    }

    for (const validationResult of validationResults.filter((result) => result.accepted)) {
      const candidate = validationResult.candidate as AnalyzedTaskCandidate;
      const taskSource = this.sourceFor(sanitizedWindow, candidate.sourceMessageId);
      const task = Task.create({ ...candidate, source: taskSource }, this.clock.now(), this.idGenerator.generate());

      const persistenceStartedAt = this.clock.now();
      await this.taskRepository.save(task);
      const project = primaryProject(analysis.memories.map((memory) => memory.candidate));
      const taskMemoryRecord: MemoryRecord = {
        id: this.idGenerator.generate(),
        type: "Task",
        source: task.source,
        timestamp: this.clock.now(),
        confidence: candidate.confidence,
        ...(project === undefined ? {} : { project }),
        task,
      };
      await this.memoryRecordRepository.save(taskMemoryRecord);
      createdMemoryRecordIds.push(taskMemoryRecord.id);
      const taskGraph = await this.persistTaskGraph(task, candidate.confidence);
      createdMemoryGraphNodeIds.push(...taskGraph.nodeIds);
      createdMemoryGraphEdgeIds.push(...taskGraph.edgeIds);
      steps.push(step("persistence", "succeeded", persistenceStartedAt, this.clock.now(), {
        taskId: task.id,
      }));

      const auditedTaskIndex = extractedTasks.findIndex((candidateTask) =>
        candidateTask.title === candidate.title.trim()
        && candidateTask.confidence === candidate.confidence
        && candidateTask.taskId === undefined,
      );
      if (auditedTaskIndex >= 0) {
        const auditedTask = extractedTasks[auditedTaskIndex];
        if (auditedTask !== undefined) {
          extractedTasks[auditedTaskIndex] = { ...auditedTask, taskId: task.id };
        }
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
          if (auditedTask !== undefined) {
            extractedTasks[auditedTaskIndex] = { ...auditedTask, taskId: task.id, syncStatus: "succeeded" };
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        failedSyncCount += 1;
        this.metrics.recordSyncOutcome(false);
        errorLogs.push(`Notion sync failed for task ${task.id}: ${errorMessage}`);
        steps.push(step("notion_sync", "failed", syncStartedAt, this.clock.now(), { taskId: task.id }, errorMessage));
        if (auditedTaskIndex >= 0) {
          const auditedTask = extractedTasks[auditedTaskIndex];
          if (auditedTask !== undefined) {
            extractedTasks[auditedTaskIndex] = { ...auditedTask, taskId: task.id, syncStatus: "failed", syncError: errorMessage };
          }
        }
      }
      createdTaskIds.push(task.id);
    }

    const statusUpdateCount = await this.applyStatusUpdates(analysis.statusUpdates, steps, errorLogs);

    const completedAt = this.clock.now();
    const latencyMs = completedAt.getTime() - startedAt.getTime();
    this.metrics.recordMessageProcessed(latencyMs);
    await this.auditRepository.save({
      id: this.idGenerator.generate(),
      platform: window.platform,
      conversationId: window.conversationId,
      messageId: anchorMessageId,
      senderId: anchor.senderId,
      receivedAt: anchor.occurredAt,
      processedAt: completedAt,
      redactedContentPreview: redactedPreview,
      redactionFindingCount,
      steps,
      extractedTasks,
      errorLogs,
      totalLatencyMs: latencyMs,
      ...(analysis.tokenUsage === undefined ? {} : { aiTokenUsage: analysis.tokenUsage }),
    });

    this.logger.info("Processed conversation window", {
      platform: window.platform,
      conversationId: window.conversationId,
      messageId: anchorMessageId,
      messageCount: window.messages.length,
      createdTaskCount: createdTaskIds.length,
      redactedFindingCount: redactionFindingCount,
      validationWarningCount: validationWarnings.length,
      statusUpdateCount,
      failedSyncCount,
    });

    return {
      createdTaskIds,
      createdMemoryRecordIds,
      createdMemoryGraphNodeIds,
      createdMemoryGraphEdgeIds,
      createdSuggestionIds,
      redactedFindingCount: redactionFindingCount,
      validationWarningCount: validationWarnings.length,
      failedSyncCount,
      statusUpdateCount,
    };
  }

  /** Interprets a reaction against knowledge derived from the target message and applies any status change. */
  public async executeReaction(event: IncomingReactionEvent): Promise<{ readonly statusUpdateCount: number }> {
    const startedAt = this.clock.now();
    const steps: ProcessingAuditStep[] = [];
    const errorLogs: string[] = [];

    const candidateTargets = await this.candidateTargetsFor(event.targetMessageId);
    if (candidateTargets.length === 0) {
      steps.push(step("reaction_analysis", "skipped", startedAt, this.clock.now(), {
        targetMessageId: event.targetMessageId,
        reason: "No prior task or node found for the reacted message.",
      }));
      await this.saveReactionAudit(event, steps, errorLogs, startedAt, undefined);
      return { statusUpdateCount: 0 };
    }

    const syntheticMessage: IncomingMessage = {
      platform: event.platform,
      conversationId: event.conversationId,
      messageId: event.targetMessageId,
      senderId: event.reactorId,
      ...(event.reactorDisplayName === undefined ? {} : { senderDisplayName: event.reactorDisplayName }),
      text: "(reaction update on an earlier message)",
      occurredAt: event.occurredAt,
      reactions: event.reactions,
    };
    const window: ConversationWindow = {
      platform: event.platform,
      conversationId: event.conversationId,
      messages: [syntheticMessage],
    };
    const analysis = await this.memoryGraphAnalyzer.analyze({ window, candidateTargets });
    steps.push(step("reaction_analysis", "succeeded", startedAt, this.clock.now(), {
      targetMessageId: event.targetMessageId,
      candidateCount: candidateTargets.length,
      statusUpdateCount: analysis.statusUpdates.length,
      inputTokens: analysis.tokenUsage?.inputTokens ?? 0,
      outputTokens: analysis.tokenUsage?.outputTokens ?? 0,
      totalTokens: analysis.tokenUsage?.totalTokens ?? 0,
    }));

    const statusUpdateCount = await this.applyStatusUpdates(analysis.statusUpdates, steps, errorLogs);
    await this.saveReactionAudit(event, steps, errorLogs, startedAt, analysis.tokenUsage);
    return { statusUpdateCount };
  }

  private async candidateTargetsFor(messageId: string): Promise<readonly AnalysisCandidateTarget[]> {
    const targets: AnalysisCandidateTarget[] = [];
    for (const task of await this.taskRepository.findBySourceMessageId(messageId)) {
      targets.push({ sourceMessageId: messageId, kind: "task", id: task.id, label: task.title, status: task.status });
    }
    if (this.memoryGraphRepository !== undefined) {
      for (const node of await this.memoryGraphRepository.findNodesBySourceMessageId(messageId)) {
        targets.push({ sourceMessageId: messageId, kind: "node", id: node.id, label: node.label, status: node.status });
      }
    }
    return targets;
  }

  private async saveReactionAudit(
    event: IncomingReactionEvent,
    steps: ProcessingAuditStep[],
    errorLogs: string[],
    startedAt: Date,
    tokenUsage: AiTokenUsage | undefined,
  ): Promise<void> {
    const completedAt = this.clock.now();
    await this.auditRepository.save({
      id: this.idGenerator.generate(),
      platform: event.platform,
      conversationId: event.conversationId,
      messageId: `reaction:${event.targetMessageId}`,
      senderId: event.reactorId,
      receivedAt: event.occurredAt,
      processedAt: completedAt,
      redactedContentPreview: `reaction ${event.reactions.map((reaction) => reaction.emoji).join(" ")} on ${event.targetMessageId}`,
      redactionFindingCount: 0,
      steps,
      extractedTasks: [],
      errorLogs,
      totalLatencyMs: completedAt.getTime() - startedAt.getTime(),
      ...(tokenUsage === undefined ? {} : { aiTokenUsage: tokenUsage }),
    });
  }

  /** Applies inferred status changes to existing tasks (and their graph nodes) derived from a source message. */
  private async applyStatusUpdates(
    updates: readonly AnalyzedStatusUpdate[],
    steps: ProcessingAuditStep[],
    errorLogs: string[],
  ): Promise<number> {
    if (updates.length === 0) {
      return 0;
    }
    const startedAt = this.clock.now();
    let applied = 0;
    for (const update of updates) {
      const matches = await this.taskRepository.findBySourceMessageId(update.targetMessageId);
      const target = matches.find((task) => task.status === "open" || task.status === "in_progress") ?? matches[0];
      if (target === undefined) {
        errorLogs.push(`Status update skipped: no task found for message ${update.targetMessageId}.`);
        continue;
      }
      const updated = target.withStatus(update.status, this.clock.now());
      await this.taskRepository.save(updated);
      await this.syncTaskNodeStatus(updated);
      applied += 1;
    }
    steps.push(step("status_update", applied > 0 ? "succeeded" : "skipped", startedAt, this.clock.now(), {
      requestedCount: updates.length,
      appliedCount: applied,
    }));
    return applied;
  }

  private async syncTaskNodeStatus(task: Task): Promise<void> {
    if (this.memoryGraphRepository === undefined) {
      return;
    }
    const node = await this.memoryGraphRepository.findNodeById(`task:${task.id}`);
    if (node === undefined) {
      return;
    }
    await this.memoryGraphRepository.saveNode({
      ...node,
      payload: { ...node.payload, status: task.status },
      updatedAt: this.clock.now(),
    });
  }

  /**
   * Names the edge endpoints that do not exist, so the edge can be dropped before the
   * database rejects it.
   *
   * Nodes written earlier in this same window count, and so does anything already in
   * the graph — an edge onto `person:mak` from a previous run is legitimate. Only ids
   * with no node anywhere are missing.
   */
  private async missingEdgeEndpoints(
    edge: MemoryEdge,
    savedNodeIds: ReadonlySet<string>,
  ): Promise<readonly string[]> {
    const repository = this.memoryGraphRepository;
    if (repository === undefined) {
      return [];
    }
    const missing: string[] = [];
    for (const nodeId of new Set([edge.fromNodeId, edge.toNodeId])) {
      if (savedNodeIds.has(nodeId)) {
        continue;
      }
      if (await repository.findNodeById(nodeId) === undefined) {
        missing.push(nodeId);
      }
    }
    return missing;
  }

  private sourceFor(window: ConversationWindow, messageId: string): SourceReference {
    const match = window.messages.find((message) => message.messageId === messageId) ?? windowAnchor(window);
    return {
      platform: window.platform,
      conversationId: window.conversationId,
      messageId: match?.messageId ?? messageId,
      occurredAt: match?.occurredAt ?? this.clock.now(),
    };
  }

  private createMemoryRecord(candidate: ExtractedMemoryCandidate, source: SourceReference): MemoryRecord {
    return {
      id: this.idGenerator.generate(),
      type: candidate.type,
      source,
      timestamp: this.clock.now(),
      confidence: candidate.confidence,
      ...(candidate.project === undefined ? {} : { project: candidate.project }),
      ...memoryPayload(candidate),
    };
  }

  private async persistTaskGraph(task: Task, confidence: number): Promise<{ readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] }> {
    if (this.memoryGraphRepository === undefined) {
      return { nodeIds: [], edgeIds: [] };
    }

    const now = this.clock.now();
    const makNode = createMemoryNode({
      id: "person:mak",
      kind: "person",
      label: "Mak",
      scope: "user",
      source: task.source,
      confidence: 1,
      payload: { payloadKind: "person", role: "owner" },
      now,
    });
    const taskNode = createMemoryNode({
      id: `task:${task.id}`,
      kind: "task",
      label: task.title,
      scope: "conversation",
      source: task.source,
      confidence,
      payload: {
        status: task.status,
        priority: task.priority,
        ...(task.description === undefined ? {} : { description: task.description }),
      },
      now,
    });
    const taskEdge = createMemoryEdge({
      id: `edge:mak-task:${task.id}`,
      fromNodeId: makNode.id,
      toNodeId: taskNode.id,
      relation: "PERSON_OWNS_TASK",
      fact: `Mak owns task: ${task.title}`,
      source: task.source,
      confidence,
      now,
    });

    await this.memoryGraphRepository.saveNode(makNode);
    await this.memoryGraphRepository.saveNode(taskNode);
    await this.memoryGraphRepository.saveEdge(taskEdge);
    return { nodeIds: [makNode.id, taskNode.id], edgeIds: [taskEdge.id] };
  }

  /** Writes an audit record for a window that stopped before producing knowledge. */
  private async saveAudit(input: {
    readonly anchor: IncomingMessage;
    readonly anchorMessageId: string;
    readonly window: ConversationWindow;
    readonly startedAt: Date;
    readonly steps: readonly ProcessingAuditStep[];
    readonly extractedTasks: readonly AuditedExtractedTask[];
    readonly errorLogs: readonly string[];
    readonly redactedContentPreview: string;
    readonly redactionFindingCount: number;
  }): Promise<void> {
    const completedAt = this.clock.now();
    await this.auditRepository.save({
      id: this.idGenerator.generate(),
      platform: input.window.platform,
      conversationId: input.window.conversationId,
      messageId: input.anchorMessageId,
      senderId: input.anchor.senderId,
      receivedAt: input.anchor.occurredAt,
      processedAt: completedAt,
      redactedContentPreview: input.redactedContentPreview,
      redactionFindingCount: input.redactionFindingCount,
      steps: input.steps,
      extractedTasks: input.extractedTasks,
      errorLogs: input.errorLogs,
      totalLatencyMs: completedAt.getTime() - input.startedAt.getTime(),
    });
  }

  /**
   * Turns image and audio attachments into text.
   *
   * Never fatal: a window whose media cannot be understood is still analysed from
   * its text. Losing a description costs quality; failing here would lose the
   * conversation entirely.
   */
  private async understandMedia(
    window: ConversationWindow,
    steps: ProcessingAuditStep[],
    errorLogs: string[],
  ): Promise<ConversationWindow> {
    const attachmentCount = window.messages
      .reduce((total, message) => total + (message.attachments?.length ?? 0), 0);
    if (attachmentCount === 0) {
      return window;
    }

    const startedAt = this.clock.now();
    if (this.mediaUnderstanding === undefined) {
      steps.push(step("media_understanding", "skipped", startedAt, this.clock.now(), {
        attachmentCount,
        reason: "no perception model configured",
      }));
      return window;
    }

    try {
      const outcome = await this.mediaUnderstanding.execute(window);
      steps.push(step("media_fetch", "succeeded", startedAt, this.clock.now(), {
        attachmentCount,
        attempted: outcome.attempted,
        fromCache: outcome.fromCache,
        skipped: outcome.skipped,
      }));
      steps.push(step(
        "media_understanding",
        outcome.failed > 0 && outcome.understood === 0 ? "failed" : "succeeded",
        startedAt,
        this.clock.now(),
        {
          understood: outcome.understood,
          fromCache: outcome.fromCache,
          failed: outcome.failed,
          skipped: outcome.skipped,
          inputTokens: outcome.tokenUsage?.inputTokens ?? 0,
          outputTokens: outcome.tokenUsage?.outputTokens ?? 0,
          totalTokens: outcome.tokenUsage?.totalTokens ?? 0,
        },
      ));
      errorLogs.push(...outcome.errors);
      return outcome.window;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      steps.push(step("media_understanding", "failed", startedAt, this.clock.now(), {
        attachmentCount,
      }, message));
      errorLogs.push(`Media understanding failed: ${message}`);
      this.logger.warn("Media understanding failed; analysing text only.", { error: message });
      return window;
    }
  }
}

function primaryProject(candidates: readonly ExtractedMemoryCandidate[]) {
  return candidates.find((candidate) => candidate.project !== undefined)?.project;
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

/** Uniform error text for audit logs, whether or not the throw was an Error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/**
 * Renders a message for the audit preview, including attachment descriptions.
 *
 * Media-only messages have no text, so without this the operator sees an empty
 * preview and cannot tell whether redaction actually covered the media.
 */
function describeForPreview(message: IncomingMessage): string {
  const attachments = (message.attachments ?? []).map((attachment) => describeAttachment(attachment));
  return [message.text, ...attachments].filter((part) => part.length > 0).join(" ");
}

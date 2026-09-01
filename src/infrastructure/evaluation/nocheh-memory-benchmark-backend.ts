import type { ConversationWindow } from "../../application/dto/conversation-window.js";
import type { IncomingMessage } from "../../application/dto/incoming-message.js";
import type { AuditRepositoryPort } from "../../application/ports/audit-repository.js";
import type { ConversationWindowProcessorPort } from "../../application/ports/incoming-message-processor.js";
import type { MemoryBenchmarkBackendPort } from "../../application/ports/memory-benchmark-backend.js";
import type { MemoryGraphRepositoryPort } from "../../application/ports/memory-graph-repository.js";
import type { MemoryRecordRepositoryPort } from "../../application/ports/memory-record-repository.js";
import type { MetricsCollectorPort, MetricsSnapshot } from "../../application/ports/metrics.js";
import type { SuggestionRepositoryPort } from "../../application/ports/suggestion-repository.js";
import type { TaskRepositoryPort } from "../../application/ports/task-repository.js";
import type { AssistantContext, AssistantContextBuildOptions } from "../../application/services/assistant-context-builder.js";
import { createGroupAssistantSettings, type GroupAssistantSettings } from "../../domain/assistant/group-assistant-settings.js";
import type {
  MemoryBenchmarkManifest,
  MemoryBenchmarkMessage,
  MemoryBenchmarkPreparation,
  MemoryBenchmarkQuestion,
  MemoryBenchmarkRecall,
  MemoryBenchmarkUsage,
} from "../../domain/evaluation/memory-benchmark.js";
import { memoryRecordSummary } from "../../domain/memory/memory-record.js";

interface NochehBenchmarkContextBuilder {
  build(
    messages: readonly IncomingMessage[],
    settings: GroupAssistantSettings,
    options?: AssistantContextBuildOptions,
  ): Promise<AssistantContext>;
}

export interface NochehBenchmarkStorageProbe {
  measure(): Promise<{ readonly databaseBytes: number; readonly indexBytes: number }>;
}

export interface NochehBenchmarkCostModel {
  estimate(usage: Omit<MemoryBenchmarkUsage, "estimatedCostUsd">): number;
  projectMonthly(
    measured: Omit<MemoryBenchmarkUsage, "estimatedCostUsd">,
    measuredMessageCount: number,
  ): number;
}

export interface NochehMemoryBenchmarkBackendDependencies {
  /** Must be composed with an inert task provider: benchmarks never create external effects. */
  readonly externalEffects: "disabled";
  readonly processor: ConversationWindowProcessorPort;
  readonly contextBuilder: NochehBenchmarkContextBuilder;
  readonly memoryRecords: MemoryRecordRepositoryPort;
  readonly graph: MemoryGraphRepositoryPort;
  readonly suggestions: SuggestionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly audits: AuditRepositoryPort;
  readonly metrics: MetricsCollectorPort;
  readonly storage?: NochehBenchmarkStorageProbe;
  readonly costModel?: NochehBenchmarkCostModel;
}

export interface NochehMemoryBenchmarkBackendOptions {
  readonly id: string;
  readonly version: string;
  readonly windowMessageCount?: number;
  readonly maxRetrievedMemories?: number;
  readonly nowMs?: () => number;
}

/**
 * Runs the current Nocheh analyzer and recall path without changing production composition.
 *
 * It intentionally bypasses HistoryImportService: that service collapses each chunk into one
 * synthetic message id, which would make source-valid recall impossible to measure. Windows
 * still enter through ProcessIncomingMessageUseCase's final guard and retain original ids.
 */
export class NochehMemoryBenchmarkBackend implements MemoryBenchmarkBackendPort {
  public readonly id: string;
  public readonly version: string;
  private readonly windowMessageCount: number;
  private readonly maxRetrievedMemories: number;
  private readonly nowMs: () => number;
  private prepared = false;

  public constructor(
    private readonly dependencies: NochehMemoryBenchmarkBackendDependencies,
    options: NochehMemoryBenchmarkBackendOptions,
  ) {
    this.id = options.id;
    this.version = options.version;
    this.windowMessageCount = positiveInteger(options.windowMessageCount, 20);
    this.maxRetrievedMemories = positiveInteger(options.maxRetrievedMemories, 12);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  public async prepare(
    messages: readonly MemoryBenchmarkMessage[],
    manifest: MemoryBenchmarkManifest,
  ): Promise<MemoryBenchmarkPreparation> {
    if (this.prepared) throw new Error("Nocheh benchmark backend can only be prepared once");
    await this.assertEmptyState();
    this.prepared = true;

    const metricsBefore = this.dependencies.metrics.snapshot();
    const startedAt = this.nowMs();
    const windows = chronologicalWindows(messages, this.windowMessageCount);
    for (const window of windows) {
      await this.dependencies.processor.executeWindow(
        window,
        this.settingsFor(window.conversationId, manifest.contextTokenBudget),
      );
    }
    const durationMs = Math.max(0, this.nowMs() - startedAt);
    const metricsAfter = this.dependencies.metrics.snapshot();
    const measuredUsage = usageDifference(metricsBefore, metricsAfter);
    const usage = withEstimatedCost(measuredUsage, this.dependencies.costModel);

    const [records, nodes, pendingSuggestions, openTasks, audits, storage] = await Promise.all([
      this.dependencies.memoryRecords.findAll(),
      this.dependencies.graph.listNodes(),
      this.dependencies.suggestions.findPending(),
      this.dependencies.tasks.findOpen(),
      this.dependencies.audits.findRecent(windows.length + 10),
      this.dependencies.storage?.measure() ?? Promise.resolve({ databaseBytes: 0, indexBytes: 0 }),
    ]);
    const edgeIds = new Set<string>();
    for (const node of nodes) {
      for (const edge of await this.dependencies.graph.listEdgesForNode(node.id)) edgeIds.add(edge.id);
    }
    const contextSteps = audits.flatMap((audit) => audit.steps.filter((step) => step.name === "context_build"));
    const analysisWarnings = audits.reduce(
      (count, audit) => count + audit.errorLogs.filter((entry) => entry.startsWith("Analysis warning:")).length,
      0,
    );
    const errorLogCount = audits.reduce((count, audit) => count + audit.errorLogs.length, 0);
    const reasoningTokens = metricsAfter.aiReasoningTokens - metricsBefore.aiReasoningTokens;
    const maxContextTokens = contextSteps.reduce((maximum, step) => {
      const value = step.metadata.approxTokens;
      return typeof value === "number" ? Math.max(maximum, value) : maximum;
    }, 0);

    return {
      ingestedMessages: messages.length,
      durationMs,
      databaseBytes: storage.databaseBytes,
      indexBytes: storage.indexBytes,
      usage,
      observations: {
        windows: windows.length,
        memoryRecords: records.length,
        graphNodes: nodes.length,
        graphEdges: edgeIds.size,
        pendingSuggestions: pendingSuggestions.length,
        openTasks: openTasks.length,
        audits: audits.length,
        errorLogs: errorLogCount,
        analysisWarnings,
        contextBuildFailures: contextSteps.filter((step) => step.status === "failed").length,
        maxContextTokens,
        reasoningTokens,
        redactionEvents: metricsAfter.redactionEvents - metricsBefore.redactionEvents,
      },
      ...(this.dependencies.costModel === undefined
        ? {}
        : { projectedMonthlyCostUsd: this.dependencies.costModel.projectMonthly(measuredUsage, messages.length) }),
    };
  }

  public async recall(
    question: MemoryBenchmarkQuestion,
    contextTokenBudget: number,
  ): Promise<MemoryBenchmarkRecall> {
    if (!this.prepared) throw new Error("Nocheh benchmark backend must be prepared before recall");
    const metricsBefore = this.dependencies.metrics.snapshot();
    const startedAt = this.nowMs();
    const queryMessage: IncomingMessage = {
      platform: "memory-benchmark-query",
      conversationId: "memory-benchmark-query",
      messageId: `benchmark-query:${question.id}`,
      senderId: "benchmark-owner",
      text: question.prompt,
      occurredAt: new Date(),
    };
    const context = await this.dependencies.contextBuilder.build(
      [queryMessage],
      this.settingsFor(queryMessage.conversationId, contextTokenBudget),
    );
    const retrievalLatencyMs = Math.max(0, this.nowMs() - startedAt);
    const usage = withEstimatedCost(
      usageDifference(metricsBefore, this.dependencies.metrics.snapshot()),
      this.dependencies.costModel,
    );

    return {
      questionId: question.id,
      evidence: evidenceInRenderedContext(context),
      context: context.groundingText,
      contextTokens: Math.ceil(context.groundingText.length / 4),
      retrievalLatencyMs,
      queueLagMs: 0,
      usage,
    };
  }

  private settingsFor(conversationId: string, contextTokenBudget: number): GroupAssistantSettings {
    return createGroupAssistantSettings({
      conversationId,
      analysisMode: "immediate",
      maxMessagesPerBatch: this.windowMessageCount,
      maxAiContextTokens: contextTokenBudget,
      maxRetrievedMemories: this.maxRetrievedMemories,
      maxRecentMessages: this.windowMessageCount,
      replyMode: "silent",
    }, new Date());
  }

  private async assertEmptyState(): Promise<void> {
    const [records, nodes, audits] = await Promise.all([
      this.dependencies.memoryRecords.findAll(),
      this.dependencies.graph.listNodes(),
      this.dependencies.audits.findRecent(1),
    ]);
    if (records.length > 0 || nodes.length > 0 || audits.length > 0) {
      throw new Error("Nocheh benchmark requires a fresh isolated database");
    }
  }
}

function chronologicalWindows(
  messages: readonly MemoryBenchmarkMessage[],
  limit: number,
): readonly ConversationWindow[] {
  const windows: ConversationWindow[] = [];
  let current: IncomingMessage[] = [];
  let conversationId: string | undefined;

  const flush = (): void => {
    if (current.length === 0 || conversationId === undefined) return;
    windows.push({ platform: "memory-benchmark", conversationId, messages: current });
    current = [];
  };

  for (const message of messages) {
    if (conversationId !== undefined && (conversationId !== message.conversationId || current.length >= limit)) flush();
    conversationId = message.conversationId;
    current.push({
      platform: "memory-benchmark",
      conversationId: message.conversationId,
      messageId: message.id,
      senderId: message.senderId,
      ...(message.senderDisplayName === undefined ? {} : { senderDisplayName: message.senderDisplayName }),
      text: message.text,
      occurredAt: new Date(message.occurredAt),
    });
  }
  flush();
  return windows;
}

function evidenceInRenderedContext(context: AssistantContext): MemoryBenchmarkRecall["evidence"] {
  const candidates = [
    ...context.memories.map((record) => ({
      evidenceId: `memory:${record.id}`,
      sourceId: record.source.messageId,
      text: memoryRecordSummary(record),
    })),
    ...context.graphNodes.map((node) => ({
      evidenceId: `node:${node.id}`,
      sourceId: node.source.messageId,
      text: node.label,
    })),
    ...context.graphEdges.map((edge) => ({
      evidenceId: `edge:${edge.id}`,
      sourceId: edge.source.messageId,
      text: edge.fact,
    })),
    ...context.pendingSuggestions.map((suggestion) => ({
      evidenceId: `suggestion:${suggestion.id}`,
      sourceId: suggestion.source.messageId,
      text: suggestion.title,
    })),
  ];
  return candidates.filter((candidate) =>
    candidate.text.trim().length > 0 && context.groundingText.includes(candidate.text)
  );
}

function usageDifference(before: MetricsSnapshot, after: MetricsSnapshot): Omit<MemoryBenchmarkUsage, "estimatedCostUsd"> {
  return {
    calls: Math.max(0, after.aiCalls - before.aiCalls),
    inputTokens: Math.max(0, after.aiInputTokens - before.aiInputTokens),
    outputTokens: Math.max(0, after.aiOutputTokens - before.aiOutputTokens),
  };
}

function withEstimatedCost(
  usage: Omit<MemoryBenchmarkUsage, "estimatedCostUsd">,
  costModel: NochehBenchmarkCostModel | undefined,
): MemoryBenchmarkUsage {
  return { ...usage, estimatedCostUsd: costModel?.estimate(usage) ?? 0 };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isInteger(value) || value <= 0 ? fallback : value;
}

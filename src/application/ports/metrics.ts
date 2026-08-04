import type { AiTokenUsage } from "../../domain/observability/audit.js";

/** Aggregated processing metrics exposed to internal tooling. */
export interface MetricsSnapshot {
  readonly messagesProcessed: number;
  readonly tasksExtracted: number;
  readonly extractionSuccessRate: number;
  readonly syncSuccessRate: number;
  readonly averageConfidence: number;
  readonly redactionEvents: number;
  readonly averageProcessingLatencyMs: number;
  /** Model calls whose usage was reported, across every role. */
  readonly aiCalls: number;
  readonly aiInputTokens: number;
  readonly aiOutputTokens: number;
  /** Tokens spent thinking and then discarded. Zero for non-reasoning models. */
  readonly aiReasoningTokens: number;
  readonly aiTotalTokens: number;
}

/** Collects operational metrics for the processing pipeline. */
export interface MetricsCollectorPort {
  recordMessageProcessed(latencyMs: number): void;
  recordTasksExtracted(count: number): void;
  recordExtractionOutcome(success: boolean): void;
  recordSyncOutcome(success: boolean): void;
  recordConfidence(confidence: number): void;
  recordRedactionEvents(count: number): void;
  /**
   * Records one model call's token usage.
   *
   * Cost is a feature, so it has to be visible somewhere other than a single audit
   * record. Called for every role that reports usage, not just analysis.
   */
  recordAiTokenUsage(usage: AiTokenUsage): void;
  snapshot(): MetricsSnapshot;
}

/** No-op metrics collector for tests or deployments without metrics. */
export class NoopMetricsCollector implements MetricsCollectorPort {
  public recordMessageProcessed(): void {}
  public recordTasksExtracted(): void {}
  public recordExtractionOutcome(): void {}
  public recordSyncOutcome(): void {}
  public recordConfidence(): void {}
  public recordRedactionEvents(): void {}
  public recordAiTokenUsage(): void {}
  public snapshot(): MetricsSnapshot {
    return {
      messagesProcessed: 0,
      tasksExtracted: 0,
      extractionSuccessRate: 0,
      syncSuccessRate: 0,
      averageConfidence: 0,
      redactionEvents: 0,
      averageProcessingLatencyMs: 0,
      aiCalls: 0,
      aiInputTokens: 0,
      aiOutputTokens: 0,
      aiReasoningTokens: 0,
      aiTotalTokens: 0,
    };
  }
}

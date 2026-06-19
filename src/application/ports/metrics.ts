/** Aggregated processing metrics exposed to internal tooling. */
export interface MetricsSnapshot {
  readonly messagesProcessed: number;
  readonly tasksExtracted: number;
  readonly extractionSuccessRate: number;
  readonly syncSuccessRate: number;
  readonly averageConfidence: number;
  readonly redactionEvents: number;
  readonly averageProcessingLatencyMs: number;
}

/** Collects operational metrics for the processing pipeline. */
export interface MetricsCollectorPort {
  recordMessageProcessed(latencyMs: number): void;
  recordTasksExtracted(count: number): void;
  recordExtractionOutcome(success: boolean): void;
  recordSyncOutcome(success: boolean): void;
  recordConfidence(confidence: number): void;
  recordRedactionEvents(count: number): void;
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
  public snapshot(): MetricsSnapshot {
    return {
      messagesProcessed: 0,
      tasksExtracted: 0,
      extractionSuccessRate: 0,
      syncSuccessRate: 0,
      averageConfidence: 0,
      redactionEvents: 0,
      averageProcessingLatencyMs: 0,
    };
  }
}

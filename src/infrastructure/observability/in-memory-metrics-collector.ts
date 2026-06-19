import type { MetricsCollectorPort, MetricsSnapshot } from "../../application/ports/metrics.js";

/** In-process metrics collector for local Phase 1.5 observability. */
export class InMemoryMetricsCollector implements MetricsCollectorPort {
  private messagesProcessed = 0;
  private tasksExtracted = 0;
  private extractionAttempts = 0;
  private extractionSuccesses = 0;
  private syncAttempts = 0;
  private syncSuccesses = 0;
  private confidenceTotal = 0;
  private confidenceCount = 0;
  private redactionEvents = 0;
  private latencyTotalMs = 0;

  /** Records one processed message and its end-to-end latency. */
  public recordMessageProcessed(latencyMs: number): void {
    this.messagesProcessed += 1;
    this.latencyTotalMs += latencyMs;
  }

  /** Records the number of extracted task candidates. */
  public recordTasksExtracted(count: number): void {
    this.tasksExtracted += count;
  }

  /** Records whether task extraction produced at least one candidate. */
  public recordExtractionOutcome(success: boolean): void {
    this.extractionAttempts += 1;
    if (success) {
      this.extractionSuccesses += 1;
    }
  }

  /** Records whether an external task sync attempt succeeded. */
  public recordSyncOutcome(success: boolean): void {
    this.syncAttempts += 1;
    if (success) {
      this.syncSuccesses += 1;
    }
  }

  /** Records one extraction confidence score. */
  public recordConfidence(confidence: number): void {
    this.confidenceTotal += confidence;
    this.confidenceCount += 1;
  }

  /** Records detected redaction events. */
  public recordRedactionEvents(count: number): void {
    this.redactionEvents += count;
  }

  /** Returns a point-in-time metrics snapshot. */
  public snapshot(): MetricsSnapshot {
    return {
      messagesProcessed: this.messagesProcessed,
      tasksExtracted: this.tasksExtracted,
      extractionSuccessRate: ratio(this.extractionSuccesses, this.extractionAttempts),
      syncSuccessRate: ratio(this.syncSuccesses, this.syncAttempts),
      averageConfidence: ratio(this.confidenceTotal, this.confidenceCount),
      redactionEvents: this.redactionEvents,
      averageProcessingLatencyMs: ratio(this.latencyTotalMs, this.messagesProcessed),
    };
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

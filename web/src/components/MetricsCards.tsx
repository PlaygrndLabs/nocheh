import type { MetricsSnapshot } from "../api/client.js";

export function MetricsCards({ metrics }: { metrics: MetricsSnapshot }): JSX.Element {
  const cards: [string, string][] = [
    ["Messages", String(metrics.messagesProcessed)],
    ["Tasks", String(metrics.tasksExtracted)],
    ["Extraction", percent(metrics.extractionSuccessRate)],
    ["Sync", percent(metrics.syncSuccessRate)],
    ["Avg Confidence", metrics.averageConfidence.toFixed(2)],
    ["Redactions", String(metrics.redactionEvents)],
    ["Avg Latency", `${metrics.averageProcessingLatencyMs.toFixed(0)} ms`],
    ["AI Calls", String(metrics.aiCalls)],
    ["Tokens", compact(metrics.aiTotalTokens)],
    ["Thinking", compact(metrics.aiReasoningTokens)],
  ];

  return (
    <div className="metrics">
      {cards.map(([label, value]) => (
        <div className="metric" key={label}>
          <b>{value}</b>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Token counts get large fast, so thousands are abbreviated. */
function compact(value: number): string {
  if (value < 1000) {
    return String(value);
  }
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
}

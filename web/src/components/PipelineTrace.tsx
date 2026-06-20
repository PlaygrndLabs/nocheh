import type { AuditRecord } from "../api/client.js";

/** Renders the step-by-step processing flow for a set of audit records. */
export function PipelineTrace({ records }: { records: AuditRecord[] }): JSX.Element {
  if (records.length === 0) {
    return <p className="muted">No processed messages yet for this conversation.</p>;
  }

  return (
    <div className="trace">
      {records.map((record) => (
        <div className="trace-record" key={record.id}>
          <code>
            {record.platform} · {record.messageId} · {new Date(record.processedAt).toLocaleString()} ·{" "}
            {record.totalLatencyMs.toFixed(0)} ms
          </code>
          <div className="preview">{record.redactedContentPreview}</div>
          {record.steps.map((step, index) => (
            <div className="step" key={`${record.id}-${step.name}-${index}`}>
              <span>{step.name}</span>
              <span className={`pill ${step.status}`}>{step.status}</span>
              <span>{step.durationMs.toFixed(0)} ms</span>
              <code>
                {JSON.stringify(step.metadata)}
                {step.errorMessage === undefined ? "" : ` · ${step.errorMessage}`}
              </code>
            </div>
          ))}
          {record.extractedTasks.length > 0 && (
            <p className="status-line">
              Tasks:{" "}
              {record.extractedTasks
                .map((task) => `${task.title || "(empty)"} [${task.confidence.toFixed(2)}, ${task.syncStatus}]`)
                .join("; ")}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

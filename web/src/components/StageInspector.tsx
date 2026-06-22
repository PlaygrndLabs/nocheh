import { Fragment } from "react";
import { ShieldCheck } from "lucide-react";
import type { AuditRecord } from "../api/client.js";
import type { BrainPreview } from "../sim/brain-preview.js";
import { LANE_LABELS, type FlowFrame, type FlowStage } from "../sim/flow-model.js";

interface StageInspectorProps {
  readonly stage: FlowStage;
  readonly frame: FlowFrame | undefined;
  readonly record: AuditRecord | undefined;
  readonly preview: BrainPreview;
}

/** Detail panel for the selected (or active) flow stage. */
export function StageInspector({ stage, frame, record }: StageInspectorProps): JSX.Element {
  const status = frame?.status ?? "idle";
  return (
    <section className="stage-inspector" aria-label={`Stage detail: ${stage.label}`}>
      <header className="stage-inspector-head">
        <div>
          <span className={`stage-inspector-lane lane-${stage.lane}`}>{LANE_LABELS[stage.lane]}</span>
          <h3>{stage.label}</h3>
        </div>
        <span className={`stage-inspector-status is-${status}`}>{status === "idle" ? "not reached yet" : status}</span>
      </header>

      <p className="stage-inspector-detail">{frame?.detail ?? stage.sublabel}</p>

      {frame === undefined ? (
        <p className="stage-inspector-empty">This stage has not run yet. Play the flow or send a message to populate it.</p>
      ) : (
        <Fragment>
          {stage.id === "protect" && record !== undefined && (
            <RedactedPreview preview={record.redactedContentPreview} count={record.redactionFindingCount} />
          )}

          {frame.metrics.length > 0 && (
            <div className="stage-inspector-metrics" aria-label="Stage metrics">
              {frame.metrics.map((metric) => (
                <div key={metric.label} className="stage-metric">
                  <span>{metric.label}</span>
                  <b>{metric.value}</b>
                </div>
              ))}
            </div>
          )}

          {frame.samples.length > 0 && (
            <ul className="stage-inspector-samples">
              {frame.samples.map((sample, index) => (
                <li key={index}>{sample}</li>
              ))}
            </ul>
          )}
        </Fragment>
      )}

      {stage.property !== undefined && (
        <div className="stage-inspector-property">
          <ShieldCheck size={15} aria-hidden="true" />
          <span>{stage.property}</span>
        </div>
      )}
    </section>
  );
}

function RedactedPreview({ preview, count }: { readonly preview: string; readonly count: number }): JSX.Element {
  const parts = preview.split(/(\[REDACTED\])/g);
  return (
    <div className="redacted-preview">
      <span className="redacted-preview-label">Redacted preview ({count} found)</span>
      <p>
        {parts.map((part, index) =>
          part === "[REDACTED]" ? (
            <span key={index} className="redacted-span">[REDACTED]</span>
          ) : (
            <Fragment key={index}>{part}</Fragment>
          ),
        )}
      </p>
    </div>
  );
}

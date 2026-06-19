import type { IncomingMessage as HttpIncomingMessage, ServerResponse } from "node:http";
import type { AuditRepositoryPort } from "../../application/ports/audit-repository.js";
import type { MetricsCollectorPort } from "../../application/ports/metrics.js";
import type { ProcessingAuditRecord } from "../../domain/observability/audit.js";

/** Creates a lightweight internal dashboard handler for pipeline observability. */
export function createDeveloperDashboardHandler(
  auditRepository: AuditRepositoryPort,
  metrics: MetricsCollectorPort,
): (request: HttpIncomingMessage, response: ServerResponse) => Promise<void> {
  return async (_request, response) => {
    const [records, snapshot] = await Promise.all([
      auditRepository.findRecent(50),
      Promise.resolve(metrics.snapshot()),
    ]);

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderDashboard(records, snapshot));
  };
}

function renderDashboard(records: readonly ProcessingAuditRecord[], metrics: ReturnType<MetricsCollectorPort["snapshot"]>): string {
  const cards: readonly (readonly [string, string])[] = [
    ["Messages", metrics.messagesProcessed.toString()],
    ["Tasks", metrics.tasksExtracted.toString()],
    ["Extraction", percent(metrics.extractionSuccessRate)],
    ["Sync", percent(metrics.syncSuccessRate)],
    ["Avg Confidence", metrics.averageConfidence.toFixed(2)],
    ["Redactions", metrics.redactionEvents.toString()],
    ["Avg Latency", `${metrics.averageProcessingLatencyMs.toFixed(0)} ms`],
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nocheh Processing Console</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #1f2523;
      --muted: #69736f;
      --line: #d8ded9;
      --paper: #f8f7f1;
      --panel: #ffffff;
      --accent: #0d766b;
      --warn: #a15c00;
      --fail: #b42318;
      --ok: #18794e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font-family: ui-serif, Georgia, Cambria, "Times New Roman", serif;
    }
    main { width: min(1440px, calc(100vw - 40px)); margin: 24px auto 56px; }
    header {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 24px;
      align-items: end;
      border-bottom: 2px solid var(--ink);
      padding-bottom: 16px;
      margin-bottom: 18px;
    }
    h1 { margin: 0; font-size: clamp(28px, 4vw, 54px); letter-spacing: 0; line-height: .95; }
    .stamp { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); font-size: 12px; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(145px, 1fr));
      gap: 10px;
      margin: 18px 0;
    }
    .metric {
      background: var(--panel);
      border: 1px solid var(--line);
      border-left: 5px solid var(--accent);
      padding: 12px 14px;
      min-height: 76px;
    }
    .metric b { display: block; font-size: 25px; line-height: 1.1; }
    .metric span { display: block; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; margin-top: 7px; }
    .stream {
      display: grid;
      gap: 12px;
    }
    article {
      background: var(--panel);
      border: 1px solid var(--line);
      display: grid;
      grid-template-columns: minmax(220px, 300px) 1fr;
      min-height: 180px;
    }
    .message {
      border-right: 1px solid var(--line);
      padding: 14px;
      background: #fbfaf6;
    }
    .message code, .task code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .preview {
      margin-top: 12px;
      padding: 10px;
      border: 1px dashed var(--line);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .details { padding: 14px; overflow-x: auto; }
    .steps, .tasks { display: grid; gap: 8px; }
    .step, .task {
      display: grid;
      grid-template-columns: 145px 90px 80px 1fr;
      gap: 10px;
      align-items: center;
      border-bottom: 1px solid var(--line);
      padding: 7px 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
    }
    .task { grid-template-columns: minmax(180px, 1fr) 90px 110px 1.4fr; }
    .pill {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      border: 1px solid currentColor;
      padding: 2px 7px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .06em;
    }
    .succeeded { color: var(--ok); }
    .failed { color: var(--fail); }
    .skipped, .started { color: var(--muted); }
    .warn { color: var(--warn); }
    h2 { margin: 0 0 10px; font-size: 18px; }
    h3 { margin: 16px 0 8px; font-size: 14px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }
    @media (max-width: 820px) {
      main { width: min(100vw - 24px, 760px); margin-top: 14px; }
      header, article { grid-template-columns: 1fr; }
      .message { border-right: 0; border-bottom: 1px solid var(--line); }
      .step, .task { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Processing Console</h1>
      <div class="stamp">internal observability · ${escapeHtml(new Date().toISOString())}</div>
    </header>
    <section class="metrics">${cards.map(([label, value]) => `<div class="metric"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`).join("")}</section>
    <section class="stream">${records.length === 0 ? emptyState() : records.map(renderRecord).join("")}</section>
  </main>
</body>
</html>`;
}

function renderRecord(record: ProcessingAuditRecord): string {
  return `<article>
    <section class="message">
      <h2>${escapeHtml(record.platform)} · ${escapeHtml(record.messageId)}</h2>
      <code>${escapeHtml(record.conversationId)} · ${escapeHtml(record.processedAt.toISOString())}</code>
      <div class="preview">${escapeHtml(record.redactedContentPreview)}</div>
      <h3>Errors</h3>
      ${record.errorLogs.length === 0 ? `<code>none</code>` : record.errorLogs.map((log) => `<code class="failed">${escapeHtml(log)}</code>`).join("<br>")}
    </section>
    <section class="details">
      <h3>Pipeline</h3>
      <div class="steps">${record.steps.map((step) => `<div class="step">
        <span>${escapeHtml(step.name)}</span>
        <span class="pill ${escapeHtml(step.status)}">${escapeHtml(step.status)}</span>
        <span>${step.durationMs.toFixed(0)} ms</span>
        <code>${escapeHtml(JSON.stringify(step.metadata))}${step.errorMessage === undefined ? "" : ` · ${escapeHtml(step.errorMessage)}`}</code>
      </div>`).join("")}</div>
      <h3>Extracted Tasks</h3>
      <div class="tasks">${record.extractedTasks.length === 0 ? `<code>none</code>` : record.extractedTasks.map((task) => `<div class="task">
        <span>${escapeHtml(task.title || "(empty)")}</span>
        <span>${task.confidence.toFixed(2)}</span>
        <span class="pill ${task.syncStatus === "failed" ? "failed" : task.accepted ? "succeeded" : "warn"}">${escapeHtml(task.syncStatus)}</span>
        <code>${escapeHtml(task.extractionReason)}${task.warnings.length === 0 ? "" : ` · ${escapeHtml(task.warnings.map((warning) => warning.code).join(", "))}`}</code>
      </div>`).join("")}</div>
    </section>
  </article>`;
}

function emptyState(): string {
  return `<article><section class="message"><h2>No messages</h2><div class="preview">No audit records have been written yet.</div></section></article>`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

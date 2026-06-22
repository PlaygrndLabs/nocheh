import type { AuditRecord, AuditStep, AuditTask } from "../api/client.js";

const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9_-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{8,}\b/g,
  /\b(?:password|token|secret|api[_ -]?key)\s*[:=]\s*\S+/gi,
];

export interface LocalProcessInput {
  readonly conversationId: string;
  readonly text: string;
  readonly senderDisplayName: string;
}

export function simulateLocalProcessing(input: LocalProcessInput): AuditRecord {
  const startedAt = Date.now();
  const redacted = redact(input.text);
  const tasks = extractTasks(redacted.text);
  const memoryCount = memoryCountFor(redacted.text, tasks);
  const graphNodeCount = graphNodeCountFor(redacted.text, memoryCount, tasks);
  const graphEdgeCount = Math.max(0, graphNodeCount - 1);
  const suggestionCount = suggestionCountFor(redacted.text, tasks);
  const totalLatencyMs = 12 + redacted.findingCount * 5 + memoryCount * 3 + tasks.length * 4 + suggestionCount * 3;

  return {
    id: `sim:${startedAt}:${Math.random().toString(16).slice(2)}`,
    platform: "simulator",
    conversationId: input.conversationId,
    messageId: `sim-message:${startedAt}`,
    processedAt: new Date(startedAt + totalLatencyMs).toISOString(),
    redactedContentPreview: preview(redacted.text),
    redactionFindingCount: redacted.findingCount,
    steps: [
      step("telegram_message", "succeeded", 1, { localOnly: true }),
      step("secret_detection", "succeeded", 2, { findingCount: redacted.findingCount }),
      step("redaction", "succeeded", 1, { redacted: redacted.findingCount > 0, previewLength: preview(redacted.text).length }),
      step("memory_extraction", "succeeded", 3, { candidateCount: memoryCount }),
      step("memory_persistence", "succeeded", 2, { recordCount: memoryCount, localOnly: true }),
      step("graph_analysis", "succeeded", 4, { nodeCount: graphNodeCount, edgeCount: graphEdgeCount, suggestionCount }),
      step("graph_persistence", "succeeded", 2, { nodeCount: graphNodeCount, edgeCount: graphEdgeCount, localOnly: true }),
      step("suggestion_persistence", "succeeded", 2, { suggestionCount, localOnly: true }),
      step("task_extraction", "succeeded", 3, { candidateCount: tasks.length }),
      step("validation", "succeeded", 2, { acceptedCount: tasks.filter((task) => task.accepted).length, warningCount: 0 }),
      step("persistence", "succeeded", 2, { taskCount: tasks.filter((task) => task.accepted).length, localOnly: true }),
      step("notion_sync", "skipped", 0, { reason: "Simulator is local-only." }),
    ],
    extractedTasks: tasks,
    errorLogs: [],
    totalLatencyMs,
  };
}

function step(name: string, status: AuditStep["status"], durationMs: number, metadata: AuditStep["metadata"]): AuditStep {
  return { name, status, durationMs, metadata };
}

function redact(text: string): { readonly text: string; readonly findingCount: number } {
  let redacted = text;
  let findingCount = 0;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, () => {
      findingCount += 1;
      return "[REDACTED]";
    });
  }
  return { text: redacted, findingCount };
}

function extractTasks(text: string): AuditTask[] {
  const candidates = text
    .split(/\n|[.;]/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap(taskFromLine);
  return candidates.slice(0, 4);
}

function taskFromLine(line: string): AuditTask[] {
  const explicit = /^\s*(?:task|todo|to do|action)\s*:\s*(.+)$/i.exec(line);
  const need = /\b(?:need to|should|must|prepare|ship|send|review|create|write|follow up)\b/i.test(line);
  const title = explicit?.[1] ?? (need ? line : undefined);
  if (title === undefined) {
    return [];
  }
  const normalized = title.trim();
  if (normalized.length < 6) {
    return [];
  }
  const accepted = /\b(?:by|before|today|tomorrow|friday|monday|urgent|deadline|due)\b/i.test(normalized);
  return [{
    title: normalized,
    confidence: accepted ? 0.86 : 0.64,
    extractionReason: explicit === null ? "Action language detected in simulator." : "Explicit task prefix detected in simulator.",
    accepted,
    syncStatus: "not_attempted",
    warnings: accepted ? [] : [{ code: "needs_review" }],
  }];
}

function memoryCountFor(text: string, tasks: readonly AuditTask[]): number {
  const signalWords = ["decision", "goal", "routine", "idea", "project", "startup", "client", "english", "crypto", "risk", "asset"];
  const signals = signalWords.filter((word) => text.toLowerCase().includes(word)).length;
  return Math.min(5, Math.max(tasks.length > 0 ? 1 : 0, signals));
}

function graphNodeCountFor(text: string, memoryCount: number, tasks: readonly AuditTask[]): number {
  const namedTopics = ["startup", "partner", "english", "x", "twitter", "crypto", "freelance", "routine", "asset"]
    .filter((word) => text.toLowerCase().includes(word)).length;
  return Math.min(7, Math.max(memoryCount, namedTopics + (tasks.length > 0 ? 1 : 0)));
}

function suggestionCountFor(text: string, tasks: readonly AuditTask[]): number {
  const wantsAdvice = /\b(?:idea|suggest|goal|routine|grow|improve|coach|risk|thesis|plan)\b/i.test(text);
  return wantsAdvice ? Math.max(1, Math.min(3, tasks.length + 1)) : 0;
}

function preview(text: string): string {
  return text.length <= 140 ? text : `${text.slice(0, 137)}...`;
}

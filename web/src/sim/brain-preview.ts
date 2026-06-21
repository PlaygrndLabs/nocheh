import type { AuditRecord } from "../api/client.js";
import type { SimEntry, UserEntry } from "../state/useSimulation.js";

export type PreviewStatus = "stored" | "pending" | "approved" | "blocked" | "simulated";

export interface PreviewMemory {
  readonly type: string;
  readonly title: string;
  readonly detail: string;
  readonly confidence: number;
  readonly status: PreviewStatus;
}

export interface PreviewEdge {
  readonly from: string;
  readonly relation: string;
  readonly to: string;
  readonly confidence: number;
}

export interface PreviewSuggestion {
  readonly kind: string;
  readonly title: string;
  readonly rationale: string;
  readonly impact: "low" | "medium" | "high";
  readonly risk: "low" | "medium" | "high";
  readonly status: PreviewStatus;
}

export interface PreviewGuardrail {
  readonly label: string;
  readonly detail: string;
  readonly status: "ok" | "warn" | "blocked";
}

export interface PreviewStage {
  readonly label: string;
  readonly detail: string;
  readonly status: "done" | "waiting" | "blocked";
}

export interface BrainPreview {
  readonly metrics: {
    readonly messages: number;
    readonly memories: number;
    readonly edges: number;
    readonly suggestions: number;
    readonly blocked: number;
    readonly estimatedTokens: number;
  };
  readonly memories: readonly PreviewMemory[];
  readonly edges: readonly PreviewEdge[];
  readonly suggestions: readonly PreviewSuggestion[];
  readonly guardrails: readonly PreviewGuardrail[];
  readonly stages: readonly PreviewStage[];
}

const BASE_MEMORIES: readonly PreviewMemory[] = [
  {
    type: "PersonalRule",
    title: "Approval before action",
    detail: "Replies, trades, tool changes, and external updates wait for Mak.",
    confidence: 1,
    status: "approved",
  },
  {
    type: "StyleRule",
    title: "Direct and practical tone",
    detail: "Drafts should sound concise, clear, and action-focused.",
    confidence: 0.78,
    status: "stored",
  },
];

export function buildBrainPreview(entries: readonly SimEntry[]): BrainPreview {
  const userEntries = entries.filter((entry): entry is UserEntry => entry.kind === "user");
  const records = entries
    .filter((entry): entry is Extract<SimEntry, { kind: "assistant" }> => entry.kind === "assistant")
    .map((entry) => entry.record);
  const text = userEntries.map((entry) => `${entry.sender}: ${entry.text}`).join("\n");
  const normalized = text.toLowerCase();

  const memories = dedupeMemories([
    ...BASE_MEMORIES,
    ...taskMemories(records),
    ...domainMemories(normalized),
    ...fallbackMemories(userEntries),
  ]);
  const edges = dedupeEdges([...domainEdges(normalized), ...taskEdges(records)]);
  const suggestions = dedupeSuggestions(domainSuggestions(normalized, records));
  const guardrails = buildGuardrails(normalized);
  const blocked = guardrails.filter((guardrail) => guardrail.status === "blocked").length
    + suggestions.filter((suggestion) => suggestion.status === "blocked").length;
  const estimatedTokens = Math.max(280, Math.round(text.length / 4) + memories.length * 42 + edges.length * 22);

  return {
    metrics: {
      messages: userEntries.length,
      memories: memories.length,
      edges: edges.length,
      suggestions: suggestions.length,
      blocked,
      estimatedTokens,
    },
    memories,
    edges,
    suggestions,
    guardrails,
    stages: buildStages(userEntries.length, memories.length, edges.length, suggestions.length, blocked),
  };
}

function taskMemories(records: readonly AuditRecord[]): PreviewMemory[] {
  return records.flatMap((record) => record.extractedTasks.filter((task) => task.accepted).map((task) => ({
    type: "Task",
    title: task.title || "Untitled task",
    detail: `Source ${record.platform}/${record.messageId}; sync ${task.syncStatus}.`,
    confidence: task.confidence,
    status: "stored" as const,
  })));
}

function domainMemories(text: string): PreviewMemory[] {
  const memories: PreviewMemory[] = [];
  if (hasAny(text, ["startup", "partner", "cofounder", "equity"])) {
    memories.push(memory("Project", "Startup context", "Track partner roles, decisions, risks, and strategic follow-ups.", 0.82));
    memories.push(memory("Person", "Startup partner", "Relationship node for role, ownership, promises, and open loops.", 0.72));
  }
  if (hasAny(text, ["freelance", "client", "invoice", "deliverable"])) {
    memories.push(memory("Project", "Freelance delivery", "Client work should retain deadlines, deliverables, invoices, and promises.", 0.84));
  }
  if (hasAny(text, ["english", "vocabulary", "grammar", "speaking"])) {
    memories.push(memory("LearningPlan", "English improvement", "Track practice routine, weak spots, vocabulary, and writing feedback.", 0.86));
    memories.push(memory("Routine", "English practice routine", "Small repeated practice should be reviewed and adjusted weekly.", 0.79));
  }
  if (hasAny(text, ["twitter", "x ", "x.com", "post", "thread", "audience"])) {
    memories.push(memory("ContentPlan", "X growth loop", "Capture content ideas, posting cadence, audience signal, and experiments.", 0.81));
  }
  if (hasAny(text, ["crypto", "trade", "trading", "btc", "eth", "wallet"])) {
    memories.push(memory("InvestmentThesis", "Crypto decision support", "Track thesis, risk rules, watchlist, and journal notes without auto-trading.", 0.76));
    memories.push(memory("Risk", "Trading risk", "High-risk financial suggestions require explicit approval and source evidence.", 0.91));
  }
  if (hasAny(text, ["routine", "habit", "morning", "weekly review", "daily"])) {
    memories.push(memory("RoutineExperiment", "Routine improvement", "Suggest one small experiment with trigger, action, and success signal.", 0.83, "pending"));
  }
  if (hasAny(text, ["asset", "domain", "subscription", "tool", "wallet"])) {
    memories.push(memory("Asset", "Owned resource", "Track ownership, renewal, account, project link, and risk.", 0.74));
  }
  if (hasAny(text, ["idea", "opportunity", "new product", "content idea"])) {
    memories.push(memory("Idea", "New idea candidate", "Store as suggestion until Mak accepts or converts it.", 0.77, "pending"));
  }
  return memories;
}

function fallbackMemories(userEntries: readonly UserEntry[]): PreviewMemory[] {
  if (userEntries.length === 0) {
    return [{
      type: "Preview",
      title: "No live input yet",
      detail: "Send a mock message or run a scenario to preview memory, graph, and suggestions.",
      confidence: 1,
      status: "simulated",
    }];
  }
  return [{
    type: "Summary",
    title: "Conversation signal",
    detail: `${userEntries.length} message${userEntries.length === 1 ? "" : "s"} ready for bounded analysis.`,
    confidence: 0.66,
    status: "stored",
  }];
}

function domainEdges(text: string): PreviewEdge[] {
  const edges: PreviewEdge[] = [
    edge("Mak", "HAS_RULE", "Approval before action", 1),
    edge("Mak", "USES", "Nocheh Brain", 1),
  ];
  if (hasAny(text, ["startup", "partner", "cofounder"])) {
    edges.push(edge("Startup partner", "WORKS_ON", "Startup context", 0.78));
    edges.push(edge("Startup context", "HAS_RISK", "Strategic decision", 0.71));
  }
  if (hasAny(text, ["english", "vocabulary", "grammar", "speaking"])) {
    edges.push(edge("English improvement", "GOAL_HAS_ROUTINE", "English practice routine", 0.83));
    edges.push(edge("English improvement", "BUILDS_SKILL", "Communication", 0.8));
  }
  if (hasAny(text, ["twitter", "x ", "post", "thread"])) {
    edges.push(edge("X growth loop", "SUPPORTS_GOAL", "Audience growth", 0.76));
  }
  if (hasAny(text, ["crypto", "trade", "trading", "btc", "eth"])) {
    edges.push(edge("Crypto decision support", "HAS_RISK", "Trading risk", 0.92));
  }
  if (hasAny(text, ["routine", "habit", "weekly review", "daily"])) {
    edges.push(edge("Routine improvement", "SUPPORTS_AREA", "Personal operating system", 0.81));
  }
  if (hasAny(text, ["idea", "opportunity", "new product"])) {
    edges.push(edge("New idea candidate", "MAY_BECOME", "Project", 0.69));
  }
  return edges;
}

function taskEdges(records: readonly AuditRecord[]): PreviewEdge[] {
  return records.flatMap((record) => record.extractedTasks.filter((task) => task.accepted).map((task) =>
    edge("Conversation", "CREATED_TASK", task.title || record.messageId, task.confidence),
  ));
}

function domainSuggestions(text: string, records: readonly AuditRecord[]): PreviewSuggestion[] {
  const suggestions: PreviewSuggestion[] = [];
  const taskCount = records.reduce((count, record) => count + record.extractedTasks.filter((task) => task.accepted).length, 0);
  if (taskCount > 0) {
    suggestions.push(suggestion("Task", "Review extracted task before sync", "Keep external task sync human-visible while confidence is still simulated.", "medium", "low"));
  }
  if (hasAny(text, ["startup", "partner", "cofounder"])) {
    suggestions.push(suggestion("Goal", "Define next startup decision", "A partner/startup thread needs a clear owner, risk, and next decision point.", "high", "medium"));
  }
  if (hasAny(text, ["english", "vocabulary", "grammar", "speaking"])) {
    suggestions.push(suggestion("Routine", "Run a 15-minute English loop", "Daily small practice is easier to sustain than broad study goals.", "medium", "low"));
  }
  if (hasAny(text, ["twitter", "x ", "post", "thread"])) {
    suggestions.push(suggestion("Idea", "Draft three X post angles", "Turn the conversation into content tests before committing to a full plan.", "medium", "low"));
  }
  if (hasAny(text, ["crypto", "trade", "trading", "btc", "eth"])) {
    suggestions.push(suggestion("Risk", "Create trade thesis, do not execute", "Trading support should capture risk and decision context, not place trades.", "high", "high", "blocked"));
  }
  if (hasAny(text, ["routine", "habit", "weekly review", "daily"])) {
    suggestions.push(suggestion("Experiment", "Try one routine experiment", "Use trigger, action, review cadence, and success signal.", "medium", "low"));
  }
  if (suggestions.length === 0) {
    suggestions.push(suggestion("Question", "Ask for missing context", "The assistant should clarify goal, owner, deadline, or desired outcome before acting.", "low", "low"));
  }
  return suggestions;
}

function buildGuardrails(text: string): PreviewGuardrail[] {
  return [
    {
      label: "Raw chat retention",
      detail: "Durable memory stores structured facts and source references, not full chat history.",
      status: "ok",
    },
    {
      label: "Approval gate",
      detail: "Replies, external actions, routine changes, and high-impact suggestions stay pending.",
      status: "ok",
    },
    {
      label: "Cost budget",
      detail: "Context uses recent messages, retrieved memories, graph neighborhood, and token limits.",
      status: "ok",
    },
    hasAny(text, ["crypto", "trade", "trading", "btc", "eth"])
      ? {
        label: "Trading boundary",
        detail: "Auto-trading is blocked; Nocheh only records thesis, rules, and risk.",
        status: "blocked",
      }
      : {
        label: "Trading boundary",
        detail: "Financial actions require explicit approval and risk evidence.",
        status: "warn",
      },
  ];
}

function buildStages(messages: number, memories: number, edges: number, suggestions: number, blocked: number): PreviewStage[] {
  return [
    { label: "Read", detail: messages === 0 ? "Waiting for mock input" : `${messages} incoming message${messages === 1 ? "" : "s"}`, status: messages === 0 ? "waiting" : "done" },
    { label: "Sanitize", detail: "Secrets and sensitive tokens redacted before persistence", status: "done" },
    { label: "Remember", detail: `${memories} structured memory candidate${memories === 1 ? "" : "s"}`, status: memories === 0 ? "waiting" : "done" },
    { label: "Connect", detail: `${edges} knowledge graph edge${edges === 1 ? "" : "s"}`, status: edges === 0 ? "waiting" : "done" },
    { label: "Suggest", detail: `${suggestions} pending suggestion${suggestions === 1 ? "" : "s"}`, status: suggestions === 0 ? "waiting" : "done" },
    { label: "Approve", detail: blocked > 0 ? `${blocked} blocked/high-risk item${blocked === 1 ? "" : "s"}` : "External action waits for Mak", status: blocked > 0 ? "blocked" : "waiting" },
  ];
}

function memory(type: string, title: string, detail: string, confidence: number, status: PreviewStatus = "stored"): PreviewMemory {
  return { type, title, detail, confidence, status };
}

function edge(from: string, relation: string, to: string, confidence: number): PreviewEdge {
  return { from, relation, to, confidence };
}

function suggestion(
  kind: string,
  title: string,
  rationale: string,
  impact: PreviewSuggestion["impact"],
  risk: PreviewSuggestion["risk"],
  status: PreviewStatus = "pending",
): PreviewSuggestion {
  return { kind, title, rationale, impact, risk, status };
}

function hasAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function dedupeMemories(memories: readonly PreviewMemory[]): readonly PreviewMemory[] {
  return uniqueBy(memories, (memory) => `${memory.type}:${memory.title}`).slice(0, 10);
}

function dedupeEdges(edges: readonly PreviewEdge[]): readonly PreviewEdge[] {
  return uniqueBy(edges, (edge) => `${edge.from}:${edge.relation}:${edge.to}`).slice(0, 12);
}

function dedupeSuggestions(suggestions: readonly PreviewSuggestion[]): readonly PreviewSuggestion[] {
  return uniqueBy(suggestions, (suggestion) => `${suggestion.kind}:${suggestion.title}`).slice(0, 8);
}

function uniqueBy<T>(items: readonly T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyFor(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

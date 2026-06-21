/** Typed wrapper around the backend JSON API. Throws on non-ok responses. */

export interface SetupStatus {
  ok: boolean;
  hasAiKey: boolean;
  aiProvider?: string;
  hasBotToken: boolean;
  botConnected: boolean;
  webhookUrl?: string;
  encryptionConfigured: boolean;
}

export interface EnvPresence {
  ok: boolean;
  keys: Record<string, "set" | "unset">;
}

export interface BotInfo {
  id: number;
  username?: string;
  firstName: string;
}

export interface MetricsSnapshot {
  messagesProcessed: number;
  tasksExtracted: number;
  extractionSuccessRate: number;
  syncSuccessRate: number;
  averageConfidence: number;
  redactionEvents: number;
  averageProcessingLatencyMs: number;
}

export interface AuditStep {
  name: string;
  status: "started" | "succeeded" | "failed" | "skipped";
  durationMs: number;
  metadata: Record<string, string | number | boolean | null>;
  errorMessage?: string;
}

export interface AuditTask {
  title: string;
  confidence: number;
  extractionReason: string;
  accepted: boolean;
  syncStatus: "not_attempted" | "succeeded" | "failed";
  warnings: { code: string }[];
}

export interface AiTokenUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AuditRecord {
  id: string;
  platform: string;
  conversationId: string;
  messageId: string;
  processedAt: string;
  redactedContentPreview: string;
  redactionFindingCount: number;
  steps: AuditStep[];
  extractedTasks: AuditTask[];
  errorLogs: string[];
  totalLatencyMs: number;
  aiTokenUsage?: AiTokenUsage;
}

export interface ConversationSummary {
  conversationId: string;
  platform: string;
  messageCount: number;
  lastProcessedAt: string;
  lastPreview: string;
}

export interface GroupSettings {
  conversationId: string;
  analysisMode: "immediate" | "batch";
  analysisIntervalSeconds: number;
  maxMessagesPerBatch: number;
  maxAiContextTokens: number;
  maxRetrievedMemories: number;
  maxRecentMessages: number;
  summaryEveryMessages: number;
  summaryEveryMinutes: number;
  replyMode: "silent" | "mention" | "active" | "digest";
}

export interface BrainGraphNode {
  id: string;
  kind: string;
  label: string;
  status: string;
  confidence: number;
}

export interface BrainGraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  relation: string;
  status: string;
  confidence: number;
  fact: string;
}

export interface BrainSuggestion {
  id: string;
  type: "strategic" | "action";
  kind: string;
  title: string;
  rationale: string;
  status: "pending" | "accepted" | "rejected" | "archived" | "converted";
  riskLevel: "low" | "medium" | "high";
  confidence: number;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json()) as T & { ok?: boolean; error?: string };
  if (!response.ok || data.ok === false) {
    throw new Error(data.error ?? `Request failed: ${method} ${path}`);
  }
  return data;
}

export const api = {
  getSetupStatus: () => request<SetupStatus>("GET", "/api/setup/status"),
  getEnv: () => request<EnvPresence>("GET", "/api/env"),
  putEnv: (values: Record<string, string>) =>
    request<{ ok: boolean; updated: string[]; rejected: string[] }>("PUT", "/api/env", { values }),
  connectBot: (token: string, webhookUrl: string) =>
    request<{ ok: boolean; bot: BotInfo; webhookUrl: string }>("POST", "/api/telegram/connect", { token, webhookUrl }),
  getBotStatus: () => request<{ ok: boolean; connected: boolean; bot?: BotInfo }>("GET", "/api/telegram/status"),
  importHistory: (payload: { rawExport?: unknown; messages?: unknown; options?: { chunkMessageCount?: number; chunkDays?: number } }) =>
    request<{ ok: boolean; importedMessageCount: number; processedChunkCount: number; redactedFindingCount: number }>(
      "POST",
      "/api/history/import",
      payload,
    ),
  injectMock: (messages: { conversationId: string; text: string; senderDisplayName?: string }[]) =>
    request<{ ok: boolean; results: unknown[] }>("POST", "/api/mock/inject", { messages }),
  flushMock: (conversationId: string) =>
    request<{ ok: boolean; flushedMessageCount: number }>("POST", "/api/mock/flush", { conversationId }),
  getSettings: (conversationId: string) =>
    request<{ ok: boolean; settings: GroupSettings; isDefault: boolean }>("GET", `/api/settings/${encodeURIComponent(conversationId)}`),
  putSettings: (conversationId: string, settings: Partial<GroupSettings>) =>
    request<{ ok: boolean; settings: GroupSettings }>("PUT", `/api/settings/${encodeURIComponent(conversationId)}`, settings),
  getMetrics: () => request<{ ok: boolean; metrics: MetricsSnapshot }>("GET", "/api/metrics"),
  getConversations: () => request<{ ok: boolean; conversations: ConversationSummary[] }>("GET", "/api/conversations"),
  getConversation: (conversationId: string) =>
    request<{ ok: boolean; conversationId: string; records: AuditRecord[] }>(
      "GET",
      `/api/conversations/${encodeURIComponent(conversationId)}`,
    ),
  getBrainGraph: () =>
    request<{ nodes: BrainGraphNode[]; edges: BrainGraphEdge[] }>("GET", "/api/brain/graph"),
  getBrainSuggestions: (status = "pending") =>
    request<{ suggestions: BrainSuggestion[] }>("GET", `/api/brain/suggestions?status=${encodeURIComponent(status)}`),
  approveBrainSuggestion: (id: string) =>
    request<{ suggestion: BrainSuggestion }>("POST", `/api/brain/suggestions/${encodeURIComponent(id)}/approve`),
  rejectBrainSuggestion: (id: string) =>
    request<{ suggestion: BrainSuggestion }>("POST", `/api/brain/suggestions/${encodeURIComponent(id)}/reject`),
  archiveBrainSuggestion: (id: string) =>
    request<{ suggestion: BrainSuggestion }>("POST", `/api/brain/suggestions/${encodeURIComponent(id)}/archive`),
  editBrainSuggestion: (id: string, patch: Partial<Pick<BrainSuggestion, "title" | "rationale" | "riskLevel">>) =>
    request<{ suggestion: BrainSuggestion }>("PUT", `/api/brain/suggestions/${encodeURIComponent(id)}`, patch),
};

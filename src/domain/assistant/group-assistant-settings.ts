export type MessageAnalysisMode = "immediate" | "batch";
export type AssistantReplyMode = "silent" | "mention" | "active" | "digest";

export interface GroupAssistantSettings {
  readonly conversationId: string;
  readonly analysisMode: MessageAnalysisMode;
  readonly analysisIntervalSeconds: number;
  readonly maxMessagesPerBatch: number;
  readonly maxAiContextTokens: number;
  readonly maxRetrievedMemories: number;
  readonly maxRecentMessages: number;
  readonly summaryEveryMessages: number;
  readonly summaryEveryMinutes: number;
  readonly replyMode: AssistantReplyMode;
  readonly updatedAt: Date;
}

export interface CreateGroupAssistantSettingsInput {
  readonly conversationId: string;
  readonly analysisMode?: MessageAnalysisMode;
  readonly analysisIntervalSeconds?: number;
  readonly maxMessagesPerBatch?: number;
  readonly maxAiContextTokens?: number;
  readonly maxRetrievedMemories?: number;
  readonly maxRecentMessages?: number;
  readonly summaryEveryMessages?: number;
  readonly summaryEveryMinutes?: number;
  readonly replyMode?: AssistantReplyMode;
}

export const DEFAULT_GROUP_ASSISTANT_SETTINGS: Omit<GroupAssistantSettings, "conversationId" | "updatedAt"> = {
  analysisMode: "batch",
  analysisIntervalSeconds: 300,
  maxMessagesPerBatch: 50,
  maxAiContextTokens: 4000,
  maxRetrievedMemories: 12,
  maxRecentMessages: 30,
  summaryEveryMessages: 100,
  summaryEveryMinutes: 60,
  replyMode: "mention",
};

export function createGroupAssistantSettings(
  input: CreateGroupAssistantSettingsInput,
  now: Date,
): GroupAssistantSettings {
  return {
    conversationId: input.conversationId,
    analysisMode: input.analysisMode ?? DEFAULT_GROUP_ASSISTANT_SETTINGS.analysisMode,
    analysisIntervalSeconds: positiveInteger(input.analysisIntervalSeconds, DEFAULT_GROUP_ASSISTANT_SETTINGS.analysisIntervalSeconds),
    maxMessagesPerBatch: positiveInteger(input.maxMessagesPerBatch, DEFAULT_GROUP_ASSISTANT_SETTINGS.maxMessagesPerBatch),
    maxAiContextTokens: positiveInteger(input.maxAiContextTokens, DEFAULT_GROUP_ASSISTANT_SETTINGS.maxAiContextTokens),
    maxRetrievedMemories: positiveInteger(input.maxRetrievedMemories, DEFAULT_GROUP_ASSISTANT_SETTINGS.maxRetrievedMemories),
    maxRecentMessages: positiveInteger(input.maxRecentMessages, DEFAULT_GROUP_ASSISTANT_SETTINGS.maxRecentMessages),
    summaryEveryMessages: positiveInteger(input.summaryEveryMessages, DEFAULT_GROUP_ASSISTANT_SETTINGS.summaryEveryMessages),
    summaryEveryMinutes: positiveInteger(input.summaryEveryMinutes, DEFAULT_GROUP_ASSISTANT_SETTINGS.summaryEveryMinutes),
    replyMode: input.replyMode ?? DEFAULT_GROUP_ASSISTANT_SETTINGS.replyMode,
    updatedAt: now,
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isInteger(value) || value <= 0 ? fallback : value;
}

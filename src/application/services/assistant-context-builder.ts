import type { IncomingMessage } from "../dto/incoming-message.js";
import type { MemoryRetrievalPort } from "../ports/memory-retrieval.js";
import type { GroupAssistantSettings } from "../../domain/assistant/group-assistant-settings.js";
import { memoryRecordText, type MemoryRecord } from "../../domain/memory/memory-record.js";

export interface AssistantContext {
  readonly conversationId: string;
  readonly currentMessages: readonly IncomingMessage[];
  readonly memories: readonly MemoryRecord[];
  readonly tokenBudget: number;
  readonly text: string;
}

/** Builds small AI-ready context from current messages plus retrieved structured memory. */
export class AssistantContextBuilder {
  public constructor(private readonly retrieval: MemoryRetrievalPort) {}

  public async build(
    messages: readonly IncomingMessage[],
    settings: GroupAssistantSettings,
  ): Promise<AssistantContext> {
    const currentMessages = messages.slice(-settings.maxRecentMessages);
    const queryText = currentMessages.map((message) => message.text).join("\n");
    const memories = queryText.trim().length === 0
      ? []
      : await this.retrieval.query({
        text: queryText,
        limit: settings.maxRetrievedMemories,
        minimumScore: 0.03,
      });

    const memoryRecords = memories.map((result) => result.record);
    return {
      conversationId: settings.conversationId,
      currentMessages,
      memories: memoryRecords,
      tokenBudget: settings.maxAiContextTokens,
      text: this.render(currentMessages, memoryRecords, settings.maxAiContextTokens),
    };
  }

  private render(
    messages: readonly IncomingMessage[],
    memories: readonly MemoryRecord[],
    maxTokens: number,
  ): string {
    const sections = [
      "Relevant structured memory:",
      memories.length === 0
        ? "none"
        : memories.map((record) => `- ${record.type}: ${memoryRecordText(record)}`).join("\n"),
      "",
      "Current messages:",
      messages.map((message) => `- ${message.occurredAt.toISOString()} ${message.senderDisplayName ?? message.senderId}: ${message.text}`).join("\n"),
    ];

    return trimToApproxTokens(sections.join("\n"), maxTokens);
  }
}

function trimToApproxTokens(text: string, maxTokens: number): string {
  const maxChars = Math.max(1, maxTokens) * 4;
  return text.length <= maxChars ? text : text.slice(0, maxChars - 3).trimEnd() + "...";
}

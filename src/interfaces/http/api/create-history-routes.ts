import type {
  HistoryImportMessage,
  HistoryImportService,
} from "../../../application/services/history-import-service.js";
import { parseTelegramExport } from "../../../infrastructure/messaging/telegram/telegram-export-parser.js";
import type { JsonHandler } from "../router.js";

export { parseTelegramExport } from "../../../infrastructure/messaging/telegram/telegram-export-parser.js";

const DEFAULT_OPTIONS = { chunkMessageCount: 50, chunkDays: 7 } as const;

export interface HistoryRoutes {
  readonly importHistory: JsonHandler;
}

/** Route for one-time history backfill from a Telegram export or explicit messages. */
export function createHistoryRoutes(service: HistoryImportService): HistoryRoutes {
  return {
    importHistory: async ({ body }) => {
      const payload = (body ?? {}) as {
        messages?: unknown;
        rawExport?: unknown;
        options?: { chunkMessageCount?: number; chunkDays?: number };
      };

      let messages: HistoryImportMessage[];
      try {
        messages = Array.isArray(payload.messages)
          ? payload.messages.map(toHistoryMessage)
          : parseTelegramExport(payload.rawExport);
      } catch (error) {
        return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
      }

      if (messages.length === 0) {
        return { status: 400, body: { ok: false, error: "No importable messages found" } };
      }

      const result = await service.importMessages(messages, {
        chunkMessageCount: payload.options?.chunkMessageCount ?? DEFAULT_OPTIONS.chunkMessageCount,
        chunkDays: payload.options?.chunkDays ?? DEFAULT_OPTIONS.chunkDays,
      });
      return { status: 200, body: { ok: true, ...result } };
    },
  };
}

function toHistoryMessage(raw: unknown): HistoryImportMessage {
  const message = raw as Partial<Record<keyof HistoryImportMessage, unknown>>;
  if (typeof message.conversationId !== "string" || typeof message.messageId !== "string" || typeof message.text !== "string") {
    throw new Error("Each message requires conversationId, messageId and text");
  }
  const occurredAt = message.occurredAt === undefined ? new Date() : new Date(message.occurredAt as string);
  return {
    platform: typeof message.platform === "string" ? message.platform : "telegram",
    conversationId: message.conversationId,
    messageId: message.messageId,
    senderId: typeof message.senderId === "string" ? message.senderId : "unknown",
    ...(typeof message.senderDisplayName === "string" ? { senderDisplayName: message.senderDisplayName } : {}),
    text: message.text,
    occurredAt,
  };
}

import type {
  HistoryImportMessage,
  HistoryImportService,
} from "../../../application/services/history-import-service.js";
import type { JsonHandler } from "../router.js";

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

interface TelegramExportMessage {
  readonly id?: number;
  readonly type?: string;
  readonly date?: string;
  readonly date_unixtime?: string;
  readonly from?: string;
  readonly from_id?: string;
  readonly text?: unknown;
}

/** Maps a Telegram Desktop export (single chat: `{ id, name, messages: [...] }`). */
export function parseTelegramExport(raw: unknown): HistoryImportMessage[] {
  if (raw === undefined || raw === null || typeof raw !== "object") {
    throw new Error("Provide `messages` or a Telegram export object in `rawExport`");
  }

  const chat = raw as { id?: number | string; name?: string; messages?: unknown };
  if (!Array.isArray(chat.messages)) {
    throw new Error("Telegram export is missing a `messages` array");
  }

  const conversationId = `telegram:${chat.id ?? chat.name ?? "import"}`;
  const messages: HistoryImportMessage[] = [];
  for (const entry of chat.messages as TelegramExportMessage[]) {
    if (entry.type !== undefined && entry.type !== "message") {
      continue;
    }
    const text = flattenText(entry.text);
    if (text.trim().length === 0) {
      continue;
    }
    messages.push({
      platform: "telegram",
      conversationId,
      messageId: String(entry.id ?? messages.length),
      senderId: entry.from_id ?? entry.from ?? "unknown",
      ...(entry.from === undefined ? {} : { senderDisplayName: entry.from }),
      text,
      occurredAt: parseDate(entry),
    });
  }
  return messages;
}

/** Telegram export `text` may be a string or an array of strings / entity objects. */
function flattenText(text: unknown): string {
  if (typeof text === "string") {
    return text;
  }
  if (Array.isArray(text)) {
    return text
      .map((part) => (typeof part === "string" ? part : typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .join("");
  }
  return "";
}

function parseDate(entry: TelegramExportMessage): Date {
  if (entry.date_unixtime !== undefined) {
    return new Date(Number(entry.date_unixtime) * 1000);
  }
  if (entry.date !== undefined) {
    return new Date(entry.date);
  }
  return new Date();
}

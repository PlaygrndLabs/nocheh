import type { HistoryImportMessage } from "../../../application/services/history-import-service.js";

interface TelegramExportMessage {
  readonly id?: number;
  readonly type?: string;
  readonly date?: string;
  readonly date_unixtime?: string;
  readonly from?: string;
  readonly from_id?: string;
  readonly text?: unknown;
}

/** Maps a Telegram Desktop JSON export without reading referenced media files. */
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

import { Buffer } from "node:buffer";
import type { IncomingMessage as HttpIncomingMessage, ServerResponse } from "node:http";
import type { IncomingMessageProcessorPort } from "../../application/ports/incoming-message-processor.js";
import { TelegramUpdateMapper, type TelegramUpdate } from "../../infrastructure/messaging/telegram/telegram-update-mapper.js";
import type { LoggerPort } from "../../application/ports/logger.js";

export interface TelegramWebhookAuthOptions {
  readonly allowedChatIds?: ReadonlySet<string> | (() => ReadonlySet<string>);
  readonly allowedUserIds?: ReadonlySet<string> | (() => ReadonlySet<string>);
}

/** HTTP handler for Telegram webhook requests. */
export function createTelegramWebhookHandler(
  processor: IncomingMessageProcessorPort,
  logger: LoggerPort,
  auth: TelegramWebhookAuthOptions = {},
): (request: HttpIncomingMessage, response: ServerResponse) => Promise<void> {
  const mapper = new TelegramUpdateMapper();

  return async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }

    try {
      const update = JSON.parse(await readBody(request)) as TelegramUpdate;
      const message = mapper.toIncomingMessage(update);
      if (message !== undefined) {
        if (isTelegramMessageAllowed(message.conversationId, message.senderId, auth)) {
          await processor.execute(message);
        } else {
          logger.warn("Telegram message ignored by allow-list", {
            conversationId: message.conversationId,
            senderId: message.senderId,
          });
        }
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    } catch (error) {
      logger.error("Telegram webhook processing failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
    }
  };
}

export function isTelegramMessageAllowed(
  chatId: string,
  userId: string,
  auth: TelegramWebhookAuthOptions,
): boolean {
  const allowedChatIds = resolveAllowedSet(auth.allowedChatIds);
  const allowedUserIds = resolveAllowedSet(auth.allowedUserIds);
  const chatRestricted = allowedChatIds.size > 0;
  const userRestricted = allowedUserIds.size > 0;
  if (!chatRestricted && !userRestricted) {
    return true;
  }
  return (!chatRestricted || allowedChatIds.has(chatId)) && (!userRestricted || allowedUserIds.has(userId));
}

function resolveAllowedSet(value: ReadonlySet<string> | (() => ReadonlySet<string>) | undefined): ReadonlySet<string> {
  if (value === undefined) {
    return new Set<string>();
  }
  return typeof value === "function" ? value() : value;
}

async function readBody(request: HttpIncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

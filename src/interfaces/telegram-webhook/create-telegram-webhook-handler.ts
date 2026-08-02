import { Buffer } from "node:buffer";
import type { IncomingMessage as HttpIncomingMessage, ServerResponse } from "node:http";
import type {
  IncomingMessageProcessorPort,
  NoteProcessorPort,
  ReactionProcessorPort,
} from "../../application/ports/incoming-message-processor.js";
import { TelegramUpdateMapper, type TelegramUpdate } from "../../infrastructure/messaging/telegram/telegram-update-mapper.js";
import type { LoggerPort } from "../../application/ports/logger.js";

export interface TelegramWebhookAuthOptions {
  readonly allowedChatIds?: ReadonlySet<string> | (() => ReadonlySet<string>);
  readonly allowedUserIds?: ReadonlySet<string> | (() => ReadonlySet<string>);
}

const NOTE_COMMAND = /^\/note(?:@\w+)?\s+([\s\S]+)$/;

/** HTTP handler for Telegram webhook requests (messages, /note commands, and reactions). */
export function createTelegramWebhookHandler(
  processor: IncomingMessageProcessorPort & ReactionProcessorPort & NoteProcessorPort,
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
          const noteMatch = NOTE_COMMAND.exec(message.text);
          if (noteMatch?.[1] !== undefined) {
            await processor.executeNote({
              conversationId: message.conversationId,
              text: noteMatch[1].trim(),
              authorId: message.senderId,
              ...(message.senderDisplayName === undefined ? {} : { authorDisplayName: message.senderDisplayName }),
              occurredAt: message.occurredAt,
            });
          } else {
            await processor.execute(message);
          }
        } else {
          logger.warn("Telegram message ignored by allow-list", {
            conversationId: message.conversationId,
            senderId: message.senderId,
          });
        }
      } else {
        const reaction = mapper.toIncomingReaction(update);
        if (reaction !== undefined) {
          if (isTelegramMessageAllowed(reaction.conversationId, reaction.reactorId, auth)) {
            await processor.executeReaction(reaction);
          } else {
            logger.warn("Telegram reaction ignored by allow-list", {
              conversationId: reaction.conversationId,
              reactorId: reaction.reactorId,
            });
          }
        } else {
          // Telegram only retries on a non-2xx, so an unhandled update is gone for
          // good. Log it: a silent drop is indistinguishable from a delivery failure.
          logger.warn("Telegram update ignored: no supported content", {
            updateId: update.update_id,
            reason: mapper.describeUnsupportedUpdate(update),
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

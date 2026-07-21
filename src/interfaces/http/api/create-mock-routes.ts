import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "../../../application/dto/incoming-message.js";
import type { IncomingReactionEvent } from "../../../application/dto/incoming-reaction-event.js";
import type { ClockPort } from "../../../application/ports/clock.js";
import type { LiveMessageBufferService } from "../../../application/services/live-message-buffer-service.js";
import type { JsonHandler } from "../router.js";

export interface MockRoutes {
  readonly inject: JsonHandler;
  readonly flush: JsonHandler;
  readonly reaction: JsonHandler;
}

interface MockMessageInput {
  readonly conversationId?: unknown;
  readonly messageId?: unknown;
  readonly text?: unknown;
  readonly senderId?: unknown;
  readonly senderDisplayName?: unknown;
  readonly occurredAt?: unknown;
  readonly replyToMessageId?: unknown;
}

/**
 * Routes that feed synthetic messages and reactions through the exact processor path the
 * Telegram webhook uses, so the client can dry-run the pipeline.
 */
export function createMockRoutes(processor: LiveMessageBufferService, clock: ClockPort): MockRoutes {
  return {
    inject: async ({ body }) => {
      const rawMessages = (body as { messages?: unknown } | undefined)?.messages;
      if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
        return { status: 400, body: { ok: false, error: "Expected a non-empty { messages: [...] } array" } };
      }

      const results: unknown[] = [];
      for (const raw of rawMessages as MockMessageInput[]) {
        if (typeof raw.conversationId !== "string" || typeof raw.text !== "string") {
          return { status: 400, body: { ok: false, error: "Each message requires conversationId and text" } };
        }
        const message: IncomingMessage = {
          platform: "mock",
          conversationId: raw.conversationId,
          messageId: typeof raw.messageId === "string" && raw.messageId.length > 0 ? raw.messageId : `mock:${randomUUID()}`,
          senderId: typeof raw.senderId === "string" ? raw.senderId : "mock-user",
          ...(typeof raw.senderDisplayName === "string" ? { senderDisplayName: raw.senderDisplayName } : {}),
          ...(typeof raw.replyToMessageId === "string" ? { replyToMessageId: raw.replyToMessageId } : {}),
          text: raw.text,
          occurredAt: typeof raw.occurredAt === "string" ? new Date(raw.occurredAt) : clock.now(),
        };
        results.push(await processor.execute(message));
      }

      return { status: 200, body: { ok: true, results } };
    },

    flush: async ({ body }) => {
      const conversationId = (body as { conversationId?: unknown } | undefined)?.conversationId;
      if (typeof conversationId !== "string" || conversationId.length === 0) {
        return { status: 400, body: { ok: false, error: "Expected { conversationId: string }" } };
      }
      const flushedMessageCount = await processor.flush(conversationId);
      return { status: 200, body: { ok: true, flushedMessageCount } };
    },

    reaction: async ({ body }) => {
      const input = body as {
        conversationId?: unknown;
        targetMessageId?: unknown;
        emojis?: unknown;
        emoji?: unknown;
        reactorId?: unknown;
        reactorDisplayName?: unknown;
      } | undefined;
      if (typeof input?.conversationId !== "string" || typeof input.targetMessageId !== "string") {
        return { status: 400, body: { ok: false, error: "Expected { conversationId, targetMessageId }" } };
      }
      const emojis = normalizeEmojis(input.emojis, input.emoji);
      if (emojis.length === 0) {
        return { status: 400, body: { ok: false, error: "Expected at least one emoji or emojis[]" } };
      }
      const reactorId = typeof input.reactorId === "string" ? input.reactorId : "mock-user";
      const event: IncomingReactionEvent = {
        platform: "mock",
        conversationId: input.conversationId,
        targetMessageId: input.targetMessageId,
        reactorId,
        ...(typeof input.reactorDisplayName === "string" ? { reactorDisplayName: input.reactorDisplayName } : {}),
        reactions: emojis.map((emoji) => ({ emoji, reactorId })),
        occurredAt: clock.now(),
      };
      const result = await processor.executeReaction(event);
      return { status: 200, body: { ok: true, result } };
    },
  };
}

function normalizeEmojis(emojis: unknown, emoji: unknown): readonly string[] {
  if (Array.isArray(emojis)) {
    return emojis.filter((value): value is string => typeof value === "string" && value.length > 0);
  }
  return typeof emoji === "string" && emoji.length > 0 ? [emoji] : [];
}

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "../../../application/dto/incoming-message.js";
import type { ClockPort } from "../../../application/ports/clock.js";
import type { LiveMessageBufferService } from "../../../application/services/live-message-buffer-service.js";
import type { JsonHandler } from "../router.js";

export interface MockRoutes {
  readonly inject: JsonHandler;
  readonly flush: JsonHandler;
}

interface MockMessageInput {
  readonly conversationId?: unknown;
  readonly text?: unknown;
  readonly senderId?: unknown;
  readonly senderDisplayName?: unknown;
  readonly occurredAt?: unknown;
}

/**
 * Routes that feed synthetic messages through the exact processor path the
 * Telegram webhook uses, so the dashboard can dry-run the pipeline.
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
          messageId: `mock:${randomUUID()}`,
          senderId: typeof raw.senderId === "string" ? raw.senderId : "mock-user",
          ...(typeof raw.senderDisplayName === "string" ? { senderDisplayName: raw.senderDisplayName } : {}),
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
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "../src/application/dto/incoming-message.js";
import type { ClockPort } from "../src/application/ports/clock.js";
import type { IncomingMessageProcessorPort } from "../src/application/ports/incoming-message-processor.js";
import type { LoggerPort } from "../src/application/ports/logger.js";
import { HistoryImportService } from "../src/application/services/history-import-service.js";
import { RegexSecretDetector } from "../src/infrastructure/security/regex-secret-detector.js";

class FixedClock implements ClockPort {
  public now(): Date {
    return new Date("2026-06-19T12:00:00.000Z");
  }
}

class SilentLogger implements LoggerPort {
  public info(): void {}
  public warn(): void {}
  public error(): void {}
}

class RecordingProcessor implements IncomingMessageProcessorPort {
  public readonly messages: IncomingMessage[] = [];

  public async execute(message: IncomingMessage): Promise<void> {
    this.messages.push(message);
  }
}

test("imports history in redacted chunks instead of one full-history message", async () => {
  const processor = new RecordingProcessor();
  const service = new HistoryImportService(
    processor,
    new RegexSecretDetector(),
    new FixedClock(),
    new SilentLogger(),
  );

  const result = await service.importMessages([
    historyMessage("1", "Project: Atlas"),
    historyMessage("2", "Decision: use small chunks sk_live_abcdefghijklmnopqrstuvwxyz"),
    historyMessage("3", "Task: summarize old data"),
  ], {
    chunkMessageCount: 2,
    chunkDays: 30,
  });

  assert.equal(result.importedMessageCount, 3);
  assert.equal(result.processedChunkCount, 2);
  assert.equal(result.redactedFindingCount, 1);
  assert.equal(processor.messages.length, 2);
  assert.equal(processor.messages[0]?.messageId, "history:1-2");
  assert.equal(processor.messages[1]?.messageId, "history:3-3");
  assert.doesNotMatch(processor.messages[0]?.text ?? "", /sk_live/);
  assert.match(processor.messages[0]?.text ?? "", /\[REDACTED:api_key\]/);
});

function historyMessage(messageId: string, text: string) {
  return {
    platform: "telegram",
    conversationId: "chat-1",
    messageId,
    senderId: "7",
    text,
    occurredAt: new Date(`2026-06-19T12:00:0${messageId}.000Z`),
  };
}

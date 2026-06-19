import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "../src/application/dto/incoming-message.js";
import type { ClockPort } from "../src/application/ports/clock.js";
import type { GroupAssistantSettingsRepositoryPort } from "../src/application/ports/group-assistant-settings-repository.js";
import type { IncomingMessageProcessorPort } from "../src/application/ports/incoming-message-processor.js";
import type { LiveMessageBufferRepositoryPort } from "../src/application/ports/live-message-buffer-repository.js";
import type { LoggerPort } from "../src/application/ports/logger.js";
import { LiveMessageBufferService } from "../src/application/services/live-message-buffer-service.js";
import type { BufferedMessage } from "../src/domain/assistant/buffered-message.js";
import { createGroupAssistantSettings, type GroupAssistantSettings } from "../src/domain/assistant/group-assistant-settings.js";
import { RegexSecretDetector } from "../src/infrastructure/security/regex-secret-detector.js";

class MutableClock implements ClockPort {
  public current = new Date("2026-06-19T12:00:00.000Z");

  public now(): Date {
    return this.current;
  }
}

class SilentLogger implements LoggerPort {
  public info(): void {}
  public warn(): void {}
  public error(): void {}
}

class InMemorySettingsRepository implements GroupAssistantSettingsRepositoryPort {
  public readonly settings = new Map<string, GroupAssistantSettings>();

  public async save(settings: GroupAssistantSettings): Promise<void> {
    this.settings.set(settings.conversationId, settings);
  }

  public async findByConversationId(conversationId: string): Promise<GroupAssistantSettings | undefined> {
    return this.settings.get(conversationId);
  }
}

class InMemoryBufferRepository implements LiveMessageBufferRepositoryPort {
  public readonly messages: BufferedMessage[] = [];

  public async append(message: BufferedMessage): Promise<void> {
    this.messages.push(message);
  }

  public async findByConversationId(conversationId: string): Promise<readonly BufferedMessage[]> {
    return this.messages.filter((message) => message.conversationId === conversationId);
  }

  public async remove(conversationId: string, messageIds: readonly string[]): Promise<void> {
    const ids = new Set(messageIds);
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message !== undefined && message.conversationId === conversationId && ids.has(message.messageId)) {
        this.messages.splice(index, 1);
      }
    }
  }
}

class RecordingProcessor implements IncomingMessageProcessorPort {
  public readonly messages: IncomingMessage[] = [];

  public async execute(message: IncomingMessage): Promise<void> {
    this.messages.push(message);
  }
}

test("buffers live messages until the configured interval elapses", async () => {
  const clock = new MutableClock();
  const settingsRepository = new InMemorySettingsRepository();
  await settingsRepository.save(createGroupAssistantSettings({
    conversationId: "chat-1",
    analysisMode: "batch",
    analysisIntervalSeconds: 60,
    maxMessagesPerBatch: 10,
  }, clock.now()));
  const bufferRepository = new InMemoryBufferRepository();
  const processor = new RecordingProcessor();
  const service = new LiveMessageBufferService(
    bufferRepository,
    settingsRepository,
    processor,
    new RegexSecretDetector(),
    clock,
    new SilentLogger(),
  );

  await service.execute(message("1", "Task: keep this token sk_live_abcdefghijklmnopqrstuvwxyz"));
  assert.equal(processor.messages.length, 0);
  assert.equal(bufferRepository.messages.length, 1);
  assert.doesNotMatch(bufferRepository.messages[0]?.text ?? "", /sk_live/);

  clock.current = new Date("2026-06-19T12:01:01.000Z");
  const result = await service.execute(message("2", "Decision: ship smaller batches"));

  assert.equal(result.flushedMessageCount, 2);
  assert.equal(bufferRepository.messages.length, 0);
  assert.equal(processor.messages.length, 1);
  assert.equal(processor.messages[0]?.messageId, "batch:1-2");
  assert.match(processor.messages[0]?.text ?? "", /\[REDACTED:api_key\]/);
});

test("processes immediately when conversation settings request immediate mode", async () => {
  const clock = new MutableClock();
  const settingsRepository = new InMemorySettingsRepository();
  await settingsRepository.save(createGroupAssistantSettings({
    conversationId: "chat-1",
    analysisMode: "immediate",
  }, clock.now()));
  const processor = new RecordingProcessor();
  const service = new LiveMessageBufferService(
    new InMemoryBufferRepository(),
    settingsRepository,
    processor,
    new RegexSecretDetector(),
    clock,
    new SilentLogger(),
  );

  const result = await service.execute(message("1", "Task: reply now"));

  assert.equal(result.processedImmediately, true);
  assert.equal(processor.messages.length, 1);
  assert.equal(processor.messages[0]?.messageId, "1");
});

function message(messageId: string, text: string): IncomingMessage {
  return {
    platform: "telegram",
    conversationId: "chat-1",
    messageId,
    senderId: "7",
    text,
    occurredAt: new Date("2026-06-19T12:00:00.000Z"),
  };
}

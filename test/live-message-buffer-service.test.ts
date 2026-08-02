import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "../src/application/dto/incoming-message.js";
import type { ClockPort } from "../src/application/ports/clock.js";
import type { GroupAssistantSettingsRepositoryPort } from "../src/application/ports/group-assistant-settings-repository.js";
import type { ConversationProcessorPort } from "../src/application/ports/incoming-message-processor.js";
import type { ConversationWindow } from "../src/application/dto/conversation-window.js";
import type { IncomingReactionEvent } from "../src/application/dto/incoming-reaction-event.js";
import type { NoteInput } from "../src/application/dto/incoming-note.js";
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
    // Mirrors the SQLite primary key (conversation_id, message_id): appending an
    // existing message updates it instead of duplicating it.
    const existing = this.messages.findIndex((entry) =>
      entry.conversationId === message.conversationId && entry.messageId === message.messageId);
    if (existing === -1) {
      this.messages.push(message);
      return;
    }
    this.messages[existing] = message;
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

  public async conversationIds(): Promise<readonly string[]> {
    return [...new Set(this.messages.map((message) => message.conversationId))];
  }
}

class RecordingProcessor implements ConversationProcessorPort {
  public readonly messages: IncomingMessage[] = [];
  public readonly windows: ConversationWindow[] = [];
  public readonly reactions: IncomingReactionEvent[] = [];
  public readonly notes: NoteInput[] = [];

  public async execute(message: IncomingMessage): Promise<void> {
    this.messages.push(message);
  }

  public async executeWindow(window: ConversationWindow): Promise<void> {
    this.windows.push(window);
  }

  public async executeReaction(event: IncomingReactionEvent): Promise<void> {
    this.reactions.push(event);
  }

  public async executeNote(input: NoteInput): Promise<void> {
    this.notes.push(input);
  }
}

/** Mimics the fail-closed guard: the use case throws and the batch must survive. */
class GuardFailingProcessor extends RecordingProcessor {
  public failing = true;

  public override async executeWindow(window: ConversationWindow): Promise<void> {
    if (this.failing) {
      const error = new Error("Secret guard model call failed");
      error.name = "SecretGuardUnavailableError";
      throw error;
    }
    await super.executeWindow(window);
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
    projectHint: "multi",
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
  assert.equal(processor.windows.length, 1);
  assert.equal(processor.windows[0]?.messages.length, 2);
  assert.equal(processor.windows[0]?.projectHint, "multi");
  assert.deepEqual(processor.windows[0]?.messages.map((m) => m.messageId), ["1", "2"]);
  assert.match(processor.windows[0]?.messages[0]?.text ?? "", /\[REDACTED:api_key\]/);
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

test("carries attachments through the buffer and into the flushed window", async () => {
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

  // A photo-only message: all of its meaning lives in the attachment, so losing
  // the attachment during buffering would silently discard the whole message.
  await service.execute({
    ...message("1", ""),
    attachments: [{
      kind: "image",
      fileUniqueId: "u-1",
      fileId: "file-1",
      mimeType: "image/jpeg",
      variants: [{ fileId: "file-1", fileUniqueId: "u-1", sizeBytes: 42 }],
    }],
  });

  assert.equal(bufferRepository.messages[0]?.attachments?.length, 1);
  assert.equal(bufferRepository.messages[0]?.attachments?.[0]?.fileId, "file-1");

  clock.current = new Date("2026-06-19T12:01:01.000Z");
  await service.execute(message("2", "that is the plan"));

  const flushed = processor.windows[0]?.messages[0];
  assert.equal(flushed?.text, "");
  assert.equal(flushed?.attachments?.length, 1);
  assert.equal(flushed?.attachments?.[0]?.fileUniqueId, "u-1");
  assert.equal(flushed?.attachments?.[0]?.variants?.length, 1);
});

test("a guard outage keeps the batch buffered instead of losing or analysing it", async () => {
  const clock = new MutableClock();
  const settingsRepository = new InMemorySettingsRepository();
  await settingsRepository.save(createGroupAssistantSettings({
    conversationId: "chat-1",
    analysisMode: "batch",
    analysisIntervalSeconds: 60,
    maxMessagesPerBatch: 10,
  }, clock.now()));
  const bufferRepository = new InMemoryBufferRepository();
  const processor = new GuardFailingProcessor();
  const service = new LiveMessageBufferService(
    bufferRepository,
    settingsRepository,
    processor,
    new RegexSecretDetector(),
    clock,
    new SilentLogger(),
  );

  await service.execute(message("1", "first"));
  clock.current = new Date("2026-06-19T12:01:01.000Z");
  const result = await service.execute(message("2", "second"));

  // Nothing analysed, nothing lost, and no throw so the webhook can still ack.
  assert.equal(result.flushedMessageCount, 0);
  assert.equal(result.guardUnavailable, true);
  assert.equal(bufferRepository.messages.length, 2);
  assert.equal(bufferRepository.messages[0]?.guardAttempts, 1);
  assert.equal(bufferRepository.messages[0]?.quarantinedAt, undefined);
});

test("a window is quarantined after repeated guard failures instead of retrying forever", async () => {
  const clock = new MutableClock();
  const settingsRepository = new InMemorySettingsRepository();
  await settingsRepository.save(createGroupAssistantSettings({
    conversationId: "chat-1",
    analysisMode: "batch",
    analysisIntervalSeconds: 1,
    maxMessagesPerBatch: 10,
  }, clock.now()));
  const bufferRepository = new InMemoryBufferRepository();
  const processor = new GuardFailingProcessor();
  const service = new LiveMessageBufferService(
    bufferRepository,
    settingsRepository,
    processor,
    new RegexSecretDetector(),
    clock,
    new SilentLogger(),
    {},
    2,
  );

  await service.execute(message("1", "poison"));
  clock.current = new Date("2026-06-19T12:00:02.000Z");
  await service.flush("chat-1");
  assert.equal(bufferRepository.messages[0]?.guardAttempts, 1);

  await service.flush("chat-1");
  assert.equal(bufferRepository.messages[0]?.guardAttempts, 2);
  assert.notEqual(bufferRepository.messages[0]?.quarantinedAt, undefined);

  // A quarantined message is kept for inspection but never re-analysed, so it can
  // no longer stall the conversation or burn guard calls.
  processor.failing = false;
  assert.equal(await service.flush("chat-1"), 0);
  assert.equal(processor.windows.length, 0);
  assert.equal(bufferRepository.messages.length, 1);
});

test("a later message still flushes after an earlier one is quarantined", async () => {
  const clock = new MutableClock();
  const settingsRepository = new InMemorySettingsRepository();
  await settingsRepository.save(createGroupAssistantSettings({
    conversationId: "chat-1",
    analysisMode: "batch",
    analysisIntervalSeconds: 1,
    maxMessagesPerBatch: 10,
  }, clock.now()));
  const bufferRepository = new InMemoryBufferRepository();
  const processor = new GuardFailingProcessor();
  const service = new LiveMessageBufferService(
    bufferRepository,
    settingsRepository,
    processor,
    new RegexSecretDetector(),
    clock,
    new SilentLogger(),
    {},
    1,
  );

  await service.execute(message("1", "poison"));
  clock.current = new Date("2026-06-19T12:00:02.000Z");
  await service.flush("chat-1");
  assert.notEqual(bufferRepository.messages[0]?.quarantinedAt, undefined);

  processor.failing = false;
  clock.current = new Date("2026-06-19T12:00:04.000Z");
  await service.execute(message("2", "healthy"));
  // The new message is not due on arrival, so let the interval elapse and sweep.
  clock.current = new Date("2026-06-19T12:00:06.000Z");
  await service.flushDue();

  assert.equal(processor.windows.length, 1);
  assert.deepEqual(processor.windows[0]?.messages.map((entry) => entry.messageId), ["2"]);
});

test("the flush sweep processes due batches without a new message arriving", async () => {
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

  await service.execute(message("1", "waiting for the interval"));
  // Not due yet, so a sweep must leave it alone.
  assert.equal(await service.flushDue(), 0);
  assert.equal(processor.windows.length, 0);

  clock.current = new Date("2026-06-19T12:01:01.000Z");
  assert.equal(await service.flushDue(), 1);
  assert.equal(processor.windows.length, 1);
  assert.equal(bufferRepository.messages.length, 0);
});

test("the flush sweep skips conversations set to immediate mode", async () => {
  const clock = new MutableClock();
  const settingsRepository = new InMemorySettingsRepository();
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

  await settingsRepository.save(createGroupAssistantSettings({
    conversationId: "chat-1",
    analysisMode: "batch",
    analysisIntervalSeconds: 60,
  }, clock.now()));
  await service.execute(message("1", "buffered"));

  await settingsRepository.save(createGroupAssistantSettings({
    conversationId: "chat-1",
    analysisMode: "immediate",
  }, clock.now()));
  clock.current = new Date("2026-06-19T12:01:01.000Z");

  assert.equal(await service.flushDue(), 0);
  assert.equal(processor.windows.length, 0);
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

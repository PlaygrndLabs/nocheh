import test from "node:test";
import assert from "node:assert/strict";
import type { ClockPort } from "../src/application/ports/clock.js";
import type { GroupAssistantSettingsRepositoryPort } from "../src/application/ports/group-assistant-settings-repository.js";
import type { IncomingMessageProcessorPort } from "../src/application/ports/incoming-message-processor.js";
import type { LiveMessageBufferRepositoryPort } from "../src/application/ports/live-message-buffer-repository.js";
import type { LoggerPort } from "../src/application/ports/logger.js";
import type { AuditRepositoryPort } from "../src/application/ports/audit-repository.js";
import type { IncomingMessage } from "../src/application/dto/incoming-message.js";
import type { BufferedMessage } from "../src/domain/assistant/buffered-message.js";
import type { GroupAssistantSettings } from "../src/domain/assistant/group-assistant-settings.js";
import type { ProcessingAuditRecord } from "../src/domain/observability/audit.js";
import { createGroupAssistantSettings } from "../src/domain/assistant/group-assistant-settings.js";
import { LiveMessageBufferService } from "../src/application/services/live-message-buffer-service.js";
import { NoopMetricsCollector } from "../src/application/ports/metrics.js";
import { RegexSecretDetector } from "../src/infrastructure/security/regex-secret-detector.js";
import { createMockRoutes } from "../src/interfaces/http/api/create-mock-routes.js";
import { createObservabilityRoutes } from "../src/interfaces/http/api/create-observability-routes.js";
import { createSettingsRoutes } from "../src/interfaces/http/api/create-settings-routes.js";
import { parseTelegramExport } from "../src/interfaces/http/api/create-history-routes.js";
import type { RequestContext } from "../src/interfaces/http/router.js";

class FixedClock implements ClockPort {
  public now(): Date {
    return new Date("2026-06-20T00:00:00.000Z");
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

class InMemorySettingsRepository implements GroupAssistantSettingsRepositoryPort {
  public readonly settings = new Map<string, GroupAssistantSettings>();
  public async save(settings: GroupAssistantSettings): Promise<void> {
    this.settings.set(settings.conversationId, settings);
  }
  public async findByConversationId(id: string): Promise<GroupAssistantSettings | undefined> {
    return this.settings.get(id);
  }
}

class InMemoryBufferRepository implements LiveMessageBufferRepositoryPort {
  public readonly messages: BufferedMessage[] = [];
  public async append(message: BufferedMessage): Promise<void> {
    this.messages.push(message);
  }
  public async findByConversationId(id: string): Promise<readonly BufferedMessage[]> {
    return this.messages.filter((message) => message.conversationId === id);
  }
  public async remove(): Promise<void> {}
}

class InMemoryAuditRepository implements AuditRepositoryPort {
  public constructor(private readonly records: readonly ProcessingAuditRecord[]) {}
  public async save(): Promise<void> {}
  public async findRecent(): Promise<readonly ProcessingAuditRecord[]> {
    return this.records;
  }
}

function context(overrides: Partial<RequestContext>): RequestContext {
  return {
    method: "POST",
    path: "/",
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    raw: undefined as never,
    ...overrides,
  };
}

test("mock inject runs messages through the live processor in immediate mode", async () => {
  const clock = new FixedClock();
  const settingsRepository = new InMemorySettingsRepository();
  await settingsRepository.save(createGroupAssistantSettings({ conversationId: "chat-1", analysisMode: "immediate" }, clock.now()));
  const downstream = new RecordingProcessor();
  const processor = new LiveMessageBufferService(
    new InMemoryBufferRepository(),
    settingsRepository,
    downstream,
    new RegexSecretDetector(),
    clock,
    new SilentLogger(),
  );
  const routes = createMockRoutes(processor, clock);

  const result = await routes.inject(context({ body: { messages: [{ conversationId: "chat-1", text: "Task: ship it" }] } }));

  assert.equal(result.status, 200);
  assert.equal(downstream.messages.length, 1);
  assert.equal(downstream.messages[0]?.platform, "mock");
  assert.equal(downstream.messages[0]?.conversationId, "chat-1");
});

test("mock inject rejects messages missing required fields", async () => {
  const clock = new FixedClock();
  const settingsRepository = new InMemorySettingsRepository();
  const processor = new LiveMessageBufferService(
    new InMemoryBufferRepository(),
    settingsRepository,
    new RecordingProcessor(),
    new RegexSecretDetector(),
    clock,
    new SilentLogger(),
  );
  const routes = createMockRoutes(processor, clock);

  const result = await routes.inject(context({ body: { messages: [{ text: "no conversation" }] } }));

  assert.equal(result.status, 400);
});

test("conversations route hides synthetic simulator records", async () => {
  const routes = createObservabilityRoutes(new InMemoryAuditRepository([
    auditRecord({ platform: "mock", conversationId: "mock-chat-1", preview: "simulated" }),
    auditRecord({ platform: "simulator", conversationId: "sim-chat-1", preview: "local" }),
    auditRecord({ platform: "telegram", conversationId: "telegram:real", preview: "real message" }),
  ]), new NoopMetricsCollector());

  const result = await routes.conversations(context({ method: "GET" }));

  assert.equal(result.status, 200);
  const conversations = (result.body as { conversations: { conversationId: string }[] }).conversations;
  assert.deepEqual(conversations.map((item) => item.conversationId), ["telegram:real"]);
});

test("settings PUT persists via the repository", async () => {
  const repository = new InMemorySettingsRepository();
  const routes = createSettingsRoutes(repository, new FixedClock());

  const result = await routes.put(context({ method: "PUT", params: { conversationId: "chat-9" }, body: { analysisMode: "immediate", maxMessagesPerBatch: 5 } }));

  assert.equal(result.status, 200);
  const stored = await repository.findByConversationId("chat-9");
  assert.equal(stored?.analysisMode, "immediate");
  assert.equal(stored?.maxMessagesPerBatch, 5);
});

function auditRecord(input: { platform: string; conversationId: string; preview: string }): ProcessingAuditRecord {
  const now = new Date("2026-06-20T00:00:00.000Z");
  return {
    id: `${input.platform}:${input.conversationId}`,
    platform: input.platform,
    conversationId: input.conversationId,
    messageId: "message-1",
    senderId: "sender-1",
    receivedAt: now,
    processedAt: now,
    redactedContentPreview: input.preview,
    redactionFindingCount: 0,
    steps: [],
    extractedTasks: [],
    errorLogs: [],
    totalLatencyMs: 1,
  };
}

test("settings GET returns defaults when none stored", async () => {
  const routes = createSettingsRoutes(new InMemorySettingsRepository(), new FixedClock());

  const result = await routes.get(context({ method: "GET", params: { conversationId: "fresh" } }));

  assert.equal(result.status, 200);
  assert.deepEqual((result.body as { isDefault: boolean }).isDefault, true);
});

test("parseTelegramExport maps a Telegram Desktop export", () => {
  const messages = parseTelegramExport({
    id: 555,
    name: "Project Chat",
    messages: [
      { id: 1, type: "message", date_unixtime: "1700000000", from: "Alice", from_id: "user1", text: "Let's ship Friday" },
      { id: 2, type: "service", text: "joined" },
      { id: 3, type: "message", date: "2026-01-01T00:00:00", from: "Bob", text: ["see ", { type: "link", text: "this" }] },
    ],
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.conversationId, "telegram:555");
  assert.equal(messages[0]?.senderDisplayName, "Alice");
  assert.equal(messages[1]?.text, "see this");
});

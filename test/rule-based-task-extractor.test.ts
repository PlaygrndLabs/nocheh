import test from "node:test";
import assert from "node:assert/strict";
import { RuleBasedTaskExtractor } from "../src/infrastructure/reasoning/rule-based-task-extractor.js";
import type { IncomingMessage } from "../src/application/dto/incoming-message.js";

test("extracts explicit task lines from sanitized messages", async () => {
  const extractor = new RuleBasedTaskExtractor();
  const message: IncomingMessage = {
    platform: "telegram",
    conversationId: "chat-1",
    messageId: "message-1",
    senderId: "user-1",
    text: "Task: prepare release notes by 2026-06-20 urgent\nFYI: build passed",
    occurredAt: new Date("2026-06-19T10:00:00.000Z"),
  };

  const tasks = await extractor.extractTasks(message);

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.title, "prepare release notes");
  assert.equal(tasks[0]?.priority, "urgent");
  assert.equal(tasks[0]?.dueAt?.toISOString(), "2026-06-20T23:59:59.000Z");
});

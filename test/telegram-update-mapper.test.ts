import test from "node:test";
import assert from "node:assert/strict";
import { TelegramUpdateMapper } from "../src/infrastructure/messaging/telegram/telegram-update-mapper.js";

test("maps Telegram text messages into platform-neutral messages", () => {
  const mapper = new TelegramUpdateMapper();

  const message = mapper.toIncomingMessage({
    update_id: 1,
    message: {
      message_id: 99,
      date: 1781870400,
      chat: { id: -100123 },
      from: { id: 7, first_name: "Sam", username: "sam" },
      text: "Task: ship it",
    },
  });

  assert.equal(message?.platform, "telegram");
  assert.equal(message?.conversationId, "-100123");
  assert.equal(message?.messageId, "99");
  assert.equal(message?.senderId, "7");
  assert.equal(message?.text, "Task: ship it");
});

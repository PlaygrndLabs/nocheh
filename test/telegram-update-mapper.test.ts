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
      from: { id: 7, first_name: "Mak", username: "mak" },
      text: "Task: ship it",
    },
  });

  assert.equal(message?.platform, "telegram");
  assert.equal(message?.conversationId, "-100123");
  assert.equal(message?.messageId, "99");
  assert.equal(message?.senderId, "7");
  assert.equal(message?.text, "Task: ship it");
});

test("captures the reply-to message id when present", () => {
  const mapper = new TelegramUpdateMapper();

  const message = mapper.toIncomingMessage({
    update_id: 2,
    message: {
      message_id: 100,
      date: 1781870400,
      chat: { id: -100123 },
      from: { id: 7, first_name: "Mak" },
      text: "agreed",
      reply_to_message: { message_id: 99 },
    },
  });

  assert.equal(message?.replyToMessageId, "99");
});

test("maps a Telegram message_reaction update into a reaction event", () => {
  const mapper = new TelegramUpdateMapper();

  const reaction = mapper.toIncomingReaction({
    update_id: 3,
    message_reaction: {
      chat: { id: -100123 },
      message_id: 99,
      user: { id: 7, first_name: "Mak" },
      date: 1781870500,
      new_reaction: [{ type: "emoji", emoji: "\u2705" }],
    },
  });

  assert.equal(reaction?.platform, "telegram");
  assert.equal(reaction?.conversationId, "-100123");
  assert.equal(reaction?.targetMessageId, "99");
  assert.equal(reaction?.reactorId, "7");
  assert.equal(reaction?.reactions[0]?.emoji, "\u2705");
});

test("ignores message updates when asked for a reaction and vice versa", () => {
  const mapper = new TelegramUpdateMapper();
  const update = {
    update_id: 4,
    message: { message_id: 1, date: 1781870400, chat: { id: 1 }, from: { id: 7, first_name: "Mak" }, text: "hi" },
  };
  assert.equal(mapper.toIncomingReaction(update), undefined);
  assert.equal(mapper.toIncomingMessage({ update_id: 5, message_reaction: { chat: { id: 1 }, message_id: 1, user: { id: 7 }, date: 1, new_reaction: [] } }), undefined);
});

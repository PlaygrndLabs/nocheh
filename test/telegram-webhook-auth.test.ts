import test from "node:test";
import assert from "node:assert/strict";
import { isTelegramMessageAllowed } from "../src/interfaces/telegram-webhook/create-telegram-webhook-handler.js";

test("telegram allow-list permits only configured chats and users", () => {
  assert.equal(isTelegramMessageAllowed("chat-1", "user-1", {}), true);
  assert.equal(isTelegramMessageAllowed("chat-1", "user-1", {
    allowedChatIds: new Set(["chat-1"]),
  }), true);
  assert.equal(isTelegramMessageAllowed("chat-2", "user-1", {
    allowedChatIds: new Set(["chat-1"]),
  }), false);
  assert.equal(isTelegramMessageAllowed("chat-1", "user-2", {
    allowedChatIds: new Set(["chat-1"]),
    allowedUserIds: new Set(["user-1"]),
  }), false);
});

test("telegram allow-list can be resolved dynamically", () => {
  let allowedChats = new Set(["chat-1"]);
  const auth = {
    allowedChatIds: () => allowedChats,
  };

  assert.equal(isTelegramMessageAllowed("chat-1", "user-1", auth), true);
  assert.equal(isTelegramMessageAllowed("chat-2", "user-1", auth), false);

  allowedChats = new Set(["chat-2"]);
  assert.equal(isTelegramMessageAllowed("chat-1", "user-1", auth), false);
  assert.equal(isTelegramMessageAllowed("chat-2", "user-1", auth), true);
});

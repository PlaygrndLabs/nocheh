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

test("reads a media caption as the message text", () => {
  const mapper = new TelegramUpdateMapper();

  const message = mapper.toIncomingMessage({
    update_id: 6,
    message: {
      message_id: 101,
      date: 1781870400,
      chat: { id: -100123 },
      from: { id: 7, first_name: "Mak" },
      caption: "whiteboard from the partner call",
      photo: [
        { file_id: "small", file_unique_id: "u-small", width: 90, height: 60, file_size: 1_200 },
        { file_id: "large", file_unique_id: "u-large", width: 1280, height: 860, file_size: 240_000 },
      ],
    },
  });

  assert.equal(message?.text, "whiteboard from the partner call");
  assert.equal(message?.attachments?.length, 1);
  assert.equal(message?.attachments?.[0]?.kind, "image");
});

test("keeps a photo-only message and collapses sizes into variants", () => {
  const mapper = new TelegramUpdateMapper();

  const message = mapper.toIncomingMessage({
    update_id: 7,
    message: {
      message_id: 102,
      date: 1781870400,
      chat: { id: -100123 },
      from: { id: 7, first_name: "Mak" },
      photo: [
        { file_id: "mid", file_unique_id: "u-mid", width: 320, height: 240, file_size: 30_000 },
        { file_id: "small", file_unique_id: "u-small", width: 90, height: 60, file_size: 1_200 },
        { file_id: "large", file_unique_id: "u-large", width: 1280, height: 860, file_size: 240_000 },
      ],
    },
  });

  assert.equal(message?.text, "");
  const attachment = message?.attachments?.[0];
  assert.equal(attachment?.kind, "image");
  // The preferred rendition is the largest; variants stay ordered smallest to largest.
  assert.equal(attachment?.fileId, "large");
  assert.deepEqual(attachment?.variants?.map((variant) => variant.fileId), ["small", "mid", "large"]);
});

test("maps a voice note as an audio attachment with its duration", () => {
  const mapper = new TelegramUpdateMapper();

  const message = mapper.toIncomingMessage({
    update_id: 8,
    message: {
      message_id: 103,
      date: 1781870400,
      chat: { id: -100123 },
      from: { id: 7, first_name: "Mak" },
      voice: { file_id: "voice-1", file_unique_id: "u-voice-1", duration: 12, file_size: 8_000 },
    },
  });

  const attachment = message?.attachments?.[0];
  assert.equal(attachment?.kind, "audio");
  assert.equal(attachment?.durationSeconds, 12);
  // Telegram voice notes are OGG/Opus when the client does not say otherwise.
  assert.equal(attachment?.mimeType, "audio/ogg");
});

test("treats an image sent as a document as an image attachment", () => {
  const mapper = new TelegramUpdateMapper();

  const message = mapper.toIncomingMessage({
    update_id: 9,
    message: {
      message_id: 104,
      date: 1781870400,
      chat: { id: -100123 },
      from: { id: 7, first_name: "Mak" },
      document: {
        file_id: "doc-1",
        file_unique_id: "u-doc-1",
        mime_type: "image/png",
        file_name: "diagram.png",
      },
    },
  });

  assert.equal(message?.attachments?.[0]?.kind, "image");
  assert.equal(message?.attachments?.[0]?.fileName, "diagram.png");
});

test("still ignores updates with no text, caption, or attachment", () => {
  const mapper = new TelegramUpdateMapper();

  const update = {
    update_id: 10,
    message: {
      message_id: 105,
      date: 1781870400,
      chat: { id: -100123 },
      from: { id: 7, first_name: "Mak" },
    },
  };

  assert.equal(mapper.toIncomingMessage(update), undefined);
  assert.match(mapper.describeUnsupportedUpdate(update), /no text, caption, or supported attachment/);
});

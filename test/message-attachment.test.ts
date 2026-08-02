import test from "node:test";
import assert from "node:assert/strict";
import {
  describeAttachment,
  isUnderstandableAttachment,
  selectAttachmentVariant,
  type MessageAttachment,
} from "../src/domain/messaging/message-attachment.js";

function imageAttachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    kind: "image",
    fileUniqueId: "u-large",
    fileId: "large",
    sizeBytes: 240_000,
    ...overrides,
  };
}

test("only image and audio attachments are understandable today", () => {
  assert.equal(isUnderstandableAttachment(imageAttachment()), true);
  assert.equal(isUnderstandableAttachment(imageAttachment({ kind: "audio" })), true);
  assert.equal(isUnderstandableAttachment(imageAttachment({ kind: "video" })), false);
  assert.equal(isUnderstandableAttachment(imageAttachment({ kind: "document" })), false);
  assert.equal(isUnderstandableAttachment(imageAttachment({ kind: "sticker" })), false);
});

test("selects the largest variant that fits the payload budget", () => {
  const attachment = imageAttachment({
    variants: [
      { fileId: "small", fileUniqueId: "u-small", sizeBytes: 1_200 },
      { fileId: "mid", fileUniqueId: "u-mid", sizeBytes: 90_000 },
      { fileId: "large", fileUniqueId: "u-large", sizeBytes: 240_000 },
    ],
  });

  assert.equal(selectAttachmentVariant(attachment, 180_000).fileId, "mid");
  assert.equal(selectAttachmentVariant(attachment, 500_000).fileId, "large");
});

test("falls back to the smallest variant when every variant exceeds the budget", () => {
  const attachment = imageAttachment({
    variants: [
      { fileId: "mid", fileUniqueId: "u-mid", sizeBytes: 90_000 },
      { fileId: "large", fileUniqueId: "u-large", sizeBytes: 240_000 },
    ],
  });

  // Better to try the smallest and let the download cap reject it than to skip the image.
  assert.equal(selectAttachmentVariant(attachment, 1_000).fileId, "mid");
});

test("falls back to the attachment itself when no variants exist", () => {
  assert.equal(selectAttachmentVariant(imageAttachment(), 180_000).fileId, "large");
});

test("describes an attachment without understanding as undescribed", () => {
  assert.match(describeAttachment(imageAttachment()), /no description available/);
});

test("includes description and transcript once understanding exists", () => {
  const described = describeAttachment(imageAttachment({
    kind: "audio",
    durationSeconds: 12,
    understanding: {
      description: "A voice note about the Tuesday deadline.",
      transcript: "we need to move Tuesday to Thursday",
      confidence: 0.8,
      provider: "nvidia",
      model: "omni",
    },
  }));

  assert.match(described, /audio, 12s/);
  assert.match(described, /Tuesday deadline/);
  assert.match(described, /transcript: we need to move Tuesday to Thursday/);
});

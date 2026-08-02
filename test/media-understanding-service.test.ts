import test from "node:test";
import assert from "node:assert/strict";
import type { ConversationWindow } from "../src/application/dto/conversation-window.js";
import type { IncomingMessage } from "../src/application/dto/incoming-message.js";
import type { AttachmentFetcherPort } from "../src/application/ports/attachment-fetcher.js";
import { AttachmentFetchError } from "../src/application/ports/attachment-fetcher.js";
import type { ClockPort } from "../src/application/ports/clock.js";
import type { LoggerPort } from "../src/application/ports/logger.js";
import type { MediaUnderstandingCachePort } from "../src/application/ports/media-understanding-cache.js";
import type {
  FetchedAttachment,
  MediaUnderstandingInput,
  MediaUnderstandingPort,
  MediaUnderstandingResult,
} from "../src/application/ports/media-understanding.js";
import { MediaUnderstandingRouter } from "../src/application/services/media-understanding-router.js";
import { MediaUnderstandingService } from "../src/application/services/media-understanding-service.js";
import type {
  MessageAttachment,
  MessageAttachmentUnderstanding,
} from "../src/domain/messaging/message-attachment.js";

class FixedClock implements ClockPort {
  public now(): Date {
    return new Date("2026-06-19T12:00:00.000Z");
  }
}

class SilentLogger implements LoggerPort {
  public readonly warnings: string[] = [];
  public info(): void {}
  public warn(message: string): void {
    this.warnings.push(message);
  }
  public error(): void {}
}

class StubFetcher implements AttachmentFetcherPort {
  public readonly fetched: { readonly fileId: string; readonly maxBytes: number }[] = [];

  public constructor(private readonly failOn: ReadonlySet<string> = new Set()) {}

  public supports(platform: string): boolean {
    return platform === "telegram";
  }

  public async fetch(attachment: MessageAttachment, maxBytes: number): Promise<FetchedAttachment> {
    this.fetched.push({ fileId: attachment.fileId, maxBytes });
    if (this.failOn.has(attachment.fileId)) {
      throw new AttachmentFetchError(`cannot download ${attachment.fileId}`);
    }
    return {
      kind: attachment.kind,
      mimeType: attachment.mimeType ?? "image/jpeg",
      bytes: new Uint8Array([1, 2, 3]),
      fileId: attachment.fileId,
    };
  }
}

class StubUnderstanding implements MediaUnderstandingPort {
  public readonly seen: MediaUnderstandingInput[] = [];

  public constructor(
    private readonly kinds: readonly MessageAttachment["kind"][] = ["image", "audio"],
    private readonly failing = false,
  ) {}

  public supports(kind: MessageAttachment["kind"]): boolean {
    return this.kinds.includes(kind);
  }

  public async understand(input: MediaUnderstandingInput): Promise<MediaUnderstandingResult> {
    this.seen.push(input);
    if (this.failing) {
      throw new Error("model unavailable");
    }
    return {
      understanding: {
        description: `described ${input.attachment.kind}`,
        confidence: 0.9,
        provider: "stub",
        model: "stub-omni",
      },
      tokenUsage: { provider: "stub", model: "stub-omni", inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    };
  }
}

class InMemoryCache implements MediaUnderstandingCachePort {
  public readonly entries = new Map<string, MessageAttachmentUnderstanding>();

  public async find(fileUniqueId: string): Promise<MessageAttachmentUnderstanding | undefined> {
    return this.entries.get(fileUniqueId);
  }

  public async save(fileUniqueId: string, understanding: MessageAttachmentUnderstanding): Promise<void> {
    this.entries.set(fileUniqueId, understanding);
  }
}

function windowWith(attachments: readonly MessageAttachment[], text = ""): ConversationWindow {
  const message: IncomingMessage = {
    platform: "telegram",
    conversationId: "chat-1",
    messageId: "1",
    senderId: "7",
    text,
    occurredAt: new Date("2026-06-19T12:00:00.000Z"),
    attachments,
  };
  return { platform: "telegram", conversationId: "chat-1", messages: [message] };
}

function image(fileId = "file-1", overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    kind: "image",
    fileUniqueId: `u-${fileId}`,
    fileId,
    mimeType: "image/jpeg",
    ...overrides,
  };
}

test("attaches a description to an understandable attachment", async () => {
  const understanding = new StubUnderstanding();
  const service = new MediaUnderstandingService(understanding, [new StubFetcher()], new SilentLogger(), new FixedClock());

  const outcome = await service.execute(windowWith([image()], "look at this"));

  assert.equal(outcome.understood, 1);
  assert.equal(outcome.failed, 0);
  const described = outcome.window.messages[0]?.attachments?.[0]?.understanding;
  assert.equal(described?.description, "described image");
  // Message text is passed as a hint so the model can resolve an ambiguous image.
  assert.equal(understanding.seen[0]?.hint, "look at this");
  assert.equal(outcome.tokenUsage?.totalTokens, 14);
});

test("a failed attachment leaves the window usable instead of throwing", async () => {
  const service = new MediaUnderstandingService(
    new StubUnderstanding(),
    [new StubFetcher(new Set(["file-1"]))],
    new SilentLogger(),
    new FixedClock(),
  );

  const outcome = await service.execute(windowWith([image()], "still analyse my text"));

  assert.equal(outcome.failed, 1);
  assert.equal(outcome.understood, 0);
  assert.equal(outcome.errors.length, 1);
  // The message survives with its text intact and no description.
  assert.equal(outcome.window.messages[0]?.text, "still analyse my text");
  assert.equal(outcome.window.messages[0]?.attachments?.[0]?.understanding, undefined);
});

test("kinds the configured model cannot read are skipped, not attempted", async () => {
  const fetcher = new StubFetcher();
  const service = new MediaUnderstandingService(
    new StubUnderstanding(["image"]),
    [fetcher],
    new SilentLogger(),
    new FixedClock(),
  );

  const outcome = await service.execute(windowWith([
    image(),
    { kind: "audio", fileUniqueId: "u-voice", fileId: "voice-1", mimeType: "audio/ogg", durationSeconds: 5 },
  ]));

  assert.equal(outcome.understood, 1);
  assert.equal(outcome.skipped, 1);
  // No download is paid for a kind that cannot be understood.
  assert.deepEqual(fetcher.fetched.map((entry) => entry.fileId), ["file-1"]);
});

test("documents and stickers are never sent to a perception model", async () => {
  const fetcher = new StubFetcher();
  const service = new MediaUnderstandingService(
    new StubUnderstanding(),
    [fetcher],
    new SilentLogger(),
    new FixedClock(),
  );

  const outcome = await service.execute(windowWith([
    { kind: "document", fileUniqueId: "u-doc", fileId: "doc-1", mimeType: "application/pdf" },
    { kind: "sticker", fileUniqueId: "u-sticker", fileId: "sticker-1" },
    { kind: "video", fileUniqueId: "u-video", fileId: "video-1" },
  ]));

  assert.equal(outcome.attempted, 0);
  assert.equal(outcome.skipped, 3);
  assert.equal(fetcher.fetched.length, 0);
});

test("a cached description avoids a second perception call", async () => {
  const cache = new InMemoryCache();
  const understanding = new StubUnderstanding();
  const fetcher = new StubFetcher();
  const service = new MediaUnderstandingService(
    understanding,
    [fetcher],
    new SilentLogger(),
    new FixedClock(),
    {},
    cache,
  );

  await service.execute(windowWith([image()]));
  const second = await service.execute(windowWith([image()]));

  assert.equal(second.fromCache, 1);
  assert.equal(second.attempted, 0);
  // Only the first window paid for a download and a model call.
  assert.equal(fetcher.fetched.length, 1);
  assert.equal(understanding.seen.length, 1);
  assert.equal(second.window.messages[0]?.attachments?.[0]?.understanding?.description, "described image");
});

test("a failed understanding is never cached, so it is retried later", async () => {
  const cache = new InMemoryCache();
  const failing = new StubUnderstanding(["image"], true);
  const service = new MediaUnderstandingService(
    failing,
    [new StubFetcher()],
    new SilentLogger(),
    new FixedClock(),
    {},
    cache,
  );

  const outcome = await service.execute(windowWith([image()]));

  assert.equal(outcome.failed, 1);
  // Caching a failure would permanently describe the image as unavailable.
  assert.equal(cache.entries.size, 0);
});

test("the per-window attachment cap bounds perception cost", async () => {
  const understanding = new StubUnderstanding();
  const service = new MediaUnderstandingService(
    understanding,
    [new StubFetcher()],
    new SilentLogger(),
    new FixedClock(),
    { maxAttachmentsPerWindow: 2 },
  );

  const outcome = await service.execute(windowWith([image("a"), image("b"), image("c"), image("d")]));

  assert.equal(outcome.attempted, 2);
  assert.equal(outcome.skipped, 2);
  assert.equal(understanding.seen.length, 2);
});

test("the largest rendition under the inline cap is downloaded", async () => {
  const fetcher = new StubFetcher();
  const service = new MediaUnderstandingService(
    new StubUnderstanding(),
    [fetcher],
    new SilentLogger(),
    new FixedClock(),
    { maxInlineBytes: 100_000 },
  );

  await service.execute(windowWith([image("large", {
    variants: [
      { fileId: "small", fileUniqueId: "u-small", sizeBytes: 1_000 },
      { fileId: "mid", fileUniqueId: "u-mid", sizeBytes: 90_000 },
      { fileId: "large", fileUniqueId: "u-large", sizeBytes: 400_000 },
    ],
  })]));

  // The 400KB original would be rejected by the provider's inline payload limit.
  assert.equal(fetcher.fetched[0]?.fileId, "mid");
});

test("an unsupported platform leaves attachments undescribed without throwing", async () => {
  const logger = new SilentLogger();
  const service = new MediaUnderstandingService(
    new StubUnderstanding(),
    [new StubFetcher()],
    logger,
    new FixedClock(),
  );

  const outcome = await service.execute({
    platform: "mock",
    conversationId: "chat-1",
    messages: [{
      platform: "mock",
      conversationId: "chat-1",
      messageId: "1",
      senderId: "7",
      text: "",
      occurredAt: new Date("2026-06-19T12:00:00.000Z"),
      attachments: [image()],
    }],
  });

  assert.equal(outcome.failed, 1);
  assert.match(logger.warnings.join(" "), /No attachment fetcher for platform/);
});

test("the router sends each kind to the model configured for it", async () => {
  const imageModel = new StubUnderstanding(["image"]);
  const audioModel = new StubUnderstanding(["audio"]);
  const router = new MediaUnderstandingRouter({ image: imageModel, audio: audioModel });

  assert.equal(router.supports("image"), true);
  assert.equal(router.supports("audio"), true);
  assert.equal(router.supports("video"), false);

  await router.understand({
    attachment: { kind: "audio", mimeType: "audio/ogg", bytes: new Uint8Array([1]), fileId: "voice-1" },
  });

  assert.equal(audioModel.seen.length, 1);
  assert.equal(imageModel.seen.length, 0);
});

test("the router reports no support for a kind with no configured model", async () => {
  const router = new MediaUnderstandingRouter({ image: new StubUnderstanding(["image"]) });

  assert.equal(router.supports("audio"), false);
  await assert.rejects(
    router.understand({
      attachment: { kind: "audio", mimeType: "audio/ogg", bytes: new Uint8Array([1]), fileId: "voice-1" },
    }),
    /No model is configured for audio/,
  );
});

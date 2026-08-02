import test from "node:test";
import assert from "node:assert/strict";
import { AttachmentFetchError } from "../src/application/ports/attachment-fetcher.js";
import type {
  TelegramBotInfo,
  TelegramClientPort,
  TelegramFileInfo,
  TelegramWebhookInfo,
} from "../src/application/ports/telegram-client.js";
import type { MessageAttachment } from "../src/domain/messaging/message-attachment.js";
import { TelegramAttachmentFetcher } from "../src/infrastructure/messaging/telegram/telegram-attachment-fetcher.js";

class StubClient implements TelegramClientPort {
  public readonly downloads: { readonly path: string; readonly maxBytes: number }[] = [];

  public constructor(
    private readonly file: Partial<TelegramFileInfo> & { readonly path: string },
    private readonly bytes = new Uint8Array([1, 2, 3]),
  ) {}

  public async getMe(): Promise<TelegramBotInfo> {
    return { id: 1, firstName: "Nocheh" };
  }
  public async setWebhook(): Promise<void> {}
  public async getWebhookInfo(): Promise<TelegramWebhookInfo> {
    return { url: "" };
  }
  public async getFile(_token: string, fileId: string): Promise<TelegramFileInfo> {
    return { fileId, path: this.file.path, ...(this.file.sizeBytes === undefined ? {} : { sizeBytes: this.file.sizeBytes }) };
  }
  public async downloadFile(_token: string, path: string, maxBytes: number): Promise<Uint8Array> {
    this.downloads.push({ path, maxBytes });
    return this.bytes;
  }
}

function attachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return { kind: "image", fileUniqueId: "u-1", fileId: "file-1", ...overrides };
}

test("only handles telegram messages", () => {
  const fetcher = new TelegramAttachmentFetcher(new StubClient({ path: "photos/a.jpg" }), () => "token");
  assert.equal(fetcher.supports("telegram"), true);
  assert.equal(fetcher.supports("mock"), false);
});

test("resolves the file then downloads its bytes", async () => {
  const client = new StubClient({ path: "photos/a.jpg" });
  const fetcher = new TelegramAttachmentFetcher(client, () => "token");

  const fetched = await fetcher.fetch(attachment({ mimeType: "image/png" }), 1024);

  assert.equal(fetched.kind, "image");
  assert.equal(fetched.mimeType, "image/png");
  assert.deepEqual([...fetched.bytes], [1, 2, 3]);
  assert.deepEqual(client.downloads, [{ path: "photos/a.jpg", maxBytes: 1024 }]);
});

test("infers the mime type from the telegram file path when the message omits one", async () => {
  const fetcher = new TelegramAttachmentFetcher(new StubClient({ path: "voice/file_1.oga" }), () => "token");

  const fetched = await fetcher.fetch(
    { kind: "audio", fileUniqueId: "u-voice", fileId: "voice-1" },
    1024,
  );

  assert.equal(fetched.mimeType, "audio/ogg");
});

test("refuses an oversized file before downloading it", async () => {
  const client = new StubClient({ path: "video/big.mp4", sizeBytes: 5_000_000 });
  const fetcher = new TelegramAttachmentFetcher(client, () => "token");

  await assert.rejects(fetcher.fetch(attachment(), 1024), AttachmentFetchError);
  assert.equal(client.downloads.length, 0);
});

test("reports a missing bot token as a fetch error rather than throwing raw", async () => {
  const fetcher = new TelegramAttachmentFetcher(new StubClient({ path: "photos/a.jpg" }), () => undefined);

  await assert.rejects(fetcher.fetch(attachment(), 1024), /bot token is not configured/);
});

test("wraps a transport failure so the caller can degrade", async () => {
  class FailingClient extends StubClient {
    public override async getFile(): Promise<TelegramFileInfo> {
      throw new Error("telegram is down");
    }
  }
  const fetcher = new TelegramAttachmentFetcher(new FailingClient({ path: "photos/a.jpg" }), () => "token");

  await assert.rejects(fetcher.fetch(attachment(), 1024), /Failed to download Telegram attachment u-1: telegram is down/);
});

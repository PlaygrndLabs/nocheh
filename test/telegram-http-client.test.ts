import test from "node:test";
import assert from "node:assert/strict";
import { TelegramHttpClient } from "../src/infrastructure/messaging/telegram/telegram-http-client.js";

interface Call {
  readonly url: string;
  readonly body: unknown;
}

function mockFetch(payload: unknown, calls: Call[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: String(input), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("getMe builds the correct URL and parses the bot identity", async () => {
  const calls: Call[] = [];
  const client = new TelegramHttpClient(
    mockFetch({ ok: true, result: { id: 42, username: "nocheh_bot", first_name: "Nocheh" } }, calls),
  );

  const bot = await client.getMe("token-123");

  assert.equal(calls[0]?.url, "https://api.telegram.org/bottoken-123/getMe");
  assert.deepEqual(bot, { id: 42, username: "nocheh_bot", firstName: "Nocheh" });
});

test("getMe omits username when Telegram does not return one", async () => {
  const client = new TelegramHttpClient(mockFetch({ ok: true, result: { id: 1, first_name: "Bot" } }, []));

  const bot = await client.getMe("t");

  assert.equal("username" in bot, false);
});

test("throws with the Telegram description when ok is false", async () => {
  const client = new TelegramHttpClient(mockFetch({ ok: false, description: "Unauthorized" }, []));

  await assert.rejects(() => client.getMe("bad"), /Unauthorized/);
});

test("setWebhook posts the url payload", async () => {
  const calls: Call[] = [];
  const client = new TelegramHttpClient(mockFetch({ ok: true, result: true }, calls));

  await client.setWebhook("token-123", "https://example.com/telegram/webhook");

  assert.equal(calls[0]?.url, "https://api.telegram.org/bottoken-123/setWebhook");
  assert.deepEqual(calls[0]?.body, {
    url: "https://example.com/telegram/webhook",
    allowed_updates: ["message", "edited_message", "message_reaction"],
  });
});

test("getFile resolves a download path and rejects a file with no path", async () => {
  const calls: string[] = [];
  const client = new TelegramHttpClient(
    (async (url: string) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { file_id: "file-1", file_path: "photos/a.jpg", file_size: 42 } }),
      };
    }) as unknown as typeof fetch,
    "https://telegram.test",
  );

  const info = await client.getFile("token-1", "file-1");
  assert.equal(info.path, "photos/a.jpg");
  assert.equal(info.sizeBytes, 42);
  assert.equal(calls[0], "https://telegram.test/bottoken-1/getFile");

  const pathless = new TelegramHttpClient(
    (async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { file_id: "file-2" } }) })) as unknown as typeof fetch,
    "https://telegram.test",
  );
  await assert.rejects(pathless.getFile("token-1", "file-2"), /no file_path/);
});

test("downloadFile uses the file host and returns raw bytes", async () => {
  const calls: string[] = [];
  const client = new TelegramHttpClient(
    (async (url: string) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "3" }),
        arrayBuffer: async () => new Uint8Array([7, 8, 9]).buffer,
      };
    }) as unknown as typeof fetch,
    "https://telegram.test",
  );

  const bytes = await client.downloadFile("token-1", "photos/a.jpg", 1024);

  // Files live under /file/bot<token>/, a different path than the API methods.
  assert.equal(calls[0], "https://telegram.test/file/bottoken-1/photos/a.jpg");
  assert.deepEqual([...bytes], [7, 8, 9]);
});

test("downloadFile rejects an oversized file before buffering it", async () => {
  let arrayBufferCalled = false;
  const client = new TelegramHttpClient(
    (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "5000000" }),
      arrayBuffer: async () => {
        arrayBufferCalled = true;
        return new Uint8Array(0).buffer;
      },
    })) as unknown as typeof fetch,
    "https://telegram.test",
  );

  await assert.rejects(client.downloadFile("token-1", "video/big.mp4", 1024), /above the 1024 byte limit/);
  // The advertised length is trusted so nothing is read into memory.
  assert.equal(arrayBufferCalled, false);
});

test("downloadFile still enforces the cap when no content-length is advertised", async () => {
  const client = new TelegramHttpClient(
    (async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => new Uint8Array(2048).buffer,
    })) as unknown as typeof fetch,
    "https://telegram.test",
  );

  await assert.rejects(client.downloadFile("token-1", "photos/a.jpg", 1024), /above the 1024 byte limit/);
});

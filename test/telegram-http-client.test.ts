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
  assert.deepEqual(calls[0]?.body, { url: "https://example.com/telegram/webhook" });
});

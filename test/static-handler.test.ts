import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage as HttpIncomingMessage, ServerResponse } from "node:http";
import { createStaticHandler } from "../src/interfaces/http/create-static-handler.js";

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function fakeRequest(url: string): HttpIncomingMessage {
  const request = Readable.from([]) as unknown as HttpIncomingMessage;
  request.method = "GET";
  request.url = url;
  return request;
}

function fakeResponse(): { response: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: "" };
  const response = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      Object.assign(captured.headers, headers ?? {});
      return this;
    },
    end(chunk?: string | Buffer) {
      captured.body = chunk === undefined ? "" : chunk.toString();
      return this;
    },
  } as unknown as ServerResponse;
  return { response, captured };
}

async function fixtureRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nocheh-web-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>app</title>", "utf8");
  await writeFile(join(dir, "app.js"), "console.log('hi')", "utf8");
  return dir;
}

test("returns false for paths outside /app", async () => {
  const handler = createStaticHandler(await fixtureRoot());
  const { response } = fakeResponse();

  assert.equal(await handler(fakeRequest("/api/metrics"), response), false);
});

test("serves a built asset with the correct content type", async () => {
  const handler = createStaticHandler(await fixtureRoot());
  const { response, captured } = fakeResponse();

  await handler(fakeRequest("/app/app.js"), response);

  assert.equal(captured.status, 200);
  assert.match(captured.headers["content-type"] ?? "", /javascript/);
  assert.match(captured.body, /console\.log/);
});

test("falls back to index.html for extensionless SPA routes", async () => {
  const handler = createStaticHandler(await fixtureRoot());
  const { response, captured } = fakeResponse();

  await handler(fakeRequest("/app/setup"), response);

  assert.equal(captured.status, 200);
  assert.match(captured.body, /<!doctype html>/);
});

test("does not serve files outside the root via traversal", async () => {
  const handler = createStaticHandler(await fixtureRoot());
  const { response, captured } = fakeResponse();

  // URL normalization collapses `..`, so this escapes `/app` and is left unmatched;
  // any encoded form that slips through is rejected with 403 by the root guard.
  const matched = await handler(fakeRequest("/app/..%2f..%2fetc%2fpasswd"), response);

  assert.equal(matched ? captured.status !== 200 : true, true);
});

test("returns 404 for a missing asset with an extension", async () => {
  const handler = createStaticHandler(await fixtureRoot());
  const { response, captured } = fakeResponse();

  await handler(fakeRequest("/app/missing.css"), response);

  assert.equal(captured.status, 404);
});

import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage as HttpIncomingMessage, ServerResponse } from "node:http";
import { Router } from "../src/interfaces/http/router.js";

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function fakeRequest(method: string, url: string, body?: unknown): HttpIncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  const request = stream as unknown as HttpIncomingMessage;
  request.method = method;
  request.url = url;
  return request;
}

function fakeResponse(): { response: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: "" };
  const response = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      Object.assign(captured.headers, headers ?? {});
      return this;
    },
    end(chunk?: string) {
      captured.body = chunk ?? "";
      return this;
    },
  } as unknown as ServerResponse;
  return { response, captured };
}

test("extracts path params and parses the query string", async () => {
  const router = new Router();
  router.get("/api/settings/:conversationId", ({ params, query }) => ({
    status: 200,
    body: { conversationId: params.conversationId, mode: query.get("mode") },
  }));

  const { response, captured } = fakeResponse();
  const matched = await router.handle(fakeRequest("GET", "/api/settings/chat-1?mode=batch"), response);

  assert.equal(matched, true);
  assert.equal(captured.status, 200);
  assert.deepEqual(JSON.parse(captured.body), { conversationId: "chat-1", mode: "batch" });
});

test("parses a JSON request body", async () => {
  const router = new Router();
  router.post("/api/echo", ({ body }) => ({ status: 200, body }));

  const { response, captured } = fakeResponse();
  await router.handle(fakeRequest("POST", "/api/echo", { hello: "world" }), response);

  assert.deepEqual(JSON.parse(captured.body), { hello: "world" });
});

test("returns false when no route matches", async () => {
  const router = new Router();
  router.get("/api/known", () => ({ status: 200, body: {} }));

  const { response } = fakeResponse();
  const matched = await router.handle(fakeRequest("GET", "/api/unknown"), response);

  assert.equal(matched, false);
});

test("responds 500 when a handler throws", async () => {
  const router = new Router();
  router.get("/api/boom", () => {
    throw new Error("kaboom");
  });

  const { response, captured } = fakeResponse();
  await router.handle(fakeRequest("GET", "/api/boom"), response);

  assert.equal(captured.status, 500);
  assert.deepEqual(JSON.parse(captured.body), { ok: false, error: "kaboom" });
});

test("does not match a route with a different method", async () => {
  const router = new Router();
  router.post("/api/thing", () => ({ status: 200, body: {} }));

  const { response } = fakeResponse();
  const matched = await router.handle(fakeRequest("GET", "/api/thing"), response);

  assert.equal(matched, false);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
  fetchWithTimeout,
} from "../src/infrastructure/http/fetch-with-timeout.js";

test("passes an abort signal so a hung provider cannot block indefinitely", async () => {
  let seenSignal: AbortSignal | undefined;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    seenSignal = init?.signal ?? undefined;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  await fetchWithTimeout(fetchImpl, "https://example.test", { method: "POST" }, {
    timeoutMs: 5_000,
    label: "test call",
  });

  assert.ok(seenSignal instanceof AbortSignal);
});

test("keeps the caller's init fields", async () => {
  let seenInit: RequestInit | undefined;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    seenInit = init;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  await fetchWithTimeout(fetchImpl, "https://example.test", {
    method: "POST",
    body: "payload",
    headers: { "content-type": "application/json" },
  }, { timeoutMs: 5_000, label: "test call" });

  assert.equal(seenInit?.method, "POST");
  assert.equal(seenInit?.body, "payload");
});

test("translates an abort into a message naming the call and the budget", async () => {
  const fetchImpl = (async () => {
    // What the runtime raises when the injected signal fires.
    const error = new Error("This operation was aborted");
    error.name = "TimeoutError";
    throw error;
  }) as unknown as typeof fetch;

  await assert.rejects(
    fetchWithTimeout(fetchImpl, "https://example.test", {}, { timeoutMs: 1_234, label: "NVIDIA analysis" }),
    // An unhandled AbortError reads like a bug; a slow provider is an operational fact.
    /NVIDIA analysis timed out after 1234ms\. Raise its timeout or use a faster model\./,
  );
});

test("a genuine transport error is passed through untouched", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("network unreachable");
  }) as unknown as typeof fetch;

  await assert.rejects(
    fetchWithTimeout(fetchImpl, "https://example.test", {}, { timeoutMs: 1_000, label: "test call" }),
    /network unreachable/,
  );
});

test("the shared default is bounded well under Node's own socket timeout", () => {
  // Node aborts at 300s with an opaque "fetch failed"; the adapters must give up first.
  assert.ok(DEFAULT_MODEL_REQUEST_TIMEOUT_MS < 300_000);
});

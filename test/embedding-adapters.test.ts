import test from "node:test";
import assert from "node:assert/strict";
import { NvidiaEmbedding } from "../src/infrastructure/memory/nvidia-embedding.js";
import { GeminiEmbedding } from "../src/infrastructure/memory/gemini-embedding.js";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function stubFetch(respond: (call: Call) => Response): { readonly calls: Call[]; readonly fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function body(call: Call | undefined): Record<string, unknown> {
  return JSON.parse(call?.init.body as string) as Record<string, unknown>;
}

test("NVIDIA embedding batches inputs and marks stored text as a passage", async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({
    data: [
      { index: 0, embedding: [0, 1, 0] },
      { index: 1, embedding: [1, 0, 0] },
    ],
    usage: { prompt_tokens: 24 },
  }));
  const embedding = new NvidiaEmbedding({ apiKey: "nvapi-test", model: "nvidia/llama-3.2-nv-embedqa-1b-v2" }, fetchImpl);

  const result = await embedding.embed({ texts: ["first", "second"], kind: "document" });

  assert.equal(calls[0]?.url, "https://integrate.api.nvidia.com/v1/embeddings");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer nvapi-test");
  const sent = body(calls[0]);
  assert.deepEqual(sent.input, ["first", "second"], "one request for the whole batch");
  // nv-embedqa is asymmetric and rejects requests without input_type.
  assert.equal(sent.input_type, "passage");
  assert.equal(sent.encoding_format, "float");
  assert.equal(result.model, "nvidia/llama-3.2-nv-embedqa-1b-v2");
  assert.deepEqual(result.vectors, [[0, 1, 0], [1, 0, 0]]);
  assert.deepEqual(result.tokenUsage, {
    provider: "nvidia",
    model: "nvidia/llama-3.2-nv-embedqa-1b-v2",
    inputTokens: 24,
    outputTokens: 0,
    totalTokens: 24,
  });
});

test("NVIDIA embedding marks a question as a query", async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1] }] }));
  const embedding = new NvidiaEmbedding({ apiKey: "k", model: "m" }, fetchImpl);

  await embedding.embed({ texts: ["what did I decide?"], kind: "query" });

  assert.equal(body(calls[0]).input_type, "query");
});

test("NVIDIA input_type can be switched off for an endpoint that rejects it", async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1] }] }));
  const embedding = new NvidiaEmbedding({ apiKey: "k", model: "m", sendInputType: false }, fetchImpl);

  await embedding.embed({ texts: ["x"], kind: "query" });

  assert.equal("input_type" in body(calls[0]), false);
});

test("NVIDIA embedding restores request order from out-of-order data", async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse({
    data: [
      { index: 1, embedding: [2, 2] },
      { index: 0, embedding: [1, 1] },
    ],
  }));
  const embedding = new NvidiaEmbedding({ apiKey: "k", model: "m" }, fetchImpl);

  // Order carries the record identity: a shifted vector attaches memory to the wrong row.
  assert.deepEqual(
    (await embedding.embed({ texts: ["a", "b"], kind: "document" })).vectors,
    [[1, 1], [2, 2]],
  );
});

test("a short NVIDIA response fails instead of silently misaligning records", async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1] }] }));
  const embedding = new NvidiaEmbedding({ apiKey: "k", model: "m" }, fetchImpl);

  await assert.rejects(
    () => embedding.embed({ texts: ["a", "b"], kind: "document" }),
    /returned 1 vectors for 2 inputs/,
  );
});

test("an NVIDIA error status surfaces the response body", async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse({ detail: "unknown model" }, 400));
  const embedding = new NvidiaEmbedding({ apiKey: "k", model: "bad" }, fetchImpl);

  await assert.rejects(
    () => embedding.embed({ texts: ["a"], kind: "query" }),
    /NVIDIA embedding failed with status 400.*unknown model/s,
  );
});

test("an empty batch costs no request at all", async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ data: [] }));
  const embedding = new NvidiaEmbedding({ apiKey: "k", model: "m" }, fetchImpl);

  assert.deepEqual((await embedding.embed({ texts: [], kind: "document" })).vectors, []);
  assert.equal(calls.length, 0);
});

test("Gemini embedding uses batchEmbedContents with a retrieval task type", async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({
    embeddings: [{ values: [0, 1] }, { values: [1, 0] }],
  }));
  const embedding = new GeminiEmbedding({ apiKey: "gem-key", model: "gemini-embedding-001" }, fetchImpl);

  const result = await embedding.embed({ texts: ["a", "b"], kind: "document" });

  assert.equal(
    calls[0]?.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
  );
  assert.equal((calls[0]?.init.headers as Record<string, string>)["x-goog-api-key"], "gem-key");
  const requests = body(calls[0]).requests as readonly Record<string, unknown>[];
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.taskType, "RETRIEVAL_DOCUMENT");
  assert.deepEqual(result.vectors, [[0, 1], [1, 0]]);
});

test("Gemini embedding switches task type for a question", async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ embeddings: [{ values: [1] }] }));
  const embedding = new GeminiEmbedding({ apiKey: "k", model: "m" }, fetchImpl);

  await embedding.embed({ texts: ["what did I decide?"], kind: "query" });

  const requests = body(calls[0]).requests as readonly Record<string, unknown>[];
  assert.equal(requests[0]?.taskType, "RETRIEVAL_QUERY");
});

test("a short Gemini response fails rather than misaligning records", async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse({ embeddings: [{ values: [1] }] }));
  const embedding = new GeminiEmbedding({ apiKey: "k", model: "m" }, fetchImpl);

  await assert.rejects(
    () => embedding.embed({ texts: ["a", "b"], kind: "document" }),
    /returned 1 vectors for 2 inputs/,
  );
});

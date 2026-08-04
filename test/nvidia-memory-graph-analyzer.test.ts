import test from "node:test";
import assert from "node:assert/strict";
import { NvidiaMemoryGraphAnalyzer } from "../src/infrastructure/reasoning/nvidia-memory-graph-analyzer.js";
import type { ConversationAnalysisInput } from "../src/application/ports/memory-graph-analyzer.js";

const source = {
  platform: "telegram",
  conversationId: "chat-1",
  messageId: "message-1",
  occurredAt: "2026-06-21T12:00:00.000Z",
};

const analysisInput: ConversationAnalysisInput = {
  window: {
    platform: "telegram",
    conversationId: "chat-1",
    messages: [{
      platform: "telegram",
      conversationId: "chat-1",
      messageId: "message-1",
      senderId: "mak",
      text: "I need an English routine.",
      occurredAt: new Date(source.occurredAt),
    }],
  },
};

const analysisOutput = {
  memories: [],
  nodes: [{
    idempotencyKey: "node:goal:english",
    source,
    confidence: 0.88,
    reason: "English goal detected.",
    value: {
      id: "goal:english",
      kind: "goal",
      label: "English growth",
      scope: "user",
      payload: { payloadKind: "goal", status: "suggested", desiredOutcome: "Improve English" },
    },
  }],
  edges: [{
    idempotencyKey: "edge:mak-english",
    source,
    confidence: 0.8,
    reason: "Goal needs routine.",
    value: {
      id: "edge:mak-english",
      fromNodeId: "person:mak",
      toNodeId: "goal:english",
      relation: "GOAL_HAS_ROUTINE",
      fact: "English growth needs a practice routine",
    },
  }],
  strategicSuggestions: [{
    idempotencyKey: "suggestion:english-routine",
    source,
    confidence: 0.82,
    reason: "Routine suggestion.",
    value: {
      id: "suggestion:english-routine",
      kind: "routine_experiment",
      title: "Run English speaking loop",
      rationale: "A small speaking loop can improve English practice.",
      riskLevel: "low",
      evidenceNodeIds: ["goal:english"],
    },
  }],
  actionSuggestions: [],
  warnings: [],
};

interface StubbedCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** Replaces global fetch with a stub and always restores it. */
async function withStubbedFetch(
  respond: (call: StubbedCall) => Response,
  run: (calls: readonly StubbedCall[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const calls: StubbedCall[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function chatCompletion(content: string): unknown {
  return {
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    usage: { prompt_tokens: 111, completion_tokens: 222, total_tokens: 333 },
  };
}

test("NVIDIA GLM analyzer posts an OpenAI-compatible request and maps the analysis", async () => {
  await withStubbedFetch(
    () => jsonResponse(chatCompletion(JSON.stringify(analysisOutput))),
    async (calls) => {
      const analyzer = new NvidiaMemoryGraphAnalyzer({
        apiKey: "nvapi-test",
        model: "z-ai/glm-5.2",
      });
      const result = await analyzer.analyze(analysisInput);

      assert.equal(result.nodes[0]?.id, "goal:english");
      assert.equal(result.edges[0]?.relation, "GOAL_HAS_ROUTINE");
      assert.equal(result.suggestions[0]?.status, "pending");
      assert.deepEqual(result.tokenUsage, {
        provider: "nvidia",
        model: "z-ai/glm-5.2",
        inputTokens: 111,
        outputTokens: 222,
        totalTokens: 333,
      });

      const call = calls[0];
      assert.equal(call?.url, "https://integrate.api.nvidia.com/v1/chat/completions");
      assert.equal((call?.init.headers as Record<string, string>).authorization, "Bearer nvapi-test");

      const request = JSON.parse(call?.init.body as string) as {
        model: string;
        max_tokens: number;
        stream: boolean;
        response_format: { type: string };
        messages: readonly { readonly role: string; readonly content: string }[];
      };
      assert.equal(request.model, "z-ai/glm-5.2");
      assert.equal(request.max_tokens, 4000);
      assert.equal(request.stream, false);
      assert.deepEqual(request.response_format, { type: "json_object" });
      assert.equal(request.messages[0]?.role, "system");
      assert.equal(request.messages[1]?.role, "user");
      // The window must reach the model, and only through the user message.
      assert.match(request.messages[1]?.content ?? "", /I need an English routine\./);
    },
  );
});

test("NVIDIA GLM analyzer tolerates fenced JSON and ignores reasoning traces", async () => {
  await withStubbedFetch(
    () => jsonResponse({
      choices: [{
        finish_reason: "stop",
        message: {
          content: `\`\`\`json\n${JSON.stringify(analysisOutput)}\n\`\`\``,
          reasoning_content: "Internal trace that must never become durable output.",
        },
      }],
      usage: { prompt_tokens: 5, completion_tokens: 7 },
    }),
    async () => {
      const analyzer = new NvidiaMemoryGraphAnalyzer({ apiKey: "nvapi-test", model: "z-ai/glm-5.2" });
      const result = await analyzer.analyze(analysisInput);
      assert.equal(result.nodes[0]?.id, "goal:english");
      assert.equal(result.tokenUsage?.totalTokens, 12);
    },
  );
});

test("NVIDIA GLM analyzer can omit response_format for endpoints that reject it", async () => {
  await withStubbedFetch(
    () => jsonResponse(chatCompletion(JSON.stringify(analysisOutput))),
    async (calls) => {
      const analyzer = new NvidiaMemoryGraphAnalyzer({
        apiKey: "nvapi-test",
        model: "z-ai/glm-5.2",
        jsonResponseFormat: false,
        baseUrl: "https://example.invalid/v1/chat/completions",
      });
      await analyzer.analyze(analysisInput);

      const request = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
      assert.equal(calls[0]?.url, "https://example.invalid/v1/chat/completions");
      assert.equal("response_format" in request, false);
    },
  );
});

test("NVIDIA GLM analyzer surfaces transport failures with status and body", async () => {
  await withStubbedFetch(
    () => jsonResponse({ detail: "Invalid API key" }, 401),
    async () => {
      const analyzer = new NvidiaMemoryGraphAnalyzer({ apiKey: "nvapi-bad", model: "z-ai/glm-5.2" });
      await assert.rejects(
        analyzer.analyze(analysisInput),
        /NVIDIA response failed with status 401: .*Invalid API key/,
      );
    },
  );
});

test("NVIDIA GLM analyzer reports a truncated response instead of a parse error", async () => {
  await withStubbedFetch(
    () => jsonResponse({ choices: [{ finish_reason: "length", message: { content: "" } }] }),
    async () => {
      const analyzer = new NvidiaMemoryGraphAnalyzer({ apiKey: "nvapi-test", model: "z-ai/glm-5.2", maxTokens: 64 });
      await assert.rejects(analyzer.analyze(analysisInput), /hit the 64 output token limit/);
    },
  );
});

test("NVIDIA GLM analyzer reports truncation when the JSON is cut off midway", async () => {
  await withStubbedFetch(
    () => jsonResponse({
      choices: [{ finish_reason: "length", message: { content: '{"memories": [], "nodes": [{"idempot' } }],
    }),
    async () => {
      const analyzer = new NvidiaMemoryGraphAnalyzer({ apiKey: "nvapi-test", model: "z-ai/glm-5.2", maxTokens: 64 });
      await assert.rejects(analyzer.analyze(analysisInput), /hit the 64 output token limit/);
    },
  );
});

test("NVIDIA GLM analyzer reports invalid JSON as such when the response was not truncated", async () => {
  await withStubbedFetch(
    () => jsonResponse(chatCompletion("Sorry, I cannot do that.")),
    async () => {
      const analyzer = new NvidiaMemoryGraphAnalyzer({ apiKey: "nvapi-test", model: "z-ai/glm-5.2" });
      await assert.rejects(analyzer.analyze(analysisInput), /NVIDIA z-ai\/glm-5\.2 response was not valid JSON/);
    },
  );
});

test("NVIDIA GLM analyzer rejects output that violates the provider-neutral contract", async () => {
  await withStubbedFetch(
    () => jsonResponse(chatCompletion(JSON.stringify({ nodes: [] }))),
    async () => {
      const analyzer = new NvidiaMemoryGraphAnalyzer({ apiKey: "nvapi-test", model: "z-ai/glm-5.2" });
      await assert.rejects(analyzer.analyze(analysisInput), /nvidia analysis output rejected/);
    },
  );
});

const sourceOnlyMessageId = {
  memories: [], nodes: [], edges: [], strategicSuggestions: [], actionSuggestions: [],
  warnings: [], statusUpdates: [],
  tasks: [{
    idempotencyKey: "t1",
    reason: "from the second message",
    confidence: 0.9,
    // Verified live: z-ai/glm-5.2 returns source as { messageId } only.
    source: { messageId: "m2" },
    value: { title: "Ship the billing fix" },
  }],
};

const twoMessageWindow: ConversationAnalysisInput = {
  window: {
    platform: "telegram",
    conversationId: "chat-1",
    messages: [
      {
        platform: "telegram", conversationId: "chat-1", messageId: "m1", senderId: "7",
        text: "first", occurredAt: new Date("2026-06-19T11:00:00.000Z"),
      },
      {
        platform: "telegram", conversationId: "chat-1", messageId: "m2", senderId: "7",
        text: "second", occurredAt: new Date("2026-06-19T11:05:00.000Z"),
      },
    ],
  },
};

test("resolves item source references from the window instead of trusting the model", async () => {
  await withStubbedFetch(
    () => jsonResponse(chatCompletion(JSON.stringify(sourceOnlyMessageId))),
    async () => {
      const analyzer = new NvidiaMemoryGraphAnalyzer({ apiKey: "nvapi-test", model: "z-ai/glm-5.2" });

      // Platform, conversation id, and timestamp are known locally. Requiring the
      // model to echo them wastes tokens and lets it misattribute a conversation.
      const result = await analyzer.analyze(twoMessageWindow);

      assert.equal(result.tasks.length, 1);
      assert.equal(result.tasks[0]?.sourceMessageId, "m2");
    },
  );
});

test("an invented messageId falls back to the window anchor instead of dropping knowledge", async () => {
  const invented = {
    ...sourceOnlyMessageId,
    tasks: [{ ...sourceOnlyMessageId.tasks[0], source: { messageId: "does-not-exist" } }],
  };

  await withStubbedFetch(
    () => jsonResponse(chatCompletion(JSON.stringify(invented))),
    async () => {
      const analyzer = new NvidiaMemoryGraphAnalyzer({ apiKey: "nvapi-test", model: "z-ai/glm-5.2" });
      const result = await analyzer.analyze(twoMessageWindow);

      assert.equal(result.tasks.length, 1);
      assert.equal(result.tasks[0]?.sourceMessageId, "m2");
    },
  );
});

test("the analysis prompt asks for a messageId-only source", async () => {
  await withStubbedFetch(
    () => jsonResponse(chatCompletion(JSON.stringify(sourceOnlyMessageId))),
    async (calls) => {
      const analyzer = new NvidiaMemoryGraphAnalyzer({ apiKey: "nvapi-test", model: "z-ai/glm-5.2" });
      await analyzer.analyze(twoMessageWindow);

      const body = JSON.parse(String(calls[0]?.init.body)) as {
        messages: readonly { readonly role: string; readonly content: string }[];
      };
      const system = body.messages.find((message) => message.role === "system")?.content ?? "";
      assert.match(system, /source is exactly \{ "messageId"/);
      assert.match(system, /Never invent a messageId/);
    },
  );
});

test("reported reasoning tokens are recorded, because they are paid for and discarded", async () => {
  await withStubbedFetch(
    () => jsonResponse({
      choices: [{
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify(analysisOutput),
          reasoning_content: "Thinking about the English routine…",
        },
      }],
      usage: {
        prompt_tokens: 1534,
        completion_tokens: 3194,
        completion_tokens_details: { reasoning_tokens: 2100 },
      },
    }),
    async () => {
      const analyzer = new NvidiaMemoryGraphAnalyzer({ apiKey: "nvapi-test", model: "z-ai/glm-5.2" });
      const result = await analyzer.analyze(analysisInput);

      // The exact count wins over the length estimate when the provider reports one.
      assert.equal(result.tokenUsage?.reasoningTokens, 2100);
      assert.equal(result.tokenUsage?.outputTokens, 3194);
    },
  );
});

test("an unreported reasoning trace is estimated from its length rather than reported as zero", async () => {
  const trace = "x".repeat(400);
  await withStubbedFetch(
    () => jsonResponse({
      choices: [{
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify(analysisOutput), reasoning_content: trace },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
    async () => {
      const analyzer = new NvidiaMemoryGraphAnalyzer({ apiKey: "nvapi-test", model: "z-ai/glm-5.2" });
      const result = await analyzer.analyze(analysisInput);

      assert.equal(result.tokenUsage?.reasoningTokens, 100);
    },
  );
});

test("a model with no reasoning trace reports no reasoning tokens at all", async () => {
  await withStubbedFetch(
    () => jsonResponse(chatCompletion(JSON.stringify(analysisOutput))),
    async () => {
      const analyzer = new NvidiaMemoryGraphAnalyzer({ apiKey: "nvapi-test", model: "z-ai/glm-5.2" });
      const result = await analyzer.analyze(analysisInput);

      assert.equal(result.tokenUsage?.reasoningTokens, undefined);
      assert.equal("reasoningTokens" in (result.tokenUsage ?? {}), false);
    },
  );
});

test("per-call latency and throughput are logged, so a slow window has an explanation", async () => {
  const logged: { readonly message: string; readonly context?: Record<string, unknown> }[] = [];
  await withStubbedFetch(
    () => jsonResponse(chatCompletion(JSON.stringify(analysisOutput))),
    async () => {
      const analyzer = new NvidiaMemoryGraphAnalyzer({
        apiKey: "nvapi-test",
        model: "z-ai/glm-5.2",
        logger: {
          info: (message, context) => logged.push({ message, ...(context === undefined ? {} : { context }) }),
          warn: () => {},
          error: () => {},
        },
      });
      await analyzer.analyze(analysisInput);

      const entry = logged.find((item) => item.message === "NVIDIA analysis completed");
      assert.notEqual(entry, undefined);
      assert.equal(entry?.context?.outputTokens, 222);
      assert.equal(typeof entry?.context?.latencyMs, "number");
      assert.equal(typeof entry?.context?.outputTokensPerSecond, "number");
      // Prompt size is the other half of the cost question.
      assert.ok((entry?.context?.promptChars as number) > 0);
    },
  );
});

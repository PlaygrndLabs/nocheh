import test from "node:test";
import assert from "node:assert/strict";
import { AnthropicMemoryGraphAnalyzer } from "../src/infrastructure/reasoning/anthropic-memory-graph-analyzer.js";

const source = {
  platform: "telegram",
  conversationId: "chat-1",
  messageId: "message-1",
  occurredAt: "2026-06-21T12:00:00.000Z",
};

test("Anthropic memory graph analyzer sends messages request and returns token usage", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { readonly url: string; readonly init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({
      content: [{
        type: "text",
        text: JSON.stringify({
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
        }),
      }],
      usage: {
        input_tokens: 111,
        output_tokens: 222,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const analyzer = new AnthropicMemoryGraphAnalyzer({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-test",
    });
    const result = await analyzer.analyze({
      platform: "telegram",
      conversationId: "chat-1",
      messageId: "message-1",
      senderId: "mak",
      text: "I need an English routine.",
      occurredAt: new Date(source.occurredAt),
    });

    assert.equal(result.nodes[0]?.id, "goal:english");
    assert.equal(result.edges[0]?.relation, "GOAL_HAS_ROUTINE");
    assert.equal(result.suggestions[0]?.status, "pending");
    assert.deepEqual(result.tokenUsage, {
      provider: "anthropic",
      model: "claude-sonnet-test",
      inputTokens: 111,
      outputTokens: 222,
      totalTokens: 333,
    });

    const request = JSON.parse(calls[0]?.init.body as string) as {
      model: string;
      max_tokens: number;
      system: string;
      messages: readonly { readonly role: string; readonly content: readonly { readonly text: string }[] }[];
    };
    assert.equal(calls[0]?.url, "https://api.anthropic.com/v1/messages");
    assert.equal((calls[0]?.init.headers as Record<string, string>)["x-api-key"], "sk-ant-test");
    assert.equal((calls[0]?.init.headers as Record<string, string>)["anthropic-version"], "2023-06-01");
    assert.equal(request.model, "claude-sonnet-test");
    assert.equal(request.max_tokens, 4000);
    assert.equal(request.messages[0]?.role, "user");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

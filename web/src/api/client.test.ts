import { afterEach, expect, test, vi } from "vitest";
import { api } from "./client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(status: number, payload: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })),
  );
}

test("putEnv posts the values envelope and returns the result", async () => {
  mockFetch(200, { ok: true, updated: ["AI_API_KEY"], rejected: [] });

  const result = await api.putEnv({ AI_API_KEY: "secret" });

  expect(result.updated).toEqual(["AI_API_KEY"]);
  const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(call?.[0]).toBe("/api/env");
  expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({ values: { AI_API_KEY: "secret" } });
});

test("throws with the server error message on ok:false", async () => {
  mockFetch(400, { ok: false, error: "Invalid bot token" });

  await expect(api.connectBot("bad", "https://x")).rejects.toThrow("Invalid bot token");
});

test("getConversations returns the conversation list", async () => {
  mockFetch(200, { ok: true, conversations: [{ conversationId: "c1", platform: "mock", messageCount: 2, lastProcessedAt: "2026-06-20T00:00:00.000Z", lastPreview: "hi" }] });

  const result = await api.getConversations();

  expect(result.conversations).toHaveLength(1);
  expect(result.conversations[0]?.conversationId).toBe("c1");
});

test("approveBrainSuggestion posts to the suggestion approval endpoint", async () => {
  mockFetch(200, { suggestion: { id: "suggestion:1", type: "strategic", kind: "goal", title: "Goal", rationale: "Reason", status: "accepted", riskLevel: "low", confidence: 0.8 } });

  const result = await api.approveBrainSuggestion("suggestion:1");

  expect(result.suggestion.status).toBe("accepted");
  const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(call?.[0]).toBe("/api/brain/suggestions/suggestion%3A1/approve");
  expect((call?.[1] as RequestInit).method).toBe("POST");
});

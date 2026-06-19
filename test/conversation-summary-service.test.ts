import test from "node:test";
import assert from "node:assert/strict";
import { ConversationSummaryService } from "../src/domain/memory/conversation-summary.js";
import type { MemoryRecord } from "../src/domain/memory/memory-record.js";

const source = {
  platform: "telegram",
  conversationId: "chat-1",
  messageId: "summary",
  occurredAt: new Date("2026-06-19T10:00:00.000Z"),
};

test("creates summaries from structured records only", () => {
  const records: MemoryRecord[] = [{
    id: "decision-1",
    type: "Decision",
    source,
    timestamp: new Date("2026-06-19T11:00:00.000Z"),
    confidence: 0.9,
    decision: { title: "Use Workers", outcome: "Use Cloudflare Workers for the API" },
  }];

  const summary = new ConversationSummaryService().createSummary({
    records,
    source,
    timestamp: new Date("2026-06-19T12:00:00.000Z"),
  });

  assert.equal(summary?.type, "Summary");
  assert.equal(summary?.summary?.coveredRecordIds[0], "decision-1");
  assert.match(summary?.summary?.summary ?? "", /Cloudflare Workers/);
});

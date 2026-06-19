import test from "node:test";
import assert from "node:assert/strict";
import { RuleBasedMemoryExtractor } from "../src/infrastructure/reasoning/rule-based-memory-extractor.js";

test("extracts project, decision, blocker, deadline, and summary candidates", async () => {
  const extractor = new RuleBasedMemoryExtractor();

  const candidates = await extractor.extractMemory({
    platform: "telegram",
    conversationId: "chat-1",
    messageId: "1",
    senderId: "7",
    text: [
      "Project: Atlas - customer migration",
      "Decision: use Postgres for durable state.",
      "Blocker: waiting on legal review.",
      "Deadline: launch by 2026-07-01.",
      "Summary: Atlas migration is on track.",
    ].join("\n"),
    occurredAt: new Date("2026-06-19T10:00:00.000Z"),
  });

  assert.deepEqual(candidates.map((candidate) => candidate.type), ["Project", "Decision", "Blocker", "Deadline", "Summary"]);
  assert.equal(candidates[0]?.project?.name, "Atlas");
  assert.equal(candidates.find((candidate) => candidate.type === "Decision")?.project?.id, "project:atlas");
  const deadline = candidates.find((candidate) => candidate.type === "Deadline");
  assert.equal(deadline?.type, "Deadline");
  assert.equal(deadline.deadline.dueAt?.toISOString(), "2026-07-01T23:59:59.000Z");
});

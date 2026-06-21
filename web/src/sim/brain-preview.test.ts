import { expect, test } from "vitest";
import { buildBrainPreview } from "./brain-preview.js";
import type { SimEntry } from "../state/useSimulation.js";

test("buildBrainPreview creates domain memories, graph edges, and blocked trading guardrail", () => {
  const entries: SimEntry[] = [
    {
      kind: "user",
      sender: "Mak",
      text: "I want English routine, X content ideas, startup partner goals, and crypto thesis but do not trade.",
      at: "2026-06-21T00:00:00.000Z",
    },
  ];

  const preview = buildBrainPreview(entries);

  expect(preview.metrics.messages).toBe(1);
  expect(preview.memories.some((memory) => memory.type === "LearningPlan")).toBe(true);
  expect(preview.memories.some((memory) => memory.type === "ContentPlan")).toBe(true);
  expect(preview.edges.some((edge) => edge.relation === "GOAL_HAS_ROUTINE")).toBe(true);
  expect(preview.suggestions.some((suggestion) => suggestion.status === "blocked")).toBe(true);
  expect(preview.guardrails.some((guardrail) => guardrail.label === "Trading boundary" && guardrail.status === "blocked")).toBe(true);
});

test("buildBrainPreview shows a useful empty-state preview before input", () => {
  const preview = buildBrainPreview([]);

  expect(preview.metrics.messages).toBe(0);
  expect(preview.memories.some((memory) => memory.type === "Preview")).toBe(true);
  expect(preview.stages[0]?.status).toBe("waiting");
});

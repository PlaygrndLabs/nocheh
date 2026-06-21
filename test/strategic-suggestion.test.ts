import test from "node:test";
import assert from "node:assert/strict";
import { SuggestionService } from "../src/application/services/suggestion-service.js";
import type { SuggestionRepositoryPort } from "../src/application/ports/suggestion-repository.js";
import {
  acceptSuggestion,
  convertSuggestion,
  createStrategicSuggestion,
  type Suggestion,
} from "../src/domain/memory/strategic-suggestion.js";
import type { MemoryGraphSource } from "../src/domain/memory/memory-graph.js";

const now = new Date("2026-06-21T10:00:00.000Z");
const source: MemoryGraphSource = {
  platform: "telegram",
  conversationId: "chat-1",
  messageId: "message-1",
  occurredAt: new Date("2026-06-21T09:59:00.000Z"),
};

test("creates pending strategic suggestions that are not facts yet", () => {
  const suggestion = createStrategicSuggestion({
    id: "suggestion:goal",
    kind: "goal",
    title: "Build an English speaking routine",
    rationale: "Mak mentioned learning English and routine support can compound.",
    expectedValue: "Better speaking confidence",
    source,
    confidence: 0.82,
    riskLevel: "low",
    proposedNode: {
      id: "goal:english-speaking",
      kind: "goal",
      label: "English speaking confidence",
      scope: "user",
      source,
      confidence: 0.82,
    },
    now,
  });

  assert.equal(suggestion.status, "pending");
  assert.equal(suggestion.type, "strategic");
  assert.equal(suggestion.proposedNode?.id, "goal:english-speaking");
});

test("requires acceptance before converting a suggestion", () => {
  const suggestion = createStrategicSuggestion({
    id: "suggestion:idea",
    kind: "idea",
    title: "Create startup partner review ritual",
    rationale: "Weekly partner review could reduce hidden blockers.",
    source,
    confidence: 0.78,
    riskLevel: "medium",
    now,
  });

  assert.throws(() => convertSuggestion(suggestion, now), /accepted suggestions/);
  assert.equal(convertSuggestion(acceptSuggestion(suggestion, now), now).status, "converted");
});

test("service blocks external actions until accepted by Mak", async () => {
  const repository = new InMemorySuggestionRepository();
  const service = new SuggestionService(repository);
  const suggestion = await service.suggestAction({
    id: "suggestion:tweet",
    kind: "publish_content",
    title: "Draft X post about Nocheh",
    rationale: "The post can grow Mak's page, but publishing needs approval.",
    target: "x:mak",
    preview: "I am building Nocheh as my second brain.",
    source,
    confidence: 0.75,
    riskLevel: "medium",
    now,
  });

  assert.equal(suggestion.status, "pending");
  assert.equal(suggestion.type, "action");
  assert.equal(suggestion.requiresApproval, true);
  await assert.rejects(() => service.assertCanExecuteExternalAction(suggestion.id), /accepted human approval/);

  await service.accept(suggestion.id, now);
  assert.equal((await service.assertCanExecuteExternalAction(suggestion.id)).status, "accepted");
});

test("service converts accepted suggestions into downstream artifacts only after approval", async () => {
  const repository = new InMemorySuggestionRepository();
  const service = new SuggestionService(repository);
  const suggestion = await service.suggestStrategy({
    id: "suggestion:convert-routine",
    kind: "routine_experiment",
    title: "Try weekly startup review",
    rationale: "A review routine can reveal blockers earlier.",
    source,
    confidence: 0.8,
    riskLevel: "low",
    now,
  });

  await assert.rejects(() => service.convertAcceptedTo(suggestion.id, () => ({ id: "routine:review" }), now), /accepted/);
  await service.accept(suggestion.id, now);

  const converted = await service.convertAcceptedTo(suggestion.id, (accepted) => ({
    id: "routine:review",
    title: accepted.title,
  }), now);

  assert.equal(converted.value.id, "routine:review");
  assert.equal(converted.suggestion.status, "converted");
  assert.equal((await repository.findById(suggestion.id))?.status, "converted");
});

class InMemorySuggestionRepository implements SuggestionRepositoryPort {
  private readonly suggestions = new Map<string, Suggestion>();

  public async save(suggestion: Suggestion): Promise<void> {
    this.suggestions.set(suggestion.id, suggestion);
  }

  public async findById(id: string): Promise<Suggestion | undefined> {
    return this.suggestions.get(id);
  }

  public async findByStatus(status: Suggestion["status"]): Promise<readonly Suggestion[]> {
    return [...this.suggestions.values()].filter((suggestion) => suggestion.status === status);
  }

  public async findPending(): Promise<readonly Suggestion[]> {
    return this.findByStatus("pending");
  }
}

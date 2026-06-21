import type { SuggestionRepositoryPort } from "../ports/suggestion-repository.js";
import type {
  CreateActionSuggestionInput,
  CreateStrategicSuggestionInput,
  Suggestion,
  SuggestionId,
} from "../../domain/memory/strategic-suggestion.js";
import {
  acceptSuggestion,
  archiveSuggestion,
  convertSuggestion,
  createActionSuggestion,
  createStrategicSuggestion,
  rejectSuggestion,
} from "../../domain/memory/strategic-suggestion.js";

export class SuggestionService {
  public constructor(private readonly repository: SuggestionRepositoryPort) {}

  public async suggestStrategy(input: CreateStrategicSuggestionInput): Promise<Suggestion> {
    const suggestion = createStrategicSuggestion(input);
    await this.repository.save(suggestion);
    return suggestion;
  }

  public async suggestAction(input: CreateActionSuggestionInput): Promise<Suggestion> {
    const suggestion = createActionSuggestion(input);
    await this.repository.save(suggestion);
    return suggestion;
  }

  public async pending(): Promise<readonly Suggestion[]> {
    return this.repository.findPending();
  }

  public async accept(id: SuggestionId, now = new Date()): Promise<Suggestion> {
    return this.updateExisting(id, (suggestion) => acceptSuggestion(suggestion, now));
  }

  public async reject(id: SuggestionId, now = new Date()): Promise<Suggestion> {
    return this.updateExisting(id, (suggestion) => rejectSuggestion(suggestion, now));
  }

  public async archive(id: SuggestionId, now = new Date()): Promise<Suggestion> {
    return this.updateExisting(id, (suggestion) => archiveSuggestion(suggestion, now));
  }

  public async convertAccepted(id: SuggestionId, now = new Date()): Promise<Suggestion> {
    return this.updateExisting(id, (suggestion) => convertSuggestion(suggestion, now));
  }

  public async convertAcceptedTo<T>(
    id: SuggestionId,
    convert: (suggestion: Suggestion) => Promise<T> | T,
    now = new Date(),
  ): Promise<{ readonly suggestion: Suggestion; readonly value: T }> {
    const current = await this.required(id);
    if (current.status !== "accepted") {
      throw new Error("Only accepted suggestions can be converted.");
    }
    const value = await convert(current);
    const suggestion = convertSuggestion(current, now);
    await this.repository.save(suggestion);
    return { suggestion, value };
  }

  public async assertCanExecuteExternalAction(id: SuggestionId): Promise<Suggestion> {
    const suggestion = await this.required(id);
    if (suggestion.type !== "action") {
      throw new Error("Only action suggestions can execute external actions.");
    }
    if (suggestion.status !== "accepted") {
      throw new Error("External actions require accepted human approval.");
    }
    return suggestion;
  }

  private async updateExisting(id: SuggestionId, update: (suggestion: Suggestion) => Suggestion): Promise<Suggestion> {
    const updated = update(await this.required(id));
    await this.repository.save(updated);
    return updated;
  }

  private async required(id: SuggestionId): Promise<Suggestion> {
    const suggestion = await this.repository.findById(id);
    if (suggestion === undefined) {
      throw new Error(`Suggestion not found: ${id}`);
    }
    return suggestion;
  }
}

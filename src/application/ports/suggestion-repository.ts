import type {
  Suggestion,
  SuggestionId,
  SuggestionStatus,
} from "../../domain/memory/strategic-suggestion.js";

export interface SuggestionRepositoryPort {
  save(suggestion: Suggestion): Promise<void>;
  findById(id: SuggestionId): Promise<Suggestion | undefined>;
  findByStatus(status: SuggestionStatus): Promise<readonly Suggestion[]>;
  findPending(): Promise<readonly Suggestion[]>;
}

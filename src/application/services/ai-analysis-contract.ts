import type {
  CreateMemoryEdgeInput,
  CreateMemoryNodeInput,
  MemoryGraphSource,
} from "../../domain/memory/memory-graph.js";
import type {
  CreateActionSuggestionInput,
  CreateStrategicSuggestionInput,
} from "../../domain/memory/strategic-suggestion.js";
import { err, ok, type Result } from "../../shared/result.js";

export interface AiAnalysisItemEnvelope<T> {
  readonly idempotencyKey: string;
  readonly source: MemoryGraphSource;
  readonly confidence: number;
  readonly reason: string;
  readonly value: T;
}

export interface AiAnalysisWarning {
  readonly idempotencyKey: string;
  readonly source: MemoryGraphSource;
  readonly confidence: number;
  readonly reason: string;
  readonly message: string;
}

export interface ProviderNeutralAiAnalysisOutput {
  readonly memories: readonly AiAnalysisItemEnvelope<Readonly<Record<string, unknown>>>[];
  readonly nodes: readonly AiAnalysisItemEnvelope<CreateMemoryNodeInput>[];
  readonly edges: readonly AiAnalysisItemEnvelope<CreateMemoryEdgeInput>[];
  readonly strategicSuggestions: readonly AiAnalysisItemEnvelope<CreateStrategicSuggestionInput>[];
  readonly actionSuggestions: readonly AiAnalysisItemEnvelope<CreateActionSuggestionInput>[];
  readonly warnings: readonly AiAnalysisWarning[];
}

export interface AiAnalysisValidationOptions {
  readonly minimumConfidence?: number;
}

export function validateAiAnalysisOutput(
  value: unknown,
  options: AiAnalysisValidationOptions = {},
): Result<ProviderNeutralAiAnalysisOutput> {
  const minimumConfidence = options.minimumConfidence ?? 0.5;
  if (!isRecord(value)) {
    return err(new Error("AI analysis output must be an object."));
  }

  const keys = ["memories", "nodes", "edges", "strategicSuggestions", "actionSuggestions", "warnings"] as const;
  for (const key of keys) {
    if (!Array.isArray(value[key])) {
      return err(new Error(`AI analysis output ${key} must be an array.`));
    }
  }

  for (const key of keys) {
    const items = value[key] as readonly unknown[];
    for (const item of items) {
      const validation = validateEnvelope(item, key, minimumConfidence);
      if (!validation.ok) {
        return validation;
      }
    }
  }

  return ok(value as unknown as ProviderNeutralAiAnalysisOutput);
}

function validateEnvelope(item: unknown, key: string, minimumConfidence: number): Result<void> {
  if (!isRecord(item)) {
    return err(new Error(`AI analysis ${key} item must be an object.`));
  }
  if (!nonEmptyString(item.idempotencyKey)) {
    return err(new Error(`AI analysis ${key} item requires idempotencyKey.`));
  }
  if (!nonEmptyString(item.reason)) {
    return err(new Error(`AI analysis ${key} item requires reason.`));
  }
  if (!isValidSource(item.source)) {
    return err(new Error(`AI analysis ${key} item requires source reference.`));
  }
  if (typeof item.confidence !== "number" || item.confidence < minimumConfidence || item.confidence > 1) {
    return err(new Error(`AI analysis ${key} item confidence must be between ${minimumConfidence} and 1.`));
  }
  if (key !== "warnings" && !isRecord(item.value)) {
    return err(new Error(`AI analysis ${key} item requires value.`));
  }
  if (key === "warnings" && !nonEmptyString(item.message)) {
    return err(new Error("AI analysis warning requires message."));
  }
  return ok(undefined);
}

function isValidSource(value: unknown): value is MemoryGraphSource {
  if (!isRecord(value)) {
    return false;
  }
  return nonEmptyString(value.platform)
    && nonEmptyString(value.conversationId)
    && nonEmptyString(value.messageId)
    && isValidDateLike(value.occurredAt);
}

function isValidDateLike(value: unknown): boolean {
  if (value instanceof Date) {
    return !Number.isNaN(value.getTime());
  }
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

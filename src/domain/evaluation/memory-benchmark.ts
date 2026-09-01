/** Question families required by the Phase 0 memory evidence gate. */
export const MEMORY_BENCHMARK_CATEGORIES = [
  "factual_recall",
  "persian",
  "temporal_correction",
  "contradiction",
  "multi_hop",
  "task_deadline",
  "preference",
  "long_range_coaching",
] as const;

export type MemoryBenchmarkCategory = typeof MEMORY_BENCHMARK_CATEGORIES[number];

/** A guarded message. Pre-guard text and media bytes are never benchmark inputs. */
export interface MemoryBenchmarkMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly occurredAt: string;
  readonly text: string;
  readonly language: "en" | "fa" | "mixed";
}

/** Private gold question. Reports keep its id and scores, never its text or answer key. */
export interface MemoryBenchmarkQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly categories: readonly MemoryBenchmarkCategory[];
  readonly expectedSourceIds: readonly string[];
  readonly expectedFacts: readonly string[];
  readonly forbiddenFacts?: readonly string[];
}

export interface MemoryBenchmarkSystemManifest {
  readonly id: string;
  readonly version: string;
  /** Secret-free, exact settings that affect memory behaviour. */
  readonly configuration: Readonly<Record<string, string | number | boolean>>;
  readonly modelIds: Readonly<Record<string, string>>;
  readonly networkDestinations: readonly string[];
  readonly backgroundJobs: readonly string[];
}

export interface MemoryBenchmarkThresholds {
  readonly minimumSourceValidRecall: number;
  readonly minimumAnswerAccuracy: number;
  readonly minimumPersianRecall: number;
  readonly minimumMultiHopRecall: number;
  readonly maximumStaleFactRate: number;
  readonly maximumDuplicateRate: number;
  readonly maximumP95RetrievalLatencyMs: number;
  readonly maximumContextTokens: number;
  readonly maximumQueueLagMs: number;
}

/** Frozen before either backend is run, so the success gates cannot move afterwards. */
export interface MemoryBenchmarkManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly frozenAt: string;
  readonly corpus: {
    readonly id: string;
    readonly kind: "private_quality" | "synthetic_scale";
    readonly messageCount: number;
    readonly occurredAtStart: string;
    readonly occurredAtEnd: string;
    readonly saltedSha256: string;
    readonly hashSalt: string;
  };
  readonly systems: readonly MemoryBenchmarkSystemManifest[];
  readonly answerModel: {
    readonly provider: string;
    readonly modelId: string;
    readonly version: string;
  };
  readonly contextTokenBudget: number;
  readonly qualityTieMargin: number;
  readonly maximumAcceptableMonthlyCostUsd: number;
  readonly thresholds: MemoryBenchmarkThresholds;
}

export interface MemoryBenchmarkEvidence {
  readonly sourceId: string;
  readonly text: string;
}

export interface MemoryBenchmarkUsage {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
}

/** Provider-neutral output for one question. */
export interface MemoryBenchmarkRecall {
  readonly questionId: string;
  readonly evidence: readonly MemoryBenchmarkEvidence[];
  readonly context: string;
  readonly contextTokens: number;
  readonly retrievalLatencyMs: number;
  readonly queueLagMs: number;
  readonly usage: MemoryBenchmarkUsage;
  readonly answer?: {
    readonly text: string;
    readonly sourceIds: readonly string[];
  };
}

export interface MemoryBenchmarkPreparation {
  readonly ingestedMessages: number;
  readonly durationMs: number;
  readonly databaseBytes: number;
  readonly indexBytes: number;
  readonly usage: MemoryBenchmarkUsage;
  /** Derived from measured representative batches and declared workload, never guessed. */
  readonly projectedMonthlyCostUsd?: number;
}

export interface MemoryBenchmarkQuestionScore {
  readonly questionId: string;
  readonly categories: readonly MemoryBenchmarkCategory[];
  readonly sourceValidRecall: number;
  readonly retrievedSourceValidity: number;
  readonly expectedFactRecall: number;
  readonly staleFactRate: number;
  readonly duplicateRate: number;
  readonly answerAccuracy: number | null;
  readonly contextTokens: number;
  readonly retrievalLatencyMs: number;
  readonly queueLagMs: number;
  readonly contextBudgetExceeded: boolean;
  readonly errorCode?: string;
}

export interface MemoryBenchmarkCategoryScore {
  readonly category: MemoryBenchmarkCategory;
  readonly questionCount: number;
  readonly sourceValidRecall: number;
  readonly expectedFactRecall: number;
  readonly answerAccuracy: number | null;
}

/** Safe to commit: it contains aggregate measurements and ids, but no corpus text. */
export interface MemoryBenchmarkReport {
  readonly schemaVersion: 1;
  readonly manifestId: string;
  readonly manifestSha256: string;
  readonly backendId: string;
  readonly backendVersion: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly preparation: MemoryBenchmarkPreparation;
  readonly questionCount: number;
  readonly failedQuestionCount: number;
  readonly sourceValidRecall: number;
  readonly retrievedSourceValidity: number;
  readonly expectedFactRecall: number;
  readonly answerAccuracy: number | null;
  readonly staleFactRate: number;
  readonly duplicateRate: number;
  readonly contextBudgetViolationCount: number;
  readonly contextTokens: PercentileSummary;
  readonly retrievalLatencyMs: PercentileSummary;
  readonly queueLagMs: PercentileSummary;
  readonly totalUsage: MemoryBenchmarkUsage;
  readonly projectedMonthlyCostUsd: number | null;
  readonly categoryScores: readonly MemoryBenchmarkCategoryScore[];
  readonly questionScores: readonly MemoryBenchmarkQuestionScore[];
  readonly gates: Readonly<Record<string, boolean>>;
}

export interface PercentileSummary {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export function isMemoryBenchmarkCategory(value: string): value is MemoryBenchmarkCategory {
  return MEMORY_BENCHMARK_CATEGORIES.some((category) => category === value);
}

export function validateMemoryBenchmarkManifest(manifest: MemoryBenchmarkManifest): readonly string[] {
  const issues: string[] = [];
  if (manifest.schemaVersion !== 1) issues.push("schemaVersion must be 1");
  requiredText(manifest.id, "id", issues);
  rejectPlaceholder(manifest.id, "id", issues);
  validIso(manifest.frozenAt, "frozenAt", issues);
  rejectPlaceholder(manifest.frozenAt, "frozenAt", issues);
  requiredText(manifest.corpus.id, "corpus.id", issues);
  rejectPlaceholder(manifest.corpus.id, "corpus.id", issues);
  positiveInteger(manifest.corpus.messageCount, "corpus.messageCount", issues);
  validIso(manifest.corpus.occurredAtStart, "corpus.occurredAtStart", issues);
  validIso(manifest.corpus.occurredAtEnd, "corpus.occurredAtEnd", issues);
  if (Date.parse(manifest.corpus.occurredAtStart) > Date.parse(manifest.corpus.occurredAtEnd)) {
    issues.push("corpus date range must be chronological");
  }
  if (!/^[a-f0-9]{64}$/i.test(manifest.corpus.saltedSha256)) {
    issues.push("corpus.saltedSha256 must be a SHA-256 hex digest");
  }
  if (manifest.corpus.hashSalt.length < 16) issues.push("corpus.hashSalt must be at least 16 characters");
  rejectPlaceholder(manifest.corpus.hashSalt, "corpus.hashSalt", issues);
  if (manifest.systems.length < 2) issues.push("systems must include both comparison backends");
  for (const [index, system] of manifest.systems.entries()) {
    requiredText(system.id, `systems[${index}].id`, issues);
    rejectPlaceholder(system.id, `systems[${index}].id`, issues);
    requiredText(system.version, `systems[${index}].version`, issues);
    rejectPlaceholder(system.version, `systems[${index}].version`, issues);
    if (system.networkDestinations.length === 0) {
      issues.push(`systems[${index}].networkDestinations must be explicit`);
    }
    for (const [key, value] of Object.entries(system.configuration)) {
      if (/secret|token|password|api.?key|connection/i.test(key)) {
        issues.push(`systems[${index}].configuration.${key} looks secret-bearing`);
      }
      if (typeof value === "string" && looksLikeSecret(value)) {
        issues.push(`systems[${index}].configuration.${key} looks like a secret value`);
      }
    }
    for (const [key, value] of Object.entries(system.modelIds)) {
      requiredText(value, `systems[${index}].modelIds.${key}`, issues);
      rejectPlaceholder(value, `systems[${index}].modelIds.${key}`, issues);
    }
    for (const [destinationIndex, destination] of system.networkDestinations.entries()) {
      requiredText(destination, `systems[${index}].networkDestinations[${destinationIndex}]`, issues);
      rejectPlaceholder(destination, `systems[${index}].networkDestinations[${destinationIndex}]`, issues);
    }
    for (const [jobIndex, job] of system.backgroundJobs.entries()) {
      requiredText(job, `systems[${index}].backgroundJobs[${jobIndex}]`, issues);
      rejectPlaceholder(job, `systems[${index}].backgroundJobs[${jobIndex}]`, issues);
    }
  }
  requiredText(manifest.answerModel.provider, "answerModel.provider", issues);
  requiredText(manifest.answerModel.modelId, "answerModel.modelId", issues);
  requiredText(manifest.answerModel.version, "answerModel.version", issues);
  rejectPlaceholder(manifest.answerModel.provider, "answerModel.provider", issues);
  rejectPlaceholder(manifest.answerModel.modelId, "answerModel.modelId", issues);
  rejectPlaceholder(manifest.answerModel.version, "answerModel.version", issues);
  positiveInteger(manifest.contextTokenBudget, "contextTokenBudget", issues);
  unitInterval(manifest.qualityTieMargin, "qualityTieMargin", issues);
  nonNegative(manifest.maximumAcceptableMonthlyCostUsd, "maximumAcceptableMonthlyCostUsd", issues);

  const thresholds = manifest.thresholds;
  unitInterval(thresholds.minimumSourceValidRecall, "thresholds.minimumSourceValidRecall", issues);
  unitInterval(thresholds.minimumAnswerAccuracy, "thresholds.minimumAnswerAccuracy", issues);
  unitInterval(thresholds.minimumPersianRecall, "thresholds.minimumPersianRecall", issues);
  unitInterval(thresholds.minimumMultiHopRecall, "thresholds.minimumMultiHopRecall", issues);
  unitInterval(thresholds.maximumStaleFactRate, "thresholds.maximumStaleFactRate", issues);
  unitInterval(thresholds.maximumDuplicateRate, "thresholds.maximumDuplicateRate", issues);
  positiveInteger(thresholds.maximumP95RetrievalLatencyMs, "thresholds.maximumP95RetrievalLatencyMs", issues);
  positiveInteger(thresholds.maximumContextTokens, "thresholds.maximumContextTokens", issues);
  positiveInteger(thresholds.maximumQueueLagMs, "thresholds.maximumQueueLagMs", issues);
  if (thresholds.maximumContextTokens !== manifest.contextTokenBudget) {
    issues.push("thresholds.maximumContextTokens must equal contextTokenBudget");
  }
  return issues;
}

export function validateMemoryBenchmarkCorpus(
  messages: readonly MemoryBenchmarkMessage[],
  expectedCount?: number,
): readonly string[] {
  const issues: string[] = [];
  if (expectedCount !== undefined && messages.length !== expectedCount) {
    issues.push(`corpus has ${messages.length} messages; manifest declares ${expectedCount}`);
  }
  const ids = new Set<string>();
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const [index, message] of messages.entries()) {
    requiredText(message.id, `messages[${index}].id`, issues);
    requiredText(message.conversationId, `messages[${index}].conversationId`, issues);
    requiredText(message.text, `messages[${index}].text`, issues);
    if (message.language !== "en" && message.language !== "fa" && message.language !== "mixed") {
      issues.push(`messages[${index}].language is invalid`);
    }
    const occurredAt = Date.parse(message.occurredAt);
    if (!Number.isFinite(occurredAt)) issues.push(`messages[${index}].occurredAt must be ISO-8601`);
    if (occurredAt < previousTime) issues.push(`messages[${index}] is out of chronological order`);
    previousTime = occurredAt;
    if (ids.has(message.id)) issues.push(`duplicate message id: ${message.id}`);
    ids.add(message.id);
  }
  return issues;
}

export function validateMemoryBenchmarkQuestions(
  questions: readonly MemoryBenchmarkQuestion[],
): readonly string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const [index, question] of questions.entries()) {
    requiredText(question.id, `questions[${index}].id`, issues);
    requiredText(question.prompt, `questions[${index}].prompt`, issues);
    if (question.categories.length === 0) issues.push(`questions[${index}].categories cannot be empty`);
    if (question.expectedSourceIds.length === 0) issues.push(`questions[${index}].expectedSourceIds cannot be empty`);
    if (question.expectedFacts.length === 0) issues.push(`questions[${index}].expectedFacts cannot be empty`);
    for (const category of question.categories) {
      if (!isMemoryBenchmarkCategory(category)) issues.push(`questions[${index}] has invalid category: ${category}`);
    }
    for (const [sourceIndex, sourceId] of question.expectedSourceIds.entries()) {
      requiredText(sourceId, `questions[${index}].expectedSourceIds[${sourceIndex}]`, issues);
    }
    for (const [factIndex, fact] of question.expectedFacts.entries()) {
      requiredText(fact, `questions[${index}].expectedFacts[${factIndex}]`, issues);
    }
    if (ids.has(question.id)) issues.push(`duplicate question id: ${question.id}`);
    ids.add(question.id);
  }
  return issues;
}

function requiredText(value: string, path: string, issues: string[]): void {
  if (value.trim().length === 0) issues.push(`${path} cannot be empty`);
}

function validIso(value: string, path: string, issues: string[]): void {
  if (!Number.isFinite(Date.parse(value))) issues.push(`${path} must be ISO-8601`);
}

function positiveInteger(value: number, path: string, issues: string[]): void {
  if (!Number.isInteger(value) || value <= 0) issues.push(`${path} must be a positive integer`);
}

function nonNegative(value: number, path: string, issues: string[]): void {
  if (!Number.isFinite(value) || value < 0) issues.push(`${path} must be non-negative`);
}

function unitInterval(value: number, path: string, issues: string[]): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) issues.push(`${path} must be between 0 and 1`);
}

function looksLikeSecret(value: string): boolean {
  return /(?:sk|ghp|xox[baprs]|AIza)[-_A-Za-z0-9]{16,}/.test(value)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value);
}

function rejectPlaceholder(value: string, path: string, issues: string[]): void {
  if (/TODO|TBD|REPLACE|PIN_BEFORE_RUN/i.test(value)) issues.push(`${path} is still a placeholder`);
}

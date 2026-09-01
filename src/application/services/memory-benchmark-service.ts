import type { MemoryBenchmarkBackendPort } from "../ports/memory-benchmark-backend.js";
import type { SecretDetectorPort } from "../ports/secret-detector.js";
import {
  MEMORY_BENCHMARK_CATEGORIES,
  type MemoryBenchmarkCategory,
  type MemoryBenchmarkCategoryScore,
  type MemoryBenchmarkManifest,
  type MemoryBenchmarkMessage,
  type MemoryBenchmarkQuestion,
  type MemoryBenchmarkQuestionScore,
  type MemoryBenchmarkRecall,
  type MemoryBenchmarkReport,
  type MemoryBenchmarkUsage,
  type PercentileSummary,
  validateMemoryBenchmarkCorpus,
  validateMemoryBenchmarkManifest,
  validateMemoryBenchmarkQuestions,
} from "../../domain/evaluation/memory-benchmark.js";

export interface MemoryBenchmarkRunInput {
  readonly manifest: MemoryBenchmarkManifest;
  readonly manifestSha256: string;
  readonly messages: readonly MemoryBenchmarkMessage[];
  readonly questions: readonly MemoryBenchmarkQuestion[];
  readonly backend: MemoryBenchmarkBackendPort;
  readonly now?: () => Date;
}

/** Runs one backend and emits a report that contains no message, prompt, fact, or answer text. */
export class MemoryBenchmarkService {
  public constructor(private readonly patternSecretDetector: SecretDetectorPort) {}

  public async run(input: MemoryBenchmarkRunInput): Promise<MemoryBenchmarkReport> {
    const issues = [
      ...validateMemoryBenchmarkManifest(input.manifest),
      ...validateMemoryBenchmarkCorpus(input.messages, input.manifest.corpus.messageCount),
      ...validateMemoryBenchmarkQuestions(input.questions),
    ];
    const system = input.manifest.systems.find((candidate) => candidate.id === input.backend.id);
    if (system === undefined) issues.push(`backend ${input.backend.id} is absent from the frozen manifest`);
    if (system !== undefined && system.version !== input.backend.version) {
      issues.push(`backend ${input.backend.id} version does not match the frozen manifest`);
    }
    if (issues.length > 0) {
      throw new Error(`Invalid memory benchmark:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    }

    // The corpus must already be post-guard. Rechecking local patterns here prevents an
    // accidental raw export from crossing either backend boundary and reveals only ids.
    const guardedInputs = [
      ...input.messages.map((message) => ({ id: `message:${message.id}`, text: message.text })),
      ...input.questions.map((question) => ({ id: `question:${question.id}`, text: question.prompt })),
    ];
    const redacted = await this.patternSecretDetector.redactMany(guardedInputs.map((item) => item.text));
    const unsafeInputIds = redacted.flatMap((result, index) =>
      result.findings.length === 0 ? [] : [guardedInputs[index]?.id ?? `index:${index}`]
    );
    if (unsafeInputIds.length > 0) {
      throw new Error(`Benchmark inputs failed the local secret gate at ids: ${unsafeInputIds.join(", ")}`);
    }

    const now = input.now ?? (() => new Date());
    const startedAt = now().toISOString();
    const preparation = await input.backend.prepare(input.messages, input.manifest);
    const recalls: MemoryBenchmarkRecall[] = [];
    const failures = new Map<string, string>();

    for (const question of input.questions) {
      try {
        const recall = await input.backend.recall(question, input.manifest.contextTokenBudget);
        if (recall.questionId !== question.id) {
          failures.set(question.id, "question_id_mismatch");
        } else {
          recalls.push(recall);
        }
      } catch (error) {
        failures.set(question.id, classifyFailure(error));
      }
    }

    return createMemoryBenchmarkReport({
      manifest: input.manifest,
      manifestSha256: input.manifestSha256,
      backendId: input.backend.id,
      backendVersion: input.backend.version,
      startedAt,
      completedAt: now().toISOString(),
      preparation,
      questions: input.questions,
      recalls,
      failures,
      validSourceIds: new Set(input.messages.map((message) => message.id)),
    });
  }
}

interface CreateReportInput {
  readonly manifest: MemoryBenchmarkManifest;
  readonly manifestSha256: string;
  readonly backendId: string;
  readonly backendVersion: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly preparation: MemoryBenchmarkReport["preparation"];
  readonly questions: readonly MemoryBenchmarkQuestion[];
  readonly recalls: readonly MemoryBenchmarkRecall[];
  readonly failures?: ReadonlyMap<string, string>;
  readonly validSourceIds: ReadonlySet<string>;
}

/** Scores already-captured backend output. Useful when live systems run in separate processes. */
export function createMemoryBenchmarkReport(input: CreateReportInput): MemoryBenchmarkReport {
  const recallByQuestion = new Map(input.recalls.map((recall) => [recall.questionId, recall]));
  const questionScores = input.questions.map((question) => {
    const recall = recallByQuestion.get(question.id);
    const failure = input.failures?.get(question.id);
    return recall === undefined
      ? failedScore(question, failure ?? "missing_result")
      : scoreQuestion(question, recall, input.manifest.contextTokenBudget, input.validSourceIds);
  });
  const successfulScores = questionScores.filter((score) => score.errorCode === undefined);
  const answerScores = successfulScores
    .map((score) => score.answerAccuracy)
    .filter((score): score is number => score !== null);
  const totalUsage = input.recalls.reduce(
    (total, recall) => addUsage(total, recall.usage),
    input.preparation.usage,
  );
  const thresholds = input.manifest.thresholds;
  const sourceValidRecall = mean(successfulScores.map((score) => score.sourceValidRecall));
  const staleFactRate = mean(successfulScores.map((score) => score.staleFactRate));
  const duplicateRate = mean(successfulScores.map((score) => score.duplicateRate));
  const p95Latency = percentile(successfulScores.map((score) => score.retrievalLatencyMs)).p95;
  const maxQueueLag = percentile(successfulScores.map((score) => score.queueLagMs)).max;
  const answerAccuracy = answerScores.length === 0 ? null : mean(answerScores);
  const categoryScores = MEMORY_BENCHMARK_CATEGORIES
    .map((category) => scoreCategory(category, questionScores))
    .filter((score) => score.questionCount > 0);
  const persianRecall = categoryScores.find((score) => score.category === "persian")?.sourceValidRecall ?? 0;
  const multiHopRecall = categoryScores.find((score) => score.category === "multi_hop")?.sourceValidRecall ?? 0;

  return {
    schemaVersion: 1,
    manifestId: input.manifest.id,
    manifestSha256: input.manifestSha256,
    backendId: input.backendId,
    backendVersion: input.backendVersion,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    preparation: input.preparation,
    questionCount: questionScores.length,
    failedQuestionCount: questionScores.length - successfulScores.length,
    sourceValidRecall,
    retrievedSourceValidity: mean(successfulScores.map((score) => score.retrievedSourceValidity)),
    expectedFactRecall: mean(successfulScores.map((score) => score.expectedFactRecall)),
    answerAccuracy,
    staleFactRate,
    duplicateRate,
    contextBudgetViolationCount: successfulScores.filter((score) => score.contextBudgetExceeded).length,
    contextTokens: percentile(successfulScores.map((score) => score.contextTokens)),
    retrievalLatencyMs: percentile(successfulScores.map((score) => score.retrievalLatencyMs)),
    queueLagMs: percentile(successfulScores.map((score) => score.queueLagMs)),
    totalUsage,
    projectedMonthlyCostUsd: input.preparation.projectedMonthlyCostUsd ?? null,
    categoryScores,
    questionScores,
    gates: {
      allQuestionsCompleted: successfulScores.length === questionScores.length,
      sourceValidRecall: sourceValidRecall >= thresholds.minimumSourceValidRecall,
      answerAccuracy: answerAccuracy !== null && answerAccuracy >= thresholds.minimumAnswerAccuracy,
      persianRecall: persianRecall >= thresholds.minimumPersianRecall,
      multiHopRecall: multiHopRecall >= thresholds.minimumMultiHopRecall,
      staleFactRate: staleFactRate <= thresholds.maximumStaleFactRate,
      duplicateRate: duplicateRate <= thresholds.maximumDuplicateRate,
      retrievalLatency: p95Latency <= thresholds.maximumP95RetrievalLatencyMs,
      contextBudget: questionScores.every((score) => !score.contextBudgetExceeded),
      queueLag: maxQueueLag <= thresholds.maximumQueueLagMs,
      monthlyCost: input.preparation.projectedMonthlyCostUsd !== undefined
        && input.preparation.projectedMonthlyCostUsd <= input.manifest.maximumAcceptableMonthlyCostUsd,
    },
  };
}

function scoreQuestion(
  question: MemoryBenchmarkQuestion,
  recall: MemoryBenchmarkRecall,
  tokenBudget: number,
  validSourceIds: ReadonlySet<string>,
): MemoryBenchmarkQuestionScore {
  const retrievedIds = recall.evidence.map((item) => item.sourceId);
  const expectedIds = new Set(question.expectedSourceIds);
  const evidenceText = recall.evidence.map((item) => item.text).join("\n");
  const uniqueRetrievedIds = new Set(retrievedIds);
  const answerAccuracy = recall.answer === undefined
    ? null
    : phraseRecall(question.expectedFacts, recall.answer.text);

  return {
    questionId: question.id,
    categories: question.categories,
    sourceValidRecall: ratio([...uniqueRetrievedIds].filter((id) => expectedIds.has(id)).length, expectedIds.size),
    retrievedSourceValidity: ratio(retrievedIds.filter((id) => validSourceIds.has(id)).length, retrievedIds.length),
    expectedFactRecall: phraseRecall(question.expectedFacts, evidenceText),
    staleFactRate: phraseRecall(question.forbiddenFacts ?? [], `${evidenceText}\n${recall.answer?.text ?? ""}`),
    duplicateRate: ratio(retrievedIds.length - uniqueRetrievedIds.size, retrievedIds.length),
    answerAccuracy,
    contextTokens: recall.contextTokens,
    retrievalLatencyMs: recall.retrievalLatencyMs,
    queueLagMs: recall.queueLagMs,
    contextBudgetExceeded: recall.contextTokens > tokenBudget,
  };
}

function failedScore(question: MemoryBenchmarkQuestion, errorCode: string): MemoryBenchmarkQuestionScore {
  return {
    questionId: question.id,
    categories: question.categories,
    sourceValidRecall: 0,
    retrievedSourceValidity: 0,
    expectedFactRecall: 0,
    staleFactRate: 0,
    duplicateRate: 0,
    answerAccuracy: null,
    contextTokens: 0,
    retrievalLatencyMs: 0,
    queueLagMs: 0,
    contextBudgetExceeded: false,
    errorCode,
  };
}

function scoreCategory(
  category: MemoryBenchmarkCategory,
  scores: readonly MemoryBenchmarkQuestionScore[],
): MemoryBenchmarkCategoryScore {
  const selected = scores.filter((score) => score.errorCode === undefined && score.categories.includes(category));
  const answerScores = selected
    .map((score) => score.answerAccuracy)
    .filter((score): score is number => score !== null);
  return {
    category,
    questionCount: selected.length,
    sourceValidRecall: mean(selected.map((score) => score.sourceValidRecall)),
    expectedFactRecall: mean(selected.map((score) => score.expectedFactRecall)),
    answerAccuracy: answerScores.length === 0 ? null : mean(answerScores),
  };
}

function phraseRecall(phrases: readonly string[], text: string): number {
  if (phrases.length === 0) return 0;
  const normalizedText = normalizeForEvaluation(text);
  return ratio(
    phrases.filter((phrase) => normalizedText.includes(normalizeForEvaluation(phrase))).length,
    phrases.length,
  );
}

/** Minimal bilingual normalisation for stable grading; production retrieval remains unchanged. */
function normalizeForEvaluation(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/\u200c/g, " ")
    .toLocaleLowerCase("en")
    .replace(/\s+/g, " ")
    .trim();
}

function percentile(values: readonly number[]): PercentileSummary {
  if (values.length === 0) return { p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function nearestRank(sorted: readonly number[], quantile: number): number {
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function addUsage(left: MemoryBenchmarkUsage, right: MemoryBenchmarkUsage): MemoryBenchmarkUsage {
  return {
    calls: left.calls + right.calls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    estimatedCostUsd: left.estimatedCostUsd + right.estimatedCostUsd,
  };
}

function classifyFailure(error: unknown): string {
  if (error instanceof Error && error.name.trim().length > 0) {
    return error.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  }
  return "backend_error";
}

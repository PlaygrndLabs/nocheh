import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TextCompletionPort } from "../../application/ports/text-completion.js";
import { createMemoryBenchmarkReport } from "../../application/services/memory-benchmark-service.js";
import { MemoryBenchmarkService } from "../../application/services/memory-benchmark-service.js";
import { AssistantContextBuilder } from "../../application/services/assistant-context-builder.js";
import { ProcessIncomingMessageUseCase } from "../../application/use-cases/process-incoming-message.js";
import { SystemClock } from "../../application/ports/clock.js";
import { SystemIdGenerator } from "../../application/ports/id-generator.js";
import {
  aiProviderRoleSupport,
  findAiModelRole,
  findAiProvider,
} from "../../application/config/ai-provider-catalog.js";
import type {
  MemoryBenchmarkManifest,
  MemoryBenchmarkMessage,
  MemoryBenchmarkPreparation,
  MemoryBenchmarkQuestion,
  MemoryBenchmarkRecall,
} from "../../domain/evaluation/memory-benchmark.js";
import {
  validateMemoryBenchmarkCorpus,
  validateMemoryBenchmarkManifest,
  validateMemoryBenchmarkQuestions,
} from "../../domain/evaluation/memory-benchmark.js";
import {
  createSyntheticMemoryBenchmarkFixture,
  memoryBenchmarkManifestSha256,
  saltedMemoryBenchmarkCorpusSha256,
} from "../../infrastructure/evaluation/memory-benchmark-fixture.js";
import { RegexSecretDetector } from "../../infrastructure/security/regex-secret-detector.js";
import { LlmSecretDetector } from "../../infrastructure/security/llm-secret-detector.js";
import { DEFAULT_REDACTION_POLICY } from "../../domain/security/redaction-policy.js";
import { ConsoleLogger } from "../../infrastructure/logger/console-logger.js";
import { DotenvFileStore } from "../../infrastructure/config/dotenv-file-store.js";
import { OpenAiCompatibleTextCompletion } from "../../infrastructure/reasoning/openai-compatible-text-completion.js";
import { GeminiTextCompletion } from "../../infrastructure/reasoning/gemini-text-completion.js";
import { AnthropicTextCompletion } from "../../infrastructure/reasoning/anthropic-text-completion.js";
import { prepareTelegramMemoryBenchmarkCorpus } from "../../infrastructure/evaluation/telegram-memory-benchmark-preparer.js";
import {
  HonchoMemoryBenchmarkBackend,
  SdkHonchoBenchmarkClient,
} from "../../infrastructure/evaluation/honcho-memory-benchmark-backend.js";
import { NochehMemoryBenchmarkBackend } from "../../infrastructure/evaluation/nocheh-memory-benchmark-backend.js";
import { GuardedSecretDetector } from "../../infrastructure/security/guarded-secret-detector.js";
import { AesGcmEncryption } from "../../infrastructure/security/aes-gcm-encryption.js";
import { openSqliteDatabase } from "../../infrastructure/sqlite/sqlite-database.js";
import { SqliteAuditRepository } from "../../infrastructure/sqlite/sqlite-audit-repository.js";
import { SqliteMemoryGraphRepository } from "../../infrastructure/sqlite/sqlite-memory-graph-repository.js";
import { SqliteMemoryRecordRepository } from "../../infrastructure/sqlite/sqlite-memory-record-repository.js";
import { SqliteMemoryEmbeddingRepository } from "../../infrastructure/sqlite/sqlite-memory-embedding-repository.js";
import { SqliteSuggestionRepository } from "../../infrastructure/sqlite/sqlite-suggestion-repository.js";
import { SqliteTaskRepository } from "../../infrastructure/sqlite/sqlite-task-repository.js";
import { SqliteTaskSyncRepository } from "../../infrastructure/sqlite/sqlite-task-sync-repository.js";
import { HybridMemoryRetrievalService } from "../../infrastructure/memory/hybrid-memory-retrieval-service.js";
import { InMemoryMetricsCollector } from "../../infrastructure/observability/in-memory-metrics-collector.js";
import { NvidiaMemoryGraphAnalyzer } from "../../infrastructure/reasoning/nvidia-memory-graph-analyzer.js";

interface CapturedBenchmarkRun {
  readonly backendId: string;
  readonly backendVersion: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly preparation: MemoryBenchmarkPreparation;
  readonly recalls: readonly MemoryBenchmarkRecall[];
}

interface GuardCompletionRuntime {
  readonly completion: TextCompletionPort;
  readonly providerId: string;
  readonly modelId: string;
}

export async function runMemoryBenchmarkCli(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case "generate-scale":
      await generateScale(rest);
      return;
    case "validate":
      await validatePack(rest);
      return;
    case "score":
      await scoreCapturedRun(rest);
      return;
    case "run-honcho":
      await runHoncho(rest);
      return;
    case "run-nocheh":
      await runNocheh(rest);
      return;
    case "prepare-telegram":
      await prepareTelegram(rest);
      return;
    case "probe-guard":
      await probeGuard(rest);
      return;
    default:
      throw new Error([
        "Usage:",
        "  memory-benchmark prepare-telegram <telegram-result.json> <output-directory> [guard-model-id]",
        "  memory-benchmark probe-guard <guard-model-id>",
        "  memory-benchmark generate-scale <1000|10000|100000> [output-directory]",
        "  memory-benchmark validate <manifest.json> <corpus.jsonl> <questions.json>",
        "  memory-benchmark score <manifest.json> <corpus.jsonl> <questions.json> <captured-run.json> <report.json>",
        "  memory-benchmark run-nocheh <manifest.json> <corpus.jsonl> <questions.json> <report.json> [system-id]",
        "  memory-benchmark run-honcho <manifest.json> <corpus.jsonl> <questions.json> <report.json> [system-id]",
      ].join("\n"));
  }
}

async function prepareTelegram(args: readonly string[]): Promise<void> {
  if (args.length !== 2 && args.length !== 3) {
    throw new Error(`Expected 2 paths and an optional guard model id, received ${args.length} arguments`);
  }
  const exportPath = requiredPath(args, 0);
  const outputDirectory = requiredPath(args, 1);
  const guardModelOverride = args[2];
  const rawExport = parseJson<unknown>(await readFile(exportPath, "utf8"), exportPath);
  const fileEnv = await new DotenvFileStore(resolve(".env")).read();
  const logger = new ConsoleLogger();
  const guardRuntime = createRequiredGuardCompletion(fileEnv, guardModelOverride);
  const guard = new LlmSecretDetector(
    guardRuntime.completion,
    { currentRedactionPolicy: () => DEFAULT_REDACTION_POLICY },
    logger,
    {
      maxInputCharacters: positiveEnvNumber(fileEnv, "SECRET_GUARD_MAX_INPUT_CHARACTERS", 24_000),
      maxOutputTokens: positiveEnvNumber(fileEnv, "SECRET_GUARD_MAX_OUTPUT_TOKENS", 4000),
    },
  );
  await assertSecretGuardCanary(guard);
  const preparation = await prepareTelegramMemoryBenchmarkCorpus(
    rawExport,
    new RegexSecretDetector(),
    guard,
  );
  const first = preparation.messages[0];
  const last = preparation.messages[preparation.messages.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("Telegram export contains no text-bearing messages");
  }

  await mkdir(outputDirectory, { recursive: true });
  const corpusPath = join(outputDirectory, "corpus.jsonl");
  const metadataPath = join(outputDirectory, "preparation.json");
  await writeFile(corpusPath, `${preparation.messages.map((message) => JSON.stringify(message)).join("\n")}\n`, "utf8");
  await writeFile(metadataPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: "telegram_private_pilot",
    messageCount: preparation.messages.length,
    occurredAtStart: first.occurredAt,
    occurredAtEnd: last.occurredAt,
    patternFindingCount: preparation.patternFindingCount,
    guardFindingCount: preparation.guardFindingCount,
    guardProviderId: guardRuntime.providerId,
    guardModelId: guardRuntime.modelId,
    mediaBytesRead: 0,
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ corpusPath, metadataPath, messageCount: preparation.messages.length }, null, 2)}\n`);
}

async function assertSecretGuardCanary(guard: LlmSecretDetector): Promise<void> {
  const password = "bluebird77";
  const seedPhrase = "apple bridge candle drift eagle forest garden harbor island jungle kitten lemon";
  const clean = "The project name is Nocheh and the deadline is Friday.";
  const results = await guard.redactMany([
    `رمز وای‌فای ${password} است`,
    `My recovery words are ${seedPhrase}`,
    clean,
  ]);
  if (results.length !== 3) throw new Error("Secret guard canary returned the wrong result count");
  if (results[0]?.text.includes(password) !== false || results[0].findings.length === 0) {
    throw new Error("Secret guard canary missed a prose password; refusing private corpus preparation");
  }
  if (results[1]?.text.includes(seedPhrase) !== false || results[1].findings.length === 0) {
    throw new Error("Secret guard canary missed a recovery phrase; refusing private corpus preparation");
  }
  if (results[2]?.text !== clean || results[2].findings.length !== 0) {
    throw new Error("Secret guard canary altered clean text; refusing private corpus preparation");
  }
}

async function probeGuard(args: readonly string[]): Promise<void> {
  if (args.length !== 1) throw new Error("Expected one guard model id");
  const model = args[0];
  if (model === undefined || model.trim().length === 0) throw new Error("Guard model id cannot be empty");
  const fileEnv = await new DotenvFileStore(resolve(".env")).read();
  const guardRuntime = createRequiredGuardCompletion(fileEnv, model);
  const guard = new LlmSecretDetector(
    guardRuntime.completion,
    { currentRedactionPolicy: () => DEFAULT_REDACTION_POLICY },
    new ConsoleLogger(),
    { maxInputCharacters: 24_000, maxOutputTokens: 4000 },
  );
  const probes = [
    { id: "english_password", text: "The wifi password is bluebird77", literal: "bluebird77", kind: "password" },
    { id: "persian_password", text: "رمز وای‌فای من آبی‌پرنده۷۷ است", literal: "آبی‌پرنده۷۷", kind: "password" },
    { id: "seed_phrase", text: "My recovery words are apple bridge candle dream eagle forest garden harbor island jungle kitten lemon", literal: "apple bridge candle dream eagle forest garden harbor island jungle kitten lemon", kind: "seed_phrase" },
    { id: "clean_prose", text: "The project deadline is Friday and the budget is twenty dollars", literal: "", kind: "" },
  ] as const;
  const results = await guard.redactMany(probes.map((probe) => probe.text));
  assertProbeResultCount(results.length, probes.length);
  const failures = probes.flatMap((probe, index) => {
    const result = results[index];
    if (result === undefined) return [probe.id];
    if (probe.literal.length === 0) return result.findings.length === 0 ? [] : [probe.id];
    const expectedPlaceholder = `[REDACTED:${probe.kind}]`;
    return !result.text.includes(probe.literal) && result.text.includes(expectedPlaceholder) ? [] : [probe.id];
  });
  process.stdout.write(`${JSON.stringify({ model, passed: failures.length === 0, failedProbeIds: failures }, null, 2)}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

function assertProbeResultCount(actual: number, expected: number): void {
  if (actual !== expected) throw new Error(`Guard returned ${actual} probe results for ${expected} inputs`);
}

function createRequiredGuardCompletion(
  fileEnv: Readonly<Record<string, string>>,
  modelOverride?: string,
): GuardCompletionRuntime {
  const role = findAiModelRole("secret_guard");
  if (role === undefined) throw new Error("Secret guard role is missing from the provider catalog");
  const providerId = environmentValue(fileEnv, role.providerEnvKey);
  const provider = findAiProvider(providerId);
  if (provider === undefined) {
    throw new Error("AI_GUARD_PROVIDER must select a configured provider before preparing private data");
  }
  const support = aiProviderRoleSupport(provider, role.id);
  if (support === undefined) throw new Error(`Provider ${provider.id} cannot fill the secret guard role`);
  const apiKey = environmentValue(fileEnv, provider.apiKeyEnvKey);
  const model = modelOverride?.trim() || (environmentValue(fileEnv, support.modelEnvKey) ?? support.defaultModel);
  if (apiKey === undefined || model === undefined) {
    throw new Error(`Secret guard ${provider.id} requires ${provider.apiKeyEnvKey} and ${support.modelEnvKey}`);
  }
  const maxTokens = positiveEnvNumber(fileEnv, "SECRET_GUARD_MAX_OUTPUT_TOKENS", 4000);
  const timeoutMs = positiveEnvNumber(fileEnv, "SECRET_GUARD_TIMEOUT_MS", 300_000);

  switch (provider.id) {
    case "nvidia": {
      const baseUrl = environmentValue(fileEnv, "NVIDIA_BASE_URL");
      return {
        providerId: provider.id,
        modelId: model,
        completion: new OpenAiCompatibleTextCompletion({
          provider: provider.id,
          apiKey,
          model,
          maxTokens,
          timeoutMs,
          ...(baseUrl === undefined ? {} : { baseUrl }),
        }),
      };
    }
    case "gemini": {
      const baseUrl = environmentValue(fileEnv, "GEMINI_BASE_URL");
      return {
        providerId: provider.id,
        modelId: model,
        completion: new GeminiTextCompletion({
          apiKey,
          model,
          maxTokens,
          timeoutMs,
          ...(baseUrl === undefined ? {} : { baseUrl }),
        }),
      };
    }
    case "anthropic":
      return {
        providerId: provider.id,
        modelId: model,
        completion: new AnthropicTextCompletion({ apiKey, model, maxTokens, timeoutMs }),
      };
    default:
      throw new Error(`Provider ${provider.id} has no secret guard adapter`);
  }
}

function environmentValue(fileEnv: Readonly<Record<string, string>>, name: string): string | undefined {
  const value = process.env[name]?.trim() || fileEnv[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function positiveEnvNumber(
  fileEnv: Readonly<Record<string, string>>,
  name: string,
  fallback: number,
): number {
  const value = Number(environmentValue(fileEnv, name));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function generateScale(args: readonly string[]): Promise<void> {
  const messageCount = Number(args[0]);
  const outputDirectory = resolve(args[1] ?? `data/memory-benchmark/synthetic-${messageCount}`);
  const fixture = createSyntheticMemoryBenchmarkFixture(messageCount);
  const corpusPath = join(outputDirectory, "corpus.jsonl");
  const questionsPath = join(outputDirectory, "questions.json");
  const metadataPath = join(outputDirectory, "fixture.json");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(corpusPath, `${fixture.messages.map((message) => JSON.stringify(message)).join("\n")}\n`, "utf8");
  await writeFile(questionsPath, `${JSON.stringify(fixture.questions, null, 2)}\n`, "utf8");
  await writeFile(metadataPath, `${JSON.stringify({
    seed: fixture.seed,
    messageCount: fixture.messages.length,
    questionCount: fixture.questions.length,
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`${outputDirectory}\n`);
}

async function validatePack(args: readonly string[]): Promise<void> {
  requirePathCount(args, 3);
  const manifestPath = requiredPath(args, 0);
  const corpusPath = requiredPath(args, 1);
  const questionsPath = requiredPath(args, 2);
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = parseJson<MemoryBenchmarkManifest>(manifestText, manifestPath);
  const messages = await readJsonLines<MemoryBenchmarkMessage>(corpusPath);
  const questions = parseJson<readonly MemoryBenchmarkQuestion[]>(await readFile(questionsPath, "utf8"), questionsPath);
  const issues = [
    ...validateMemoryBenchmarkManifest(manifest),
    ...validateMemoryBenchmarkCorpus(messages, manifest.corpus.messageCount),
    ...validateMemoryBenchmarkQuestions(questions),
  ];
  const unsafeMessageIds = findPatternSecretMessageIds(messages);
  if (unsafeMessageIds.length > 0) {
    issues.push(`local secret gate found sensitive patterns in message ids: ${unsafeMessageIds.join(", ")}`);
  }
  const unsafeQuestionIds = findPatternSecretQuestionIds(questions);
  if (unsafeQuestionIds.length > 0) {
    issues.push(`local secret gate found sensitive patterns in question ids: ${unsafeQuestionIds.join(", ")}`);
  }
  const actualCorpusHash = saltedMemoryBenchmarkCorpusSha256(messages, manifest.corpus.hashSalt);
  if (actualCorpusHash !== manifest.corpus.saltedSha256) issues.push("corpus hash does not match frozen manifest");
  if (messages[0]?.occurredAt !== manifest.corpus.occurredAtStart) issues.push("corpus start does not match manifest");
  if (messages[messages.length - 1]?.occurredAt !== manifest.corpus.occurredAtEnd) issues.push("corpus end does not match manifest");
  if (issues.length > 0) throw new Error(`Invalid benchmark pack:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  process.stdout.write(`${JSON.stringify({
    manifestSha256: memoryBenchmarkManifestSha256(manifestText),
    corpusSaltedSha256: actualCorpusHash,
    messageCount: messages.length,
    questionCount: questions.length,
  }, null, 2)}\n`);
}

async function scoreCapturedRun(args: readonly string[]): Promise<void> {
  requirePathCount(args, 5);
  const manifestPath = requiredPath(args, 0);
  const corpusPath = requiredPath(args, 1);
  const questionsPath = requiredPath(args, 2);
  const capturedRunPath = requiredPath(args, 3);
  const reportPath = requiredPath(args, 4);
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = parseJson<MemoryBenchmarkManifest>(manifestText, manifestPath);
  const messages = await readJsonLines<MemoryBenchmarkMessage>(corpusPath);
  const questions = parseJson<readonly MemoryBenchmarkQuestion[]>(await readFile(questionsPath, "utf8"), questionsPath);
  const captured = parseJson<CapturedBenchmarkRun>(await readFile(capturedRunPath, "utf8"), capturedRunPath);
  const issues = [
    ...validateMemoryBenchmarkManifest(manifest),
    ...validateMemoryBenchmarkCorpus(messages, manifest.corpus.messageCount),
    ...validateMemoryBenchmarkQuestions(questions),
  ];
  if (issues.length > 0) throw new Error(`Invalid benchmark inputs:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  const report = createMemoryBenchmarkReport({
    manifest,
    manifestSha256: memoryBenchmarkManifestSha256(manifestText),
    backendId: captured.backendId,
    backendVersion: captured.backendVersion,
    startedAt: captured.startedAt,
    completedAt: captured.completedAt,
    preparation: captured.preparation,
    questions,
    recalls: captured.recalls,
    validSourceIds: new Set(messages.map((message) => message.id)),
  });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${reportPath}\n`);
}

async function runHoncho(args: readonly string[]): Promise<void> {
  if (args.length !== 4 && args.length !== 5) {
    throw new Error(`Expected 4 paths and an optional system id, received ${args.length} arguments`);
  }
  const manifestPath = requiredPath(args, 0);
  const corpusPath = requiredPath(args, 1);
  const questionsPath = requiredPath(args, 2);
  const reportPath = requiredPath(args, 3);
  const requestedSystemId = args[4] ?? "honcho-self-hosted";
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = parseJson<MemoryBenchmarkManifest>(manifestText, manifestPath);
  const messages = await readJsonLines<MemoryBenchmarkMessage>(corpusPath);
  const questions = parseJson<readonly MemoryBenchmarkQuestion[]>(await readFile(questionsPath, "utf8"), questionsPath);
  assertValidPack(manifest, messages, questions);
  const actualCorpusHash = saltedMemoryBenchmarkCorpusSha256(messages, manifest.corpus.hashSalt);
  if (actualCorpusHash !== manifest.corpus.saltedSha256) {
    throw new Error("Corpus hash does not match the frozen manifest; refusing to run Honcho");
  }
  const system = manifest.systems.find((candidate) => candidate.id === requestedSystemId);
  if (system === undefined) throw new Error(`System ${requestedSystemId} is absent from the frozen manifest`);
  const baseUrl = stringConfiguration(system.configuration, "baseUrl");
  const workspaceId = stringConfiguration(system.configuration, "workspaceId");
  const client = new SdkHonchoBenchmarkClient({
    baseUrl,
    workspaceId,
    ...(process.env.HONCHO_API_KEY === undefined ? {} : { apiKey: process.env.HONCHO_API_KEY }),
    allowRemoteHost: process.env.HONCHO_BENCHMARK_ALLOW_REMOTE === "true",
  });
  const backend = new HonchoMemoryBenchmarkBackend(client, {
    id: system.id,
    version: system.version,
    ingestBatchSize: numberConfiguration(system.configuration, "ingestBatchSize", 100),
    searchLimit: numberConfiguration(system.configuration, "searchLimit", 20),
    queueTimeoutMs: numberConfiguration(system.configuration, "queueTimeoutMs", 600_000),
  });
  const report = await new MemoryBenchmarkService(new RegexSecretDetector()).run({
    manifest,
    manifestSha256: memoryBenchmarkManifestSha256(manifestText),
    corpusSaltedSha256: actualCorpusHash,
    messages,
    questions,
    backend,
  });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${reportPath}\n`);
}

/** Runs the live Nocheh pipeline in an encrypted in-memory database with all external effects disabled. */
async function runNocheh(args: readonly string[]): Promise<void> {
  if (args.length !== 4 && args.length !== 5) {
    throw new Error(`Expected 4 paths and an optional system id, received ${args.length} arguments`);
  }
  const manifestPath = requiredPath(args, 0);
  const corpusPath = requiredPath(args, 1);
  const questionsPath = requiredPath(args, 2);
  const reportPath = requiredPath(args, 3);
  const requestedSystemId = args[4] ?? "nocheh-current";
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = parseJson<MemoryBenchmarkManifest>(manifestText, manifestPath);
  const messages = await readJsonLines<MemoryBenchmarkMessage>(corpusPath);
  const questions = parseJson<readonly MemoryBenchmarkQuestion[]>(await readFile(questionsPath, "utf8"), questionsPath);
  assertValidPack(manifest, messages, questions);
  const corpusSaltedSha256 = saltedMemoryBenchmarkCorpusSha256(messages, manifest.corpus.hashSalt);
  if (corpusSaltedSha256 !== manifest.corpus.saltedSha256) throw new Error("Corpus hash does not match the frozen manifest");
  const system = manifest.systems.find((candidate) => candidate.id === requestedSystemId);
  if (system === undefined) throw new Error(`System ${requestedSystemId} is absent from the frozen manifest`);
  const fileEnv = await new DotenvFileStore(resolve(".env")).read();
  const provider = findAiProvider(optionalStringConfiguration(system.configuration, "analysisProvider")
    ?? environmentValue(fileEnv, "AI_PROVIDER"));
  if (provider?.id !== "nvidia" && provider?.id !== "openai") {
    throw new Error("run-nocheh requires analysisProvider nvidia or openai");
  }
  const apiKey = environmentValue(fileEnv, provider.apiKeyEnvKey);
  if (apiKey === undefined) throw new Error(`${provider.apiKeyEnvKey} is required to run Nocheh`);
  const logger = new ConsoleLogger();
  const clock = new SystemClock();
  const metrics = new InMemoryMetricsCollector();
  const database = openSqliteDatabase(":memory:");
  const encryption = new AesGcmEncryption("nocheh-benchmark-isolated-store");
  try {
    const records = new SqliteMemoryRecordRepository(database, encryption);
    const graph = new SqliteMemoryGraphRepository(database, encryption);
    const suggestions = new SqliteSuggestionRepository(database, encryption);
    const tasks = new SqliteTaskRepository(database, encryption);
    const audits = new SqliteAuditRepository(database, encryption);
    const retrieval = new HybridMemoryRetrievalService(
      records,
      new SqliteMemoryEmbeddingRepository(database, encryption, clock),
      undefined,
      logger,
      {
        similarityFloor: numberConfiguration(system.configuration, "similarityFloor", 0.3),
        lexicalWeight: numberConfiguration(system.configuration, "lexicalWeight", 0.25),
      },
    );
    const contextBuilder = new AssistantContextBuilder(retrieval, { graphRepository: graph, suggestionRepository: suggestions });
    const guardRuntime = createRequiredGuardCompletion(fileEnv, stringModelId(system.modelIds, "secretGuard"));
    const processor = new ProcessIncomingMessageUseCase(
      new GuardedSecretDetector(
        new LlmSecretDetector(guardRuntime.completion, { currentRedactionPolicy: () => DEFAULT_REDACTION_POLICY }, logger),
        new RegexSecretDetector(),
        logger,
        { onFailure: "fail_closed" },
      ),
      new NvidiaMemoryGraphAnalyzer({
        apiKey,
        provider: provider.id,
        model: stringModelId(system.modelIds, "textAnalysis"),
        maxTokens: analysisOutputTokenLimit(system.configuration),
        logger,
        ...(provider.id === "openai"
          ? { baseUrl: environmentValue(fileEnv, "OPENAI_BASE_URL") ?? "https://api.openai.com/v1/chat/completions" }
          : {}),
      }),
      tasks,
      records,
      new SqliteTaskSyncRepository(database, encryption),
      { async upsertTask() { throw new Error("External effects are disabled for memory benchmarks"); } },
      clock,
      logger,
      audits,
      metrics,
      graph,
      suggestions,
      new SystemIdGenerator(),
      undefined,
      contextBuilder,
    );
    const backend = new NochehMemoryBenchmarkBackend({
      externalEffects: "disabled", processor, contextBuilder, memoryRecords: records, graph, suggestions, tasks, audits, metrics,
    }, {
      id: system.id,
      version: system.version,
      windowMessageCount: numberConfiguration(system.configuration, "windowMessageCount", 20),
      maxRetrievedMemories: numberConfiguration(system.configuration, "maxRetrievedMemories", 12),
    });
    const report = await new MemoryBenchmarkService(new RegexSecretDetector()).run({
      manifest,
      manifestSha256: memoryBenchmarkManifestSha256(manifestText),
      corpusSaltedSha256,
      messages,
      questions,
      backend,
    });
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${reportPath}\n`);
  } finally {
    database.close();
  }
}

async function readJsonLines<T>(path: string): Promise<readonly T[]> {
  const text = await readFile(path, "utf8");
  return text.split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => parseJson<T>(line, `${path}:${index + 1}`));
}

function findPatternSecretMessageIds(messages: readonly MemoryBenchmarkMessage[]): readonly string[] {
  const detector = new RegexSecretDetector();
  return messages.flatMap((message) => detector.redact(message.text).findings.length === 0 ? [] : [message.id]);
}

function findPatternSecretQuestionIds(questions: readonly MemoryBenchmarkQuestion[]): readonly string[] {
  const detector = new RegexSecretDetector();
  return questions.flatMap((question) => {
    const texts = [question.prompt, ...question.expectedFacts, ...(question.forbiddenFacts ?? [])];
    return texts.some((text) => detector.redact(text).findings.length > 0) ? [question.id] : [];
  });
}

function assertValidPack(
  manifest: MemoryBenchmarkManifest,
  messages: readonly MemoryBenchmarkMessage[],
  questions: readonly MemoryBenchmarkQuestion[],
): void {
  const issues = [
    ...validateMemoryBenchmarkManifest(manifest),
    ...validateMemoryBenchmarkCorpus(messages, manifest.corpus.messageCount),
    ...validateMemoryBenchmarkQuestions(questions),
  ];
  const unsafeMessageIds = findPatternSecretMessageIds(messages);
  if (unsafeMessageIds.length > 0) issues.push(`local secret gate found sensitive patterns in message ids: ${unsafeMessageIds.join(", ")}`);
  const unsafeQuestionIds = findPatternSecretQuestionIds(questions);
  if (unsafeQuestionIds.length > 0) issues.push(`local secret gate found sensitive patterns in question ids: ${unsafeQuestionIds.join(", ")}`);
  if (issues.length > 0) throw new Error(`Invalid benchmark pack:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
}

function stringConfiguration(
  configuration: Readonly<Record<string, string | number | boolean>>,
  key: string,
): string {
  const value = configuration[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Honcho system configuration requires string ${key}`);
  }
  return value;
}

function numberConfiguration(
  configuration: Readonly<Record<string, string | number | boolean>>,
  key: string,
  fallback: number,
): number {
  const value = configuration[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function stringModelId(modelIds: Readonly<Record<string, string>>, key: string): string {
  const value = modelIds[key];
  if (value === undefined || value.trim().length === 0 || value.startsWith("none:")) {
    throw new Error(`Nocheh system modelIds requires configured ${key}`);
  }
  return value;
}

function optionalStringConfiguration(
  configuration: Readonly<Record<string, string | number | boolean>>,
  key: string,
): string | undefined {
  const value = configuration[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function analysisOutputTokenLimit(configuration: Readonly<Record<string, string | number | boolean>>): number {
  switch (configuration.analysisOutputProfile) {
    case "extended_8000": return 8000;
    case "standard_4000":
    case undefined: return 4000;
    default: throw new Error("analysisOutputProfile must be standard_4000 or extended_8000");
  }
}

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown parse error";
    throw new Error(`Cannot parse ${label}: ${message}`);
  }
}

function requirePathCount(args: readonly string[], count: number): void {
  if (args.length !== count) throw new Error(`Expected ${count} paths, received ${args.length}`);
}

function requiredPath(args: readonly string[], index: number): string {
  const path = args[index];
  if (path === undefined) throw new Error(`Missing path at position ${index + 1}`);
  return resolve(path);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  runMemoryBenchmarkCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

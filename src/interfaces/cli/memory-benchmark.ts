import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createMemoryBenchmarkReport } from "../../application/services/memory-benchmark-service.js";
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

interface CapturedBenchmarkRun {
  readonly backendId: string;
  readonly backendVersion: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly preparation: MemoryBenchmarkPreparation;
  readonly recalls: readonly MemoryBenchmarkRecall[];
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
    default:
      throw new Error([
        "Usage:",
        "  memory-benchmark generate-scale <1000|10000|100000> [output-directory]",
        "  memory-benchmark validate <manifest.json> <corpus.jsonl> <questions.json>",
        "  memory-benchmark score <manifest.json> <corpus.jsonl> <questions.json> <captured-run.json> <report.json>",
      ].join("\n"));
  }
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

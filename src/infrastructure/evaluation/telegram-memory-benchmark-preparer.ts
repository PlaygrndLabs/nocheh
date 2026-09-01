import type { SecretDetectorPort } from "../../application/ports/secret-detector.js";
import type { MemoryBenchmarkMessage } from "../../domain/evaluation/memory-benchmark.js";
import { parseTelegramExport } from "../messaging/telegram/telegram-export-parser.js";

export interface TelegramMemoryBenchmarkPreparation {
  readonly messages: readonly MemoryBenchmarkMessage[];
  readonly patternFindingCount: number;
  readonly guardFindingCount: number;
}

/** Converts one raw Telegram JSON export into a guarded, chronological benchmark corpus. */
export async function prepareTelegramMemoryBenchmarkCorpus(
  rawExport: unknown,
  patternDetector: SecretDetectorPort,
  modelGuard: SecretDetectorPort,
  guardBatchMessageCount = 40,
  guardBatchAttempts = 3,
): Promise<TelegramMemoryBenchmarkPreparation> {
  const parsed = parseTelegramExport(rawExport)
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());

  const patternRedacted = await patternDetector.redactMany(parsed.map((message) => message.text));
  assertSameLength("pattern detector", patternRedacted.length, parsed.length);

  // Only pattern-redacted text may cross the local boundary to the model guard.
  if (!Number.isInteger(guardBatchMessageCount) || guardBatchMessageCount <= 0) {
    throw new Error("guardBatchMessageCount must be a positive integer");
  }
  if (!Number.isInteger(guardBatchAttempts) || guardBatchAttempts <= 0) {
    throw new Error("guardBatchAttempts must be a positive integer");
  }
  const guarded = await redactInBatches(
    modelGuard,
    patternRedacted.map((result) => result.text),
    guardBatchMessageCount,
    guardBatchAttempts,
  );
  assertSameLength("model guard", guarded.length, parsed.length);

  const ids = new Set<string>();
  const messages = parsed.map((message, index): MemoryBenchmarkMessage => {
    const id = `${message.conversationId}:${message.messageId}`;
    if (ids.has(id)) {
      throw new Error(`Duplicate Telegram benchmark source id: ${id}`);
    }
    ids.add(id);
    const text = guarded[index]?.text ?? "";
    if (text.trim().length === 0) {
      throw new Error(`Secret guard returned empty text for source id: ${id}`);
    }
    return {
      id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      ...(message.senderDisplayName === undefined ? {} : { senderDisplayName: message.senderDisplayName }),
      occurredAt: message.occurredAt.toISOString(),
      text,
      language: detectLanguage(text),
    };
  });

  return {
    messages,
    patternFindingCount: findingCount(patternRedacted),
    guardFindingCount: findingCount(guarded),
  };
}

async function redactInBatches(
  detector: SecretDetectorPort,
  texts: readonly string[],
  batchMessageCount: number,
  batchAttempts: number,
): Promise<readonly Awaited<ReturnType<SecretDetectorPort["redactMany"]>>[number][]> {
  const results: Awaited<ReturnType<SecretDetectorPort["redactMany"]>>[number][] = [];
  for (let start = 0; start < texts.length; start += batchMessageCount) {
    const batch = texts.slice(start, start + batchMessageCount);
    let lastError: unknown;
    for (let attempt = 1; attempt <= batchAttempts; attempt += 1) {
      try {
        const redacted = await detector.redactMany(batch);
        assertSameLength("model guard batch", redacted.length, batch.length);
        results.push(...redacted);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError !== undefined) throw lastError;
  }
  return results;
}

function assertSameLength(stage: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`${stage} returned ${actual} results for ${expected} messages`);
  }
}

function findingCount(results: readonly { readonly findings: readonly unknown[] }[]): number {
  return results.reduce((total, result) => total + result.findings.length, 0);
}

function detectLanguage(text: string): "en" | "fa" | "mixed" {
  const hasPersian = /[\u0600-\u06ff]/u.test(text);
  const hasEnglish = /[a-z]/iu.test(text);
  if (hasPersian && hasEnglish) return "mixed";
  if (hasPersian) return "fa";
  return "en";
}

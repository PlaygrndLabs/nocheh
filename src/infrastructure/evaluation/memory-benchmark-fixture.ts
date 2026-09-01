import { createHash } from "node:crypto";
import type {
  MemoryBenchmarkMessage,
  MemoryBenchmarkQuestion,
} from "../../domain/evaluation/memory-benchmark.js";

export interface SyntheticMemoryBenchmarkFixture {
  readonly seed: string;
  readonly messages: readonly MemoryBenchmarkMessage[];
  readonly questions: readonly MemoryBenchmarkQuestion[];
}

const SUPPORTED_SCALE_SIZES = [1_000, 10_000, 100_000] as const;

/**
 * Builds a non-personal, deterministic corpus with temporal and relational traps.
 *
 * Ten blocks are graded at every size. Extra blocks increase index/storage pressure without
 * changing the question count, making latency and context growth comparable across sizes.
 */
export function createSyntheticMemoryBenchmarkFixture(
  messageCount: number,
  seed = "nocheh-memory-benchmark-v1",
): SyntheticMemoryBenchmarkFixture {
  if (!SUPPORTED_SCALE_SIZES.some((size) => size === messageCount)) {
    throw new Error("Synthetic benchmark size must be 1,000, 10,000, or 100,000 messages");
  }

  const messages = Array.from({ length: messageCount }, (_, index) => syntheticMessage(index, seed));
  const blockCount = Math.floor(messageCount / 100);
  const gradedBlocks = evenlySpacedBlocks(blockCount, 10);
  const questions = gradedBlocks.flatMap((block) => syntheticQuestions(block));
  return { seed, messages, questions };
}

/** One salted digest over the complete chronological guarded corpus. */
export function saltedMemoryBenchmarkCorpusSha256(
  messages: readonly MemoryBenchmarkMessage[],
  salt: string,
): string {
  const hash = createHash("sha256");
  hash.update(salt, "utf8");
  hash.update("\n", "utf8");
  for (const message of messages) {
    hash.update(JSON.stringify([
      message.id,
      message.conversationId,
      message.occurredAt,
      message.language,
      message.text,
    ]), "utf8");
    hash.update("\n", "utf8");
  }
  return hash.digest("hex");
}

/** Stable digest for the exact manifest file contents after it is frozen. */
export function memoryBenchmarkManifestSha256(serializedManifest: string): string {
  return createHash("sha256").update(serializedManifest, "utf8").digest("hex");
}

function syntheticMessage(index: number, seed: string): MemoryBenchmarkMessage {
  const block = Math.floor(index / 100);
  const position = index % 100;
  const project = `Orchid-${block.toString().padStart(4, "0")}`;
  const sourceTag = shortHash(`${seed}:${index}`);
  const occurredAt = new Date(Date.UTC(2025, 0, 1, 0, index)).toISOString();
  const base = {
    id: sourceId(block, position),
    conversationId: `synthetic-${block % 4}`,
    occurredAt,
  } as const;

  switch (position) {
    case 0:
      return { ...base, language: "en", text: `${project} uses cobalt as its launch color. Ref ${sourceTag}.` };
    case 1:
      return { ...base, language: "fa", text: `ترجیح پروژه ${project} این است که گزارش هفتگی کوتاه و فارسی باشد. شناسه ${sourceTag}.` };
    case 2:
      return { ...base, language: "en", text: `${project} originally planned a budget of ${10_000 + block} USD.` };
    case 4:
      return { ...base, language: "en", text: `Mina leads ${project}.` };
    case 5:
      return { ...base, language: "en", text: `The person leading ${project} reports to team Cedar-${block}.` };
    case 6:
      return { ...base, language: "mixed", text: `Task for ${project}: submit the launch brief by 2026-11-${day(block)}. مهلت قطعی است.` };
    case 7:
      return { ...base, language: "en", text: `${project} prefers decisions as a two-line summary, never a long memo.` };
    case 8:
    case 38:
    case 68:
      return { ...base, language: "en", text: `${project} focus log: deep work succeeds after a morning walk.` };
    case 9:
    case 10:
      return { ...base, language: "en", text: `${project} duplicate notice: the demo room is Cedar Hall.` };
    case 50:
      return { ...base, language: "en", text: `Correction: ${project}'s current approved budget is ${20_000 + block} USD; the earlier amount is obsolete.` };
    case 51:
      return { ...base, language: "en", text: `${project} audit note: both budget claims remain in history, but only ${20_000 + block} USD is active.` };
    default:
      return {
        ...base,
        language: position % 11 === 0 ? "fa" : "en",
        text: position % 11 === 0
          ? `یادداشت خنثی ${sourceTag} برای بارگذاری نمایه پروژه ${project}.`
          : `Neutral index-load note ${sourceTag} for ${project}; no benchmark fact is introduced.`,
      };
  }
}

function syntheticQuestions(block: number): readonly MemoryBenchmarkQuestion[] {
  const project = `Orchid-${block.toString().padStart(4, "0")}`;
  const currentBudget = `${20_000 + block} USD`;
  const oldBudget = `${10_000 + block} USD`;
  return [
    question(block, "fact", `What launch color does ${project} use?`, ["factual_recall"], [0], ["cobalt"]),
    question(block, "persian", `گزارش هفتگی پروژه ${project} باید چگونه باشد؟`, ["persian", "preference"], [1], ["کوتاه", "فارسی"]),
    question(block, "correction", `What is the current approved budget for ${project}?`, ["temporal_correction"], [50, 51], [currentBudget], [oldBudget]),
    question(block, "contradiction", `Which budget claim is active for ${project}?`, ["contradiction"], [50, 51], [currentBudget, "active"], [oldBudget]),
    question(block, "multi-hop", `Which team does the leader of ${project} report to?`, ["multi_hop"], [4, 5], ["Mina", `Cedar-${block}`]),
    question(block, "deadline", `What task and deadline belong to ${project}?`, ["task_deadline"], [6], ["launch brief", `2026-11-${day(block)}`]),
    question(block, "preference", `How should decisions for ${project} be presented?`, ["preference"], [7], ["two-line summary"]),
    question(block, "coaching", `What repeated condition helps deep work for ${project}?`, ["long_range_coaching"], [8, 38, 68], ["morning walk"]),
  ];
}

function question(
  block: number,
  suffix: string,
  prompt: string,
  categories: MemoryBenchmarkQuestion["categories"],
  positions: readonly number[],
  expectedFacts: readonly string[],
  forbiddenFacts?: readonly string[],
): MemoryBenchmarkQuestion {
  return {
    id: `synthetic-q-${block.toString().padStart(4, "0")}-${suffix}`,
    prompt,
    categories,
    expectedSourceIds: positions.map((position) => sourceId(block, position)),
    expectedFacts,
    ...(forbiddenFacts === undefined ? {} : { forbiddenFacts }),
  };
}

function evenlySpacedBlocks(blockCount: number, count: number): readonly number[] {
  if (count === 1) return [0];
  return Array.from({ length: count }, (_, index) => Math.round(index * (blockCount - 1) / (count - 1)));
}

function sourceId(block: number, position: number): string {
  return `synthetic-m-${(block * 100 + position).toString().padStart(6, "0")}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

function day(block: number): string {
  return String((block % 27) + 1).padStart(2, "0");
}

import type { MemoryBenchmarkMessage, MemoryBenchmarkUsage } from "../../domain/evaluation/memory-benchmark.js";
import type { NochehBenchmarkCostModel } from "./nocheh-memory-benchmark-backend.js";

const GPT_5_MINI_SNAPSHOT = "gpt-5-mini-2025-08-07";
const INPUT_USD_PER_MILLION = 0.25;
const OUTPUT_USD_PER_MILLION = 2;
const CONTEXT_WINDOW_TOKENS = 400_000;
const MONTHLY_PROJECTION_MESSAGES = 1000;

/** Cost accounting pinned to the exact GPT-5 mini snapshot used by the pilot. */
export function openAiMiniBenchmarkCostModel(model: string): NochehBenchmarkCostModel {
  if (model !== GPT_5_MINI_SNAPSHOT) {
    throw new Error(`The pilot cost model only supports pinned ${GPT_5_MINI_SNAPSHOT}`);
  }
  const estimate = (usage: Omit<MemoryBenchmarkUsage, "estimatedCostUsd">): number =>
    (usage.inputTokens * INPUT_USD_PER_MILLION + usage.outputTokens * OUTPUT_USD_PER_MILLION) / 1_000_000;
  return {
    estimate,
    projectMonthly(measured, measuredMessageCount) {
      return measuredMessageCount <= 0
        ? 0
        : estimate(measured) * MONTHLY_PROJECTION_MESSAGES / measuredMessageCount;
    },
  };
}

/**
 * Hard preflight using the full model context as billable input for every analysis
 * call, plus the configured output cap. The real prompt is much smaller, so this is
 * deliberately conservative: if it passes, the fixed set of requests cannot exceed
 * the declared run ceiling.
 */
export function maximumOpenAiBenchmarkRunCostUsd(
  messages: readonly MemoryBenchmarkMessage[],
  windowMessageCount: number,
  maxOutputTokens: number,
): number {
  const windows = benchmarkWindowCount(messages, windowMessageCount);
  const maximumInputTokens = windows * CONTEXT_WINDOW_TOKENS;
  const maximumOutputTokens = windows * maxOutputTokens;
  return (
    maximumInputTokens * INPUT_USD_PER_MILLION
    + maximumOutputTokens * OUTPUT_USD_PER_MILLION
  ) / 1_000_000;
}

function benchmarkWindowCount(messages: readonly MemoryBenchmarkMessage[], limit: number): number {
  let windows = 0;
  let currentConversation: string | undefined;
  let currentCount = 0;
  for (const message of messages) {
    if (currentConversation !== message.conversationId || currentCount >= limit) {
      windows += 1;
      currentConversation = message.conversationId;
      currentCount = 0;
    }
    currentCount += 1;
  }
  return windows;
}

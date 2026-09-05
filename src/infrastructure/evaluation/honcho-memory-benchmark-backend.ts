import { createHash } from "node:crypto";
import { Honcho, type Message, type Peer, type QueueStatus, type Session } from "@honcho-ai/sdk";
import type { MemoryBenchmarkBackendPort } from "../../application/ports/memory-benchmark-backend.js";
import type {
  MemoryBenchmarkManifest,
  MemoryBenchmarkMessage,
  MemoryBenchmarkPreparation,
  MemoryBenchmarkQuestion,
  MemoryBenchmarkRecall,
  MemoryBenchmarkUsage,
} from "../../domain/evaluation/memory-benchmark.js";

export interface HonchoBenchmarkStoredMessage {
  readonly id: string;
  readonly sourceId: string;
  readonly text: string;
  readonly tokenCount: number;
}

export interface HonchoBenchmarkClientPort {
  isEmpty(): Promise<{ readonly empty: boolean; readonly apiCalls: number }>;
  addMessages(
    conversationId: string,
    messages: readonly MemoryBenchmarkMessage[],
  ): Promise<{ readonly storedMessages: number; readonly inputTokens: number; readonly apiCalls: number }>;
  search(
    query: string,
    limit: number,
  ): Promise<{ readonly messages: readonly HonchoBenchmarkStoredMessage[]; readonly apiCalls: number }>;
  queueStatus(): Promise<{ readonly status: QueueStatus; readonly apiCalls: number }>;
  chat(query: string): Promise<{ readonly answer: string | null; readonly apiCalls: number }>;
}

export interface SdkHonchoBenchmarkClientOptions {
  readonly baseUrl: string;
  readonly workspaceId: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  /** Private corpora default to loopback-only. Set only for an explicitly approved host. */
  readonly allowRemoteHost?: boolean;
}

/** Thin evaluation-only wrapper; Honcho SDK types do not enter application or domain code. */
export class SdkHonchoBenchmarkClient implements HonchoBenchmarkClientPort {
  private readonly client: Honcho;
  private readonly sessions = new Map<string, Session>();
  private readonly peers = new Map<string, Peer>();
  private readonly sessionPeers = new Map<string, Set<string>>();

  public constructor(options: SdkHonchoBenchmarkClientOptions) {
    assertAllowedHonchoUrl(options.baseUrl, options.allowRemoteHost ?? false);
    this.client = new Honcho({
      baseURL: options.baseUrl,
      workspaceId: options.workspaceId,
      timeout: options.timeoutMs ?? 60_000,
      maxRetries: 0,
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    });
  }

  public async isEmpty(): Promise<{ readonly empty: boolean; readonly apiCalls: number }> {
    const sessions = await this.client.sessions({ page: 1, size: 1 });
    return { empty: sessions.total === 0, apiCalls: 1 };
  }

  public async addMessages(
    conversationId: string,
    messages: readonly MemoryBenchmarkMessage[],
  ): Promise<{ readonly storedMessages: number; readonly inputTokens: number; readonly apiCalls: number }> {
    const session = await this.session(conversationId);
    const peerIds = [...new Set(messages.map((message) => message.senderId))];
    const knownPeers = this.sessionPeers.get(conversationId) ?? new Set<string>();
    const newPeers: Peer[] = [];
    for (const senderId of peerIds) {
      const peer = await this.peer(senderId);
      if (!knownPeers.has(peer.id)) {
        knownPeers.add(peer.id);
        newPeers.push(peer);
      }
    }
    this.sessionPeers.set(conversationId, knownPeers);
    let apiCalls = 0;
    if (newPeers.length > 0) {
      await session.addPeers(newPeers);
      apiCalls += 1;
    }
    const inputs = messages.map((message) => {
      const peer = this.peers.get(message.senderId);
      if (peer === undefined) throw new Error(`Honcho peer was not initialized for sender ${message.senderId}`);
      return peer.message(message.text, {
        createdAt: message.occurredAt,
        metadata: {
          nochehSourceId: message.id,
          nochehConversationId: message.conversationId,
          nochehLanguage: message.language,
        },
      });
    });
    const stored = await session.addMessages(inputs);
    apiCalls += 1;
    return {
      storedMessages: stored.length,
      inputTokens: stored.reduce((total, message) => total + message.tokenCount, 0),
      apiCalls,
    };
  }

  public async search(
    query: string,
    limit: number,
  ): Promise<{ readonly messages: readonly HonchoBenchmarkStoredMessage[]; readonly apiCalls: number }> {
    const messages = await this.client.search(query, { limit });
    return {
      messages: messages.map((message) => storedMessage(message)),
      apiCalls: 1,
    };
  }

  public async queueStatus(): Promise<{ readonly status: QueueStatus; readonly apiCalls: number }> {
    return { status: await this.client.queueStatus(), apiCalls: 1 };
  }

  public async chat(query: string): Promise<{ readonly answer: string | null; readonly apiCalls: number }> {
    return { answer: await this.client.chat(query, { reasoningLevel: "low" }), apiCalls: 1 };
  }

  private async session(conversationId: string): Promise<Session> {
    const cached = this.sessions.get(conversationId);
    if (cached !== undefined) return cached;
    const session = await this.client.session(stableHonchoId("session", conversationId), {
      metadata: { nochehConversationId: conversationId, benchmark: true },
    });
    this.sessions.set(conversationId, session);
    return session;
  }

  private async peer(senderId: string): Promise<Peer> {
    const cached = this.peers.get(senderId);
    if (cached !== undefined) return cached;
    const peer = await this.client.peer(stableHonchoId("peer", senderId), {
      metadata: { nochehSenderId: senderId, benchmark: true },
      configuration: { observeMe: true },
    });
    this.peers.set(senderId, peer);
    return peer;
  }
}

export interface HonchoMemoryBenchmarkBackendOptions {
  readonly id: string;
  readonly version: string;
  readonly ingestBatchSize?: number;
  readonly searchLimit?: number;
  readonly queueTimeoutMs?: number;
  readonly queuePollIntervalMs?: number;
  readonly nowMs?: () => number;
  readonly sleep?: (durationMs: number) => Promise<void>;
}

export interface HonchoNativeRecall {
  readonly questionId: string;
  readonly answer: string | null;
  readonly latencyMs: number;
  readonly usage: MemoryBenchmarkUsage;
}

/** Self-hosted Honcho comparison adapter. It is evaluation-only, not production memory. */
export class HonchoMemoryBenchmarkBackend implements MemoryBenchmarkBackendPort {
  public readonly id: string;
  public readonly version: string;
  private readonly ingestBatchSize: number;
  private readonly searchLimit: number;
  private readonly queueTimeoutMs: number;
  private readonly queuePollIntervalMs: number;
  private readonly nowMs: () => number;
  private readonly sleep: (durationMs: number) => Promise<void>;
  private prepared = false;
  private measuredQueueLagMs = 0;

  public constructor(
    private readonly client: HonchoBenchmarkClientPort,
    options: HonchoMemoryBenchmarkBackendOptions,
  ) {
    this.id = options.id;
    this.version = options.version;
    this.ingestBatchSize = positiveInteger(options.ingestBatchSize, 100);
    this.searchLimit = positiveInteger(options.searchLimit, 20);
    this.queueTimeoutMs = positiveInteger(options.queueTimeoutMs, 600_000);
    this.queuePollIntervalMs = positiveInteger(options.queuePollIntervalMs, 1_000);
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.sleep = options.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
  }

  public async prepare(
    messages: readonly MemoryBenchmarkMessage[],
    _manifest: MemoryBenchmarkManifest,
  ): Promise<MemoryBenchmarkPreparation> {
    if (this.prepared) throw new Error("Honcho benchmark backend can only be prepared once");
    const isolation = await this.client.isEmpty();
    if (!isolation.empty) throw new Error("Honcho benchmark requires a fresh isolated workspace");
    this.prepared = true;

    const startedAt = this.nowMs();
    let apiCalls = isolation.apiCalls;
    let inputTokens = 0;
    let storedMessages = 0;
    for (const batch of chronologicalBatches(messages, this.ingestBatchSize)) {
      const result = await this.client.addMessages(batch.conversationId, batch.messages);
      apiCalls += result.apiCalls;
      inputTokens += result.inputTokens;
      storedMessages += result.storedMessages;
    }
    const queuedAt = this.nowMs();
    const queue = await this.waitForQueue();
    apiCalls += queue.apiCalls;
    this.measuredQueueLagMs = Math.max(0, this.nowMs() - queuedAt);

    return {
      ingestedMessages: storedMessages,
      durationMs: Math.max(0, this.nowMs() - startedAt),
      databaseBytes: 0,
      indexBytes: 0,
      usage: { calls: apiCalls, inputTokens, outputTokens: 0, estimatedCostUsd: 0 },
      observations: {
        ingestBatches: chronologicalBatches(messages, this.ingestBatchSize).length,
        queueLagMs: this.measuredQueueLagMs,
        queueWorkUnits: queue.totalWorkUnits,
        usageTelemetryMissing: 1,
        storageTelemetryMissing: 1,
      },
    };
  }

  public async recall(
    question: MemoryBenchmarkQuestion,
    contextTokenBudget: number,
  ): Promise<MemoryBenchmarkRecall> {
    if (!this.prepared) throw new Error("Honcho benchmark backend must be prepared before recall");
    const startedAt = this.nowMs();
    const result = await this.client.search(question.prompt, this.searchLimit);
    const packed = packHonchoEvidence(result.messages, contextTokenBudget);
    return {
      questionId: question.id,
      evidence: packed.evidence,
      context: packed.context,
      contextTokens: packed.contextTokens,
      retrievalLatencyMs: Math.max(0, this.nowMs() - startedAt),
      queueLagMs: this.measuredQueueLagMs,
      usage: { calls: result.apiCalls, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    };
  }

  /** Native Honcho dialectic run; deliberately excluded from shared retrieval scoring. */
  public async nativeRecall(question: MemoryBenchmarkQuestion): Promise<HonchoNativeRecall> {
    if (!this.prepared) throw new Error("Honcho benchmark backend must be prepared before native recall");
    const startedAt = this.nowMs();
    const result = await this.client.chat(question.prompt);
    return {
      questionId: question.id,
      answer: result.answer,
      latencyMs: Math.max(0, this.nowMs() - startedAt),
      usage: { calls: result.apiCalls, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    };
  }

  private async waitForQueue(): Promise<{ readonly apiCalls: number; readonly totalWorkUnits: number }> {
    const startedAt = this.nowMs();
    let apiCalls = 0;
    while (true) {
      const result = await this.client.queueStatus();
      apiCalls += result.apiCalls;
      const status = result.status;
      if (status.pendingWorkUnits === 0 && status.inProgressWorkUnits === 0) {
        return { apiCalls, totalWorkUnits: status.totalWorkUnits };
      }
      if (this.nowMs() - startedAt >= this.queueTimeoutMs) {
        throw new Error("Honcho background queue did not drain before the benchmark timeout");
      }
      await this.sleep(this.queuePollIntervalMs);
    }
  }
}

function packHonchoEvidence(
  messages: readonly HonchoBenchmarkStoredMessage[],
  tokenBudget: number,
): { readonly evidence: MemoryBenchmarkRecall["evidence"]; readonly context: string; readonly contextTokens: number } {
  const maxChars = Math.max(1, tokenBudget) * 4;
  const lines: string[] = [];
  const evidence: MemoryBenchmarkRecall["evidence"][number][] = [];
  let usedChars = 0;
  for (const message of messages) {
    const prefix = `[source:${message.sourceId || "unproven"}] `;
    const available = maxChars - usedChars - prefix.length - (lines.length === 0 ? 0 : 1);
    if (available <= 0) break;
    const text = message.text.length <= available ? message.text : message.text.slice(0, available);
    if (text.length === 0) break;
    const line = `${prefix}${text}`;
    lines.push(line);
    usedChars += line.length + (lines.length === 1 ? 0 : 1);
    evidence.push({ evidenceId: message.id, sourceId: message.sourceId, text });
    if (text.length < message.text.length) break;
  }
  const context = lines.join("\n");
  return { evidence, context, contextTokens: Math.ceil(context.length / 4) };
}

function chronologicalBatches(
  messages: readonly MemoryBenchmarkMessage[],
  limit: number,
): readonly { readonly conversationId: string; readonly messages: readonly MemoryBenchmarkMessage[] }[] {
  const batches: { conversationId: string; messages: MemoryBenchmarkMessage[] }[] = [];
  let current: MemoryBenchmarkMessage[] = [];
  let conversationId: string | undefined;
  const flush = (): void => {
    if (conversationId !== undefined && current.length > 0) batches.push({ conversationId, messages: current });
    current = [];
  };
  for (const message of messages) {
    if (conversationId !== undefined && (conversationId !== message.conversationId || current.length >= limit)) flush();
    conversationId = message.conversationId;
    current.push(message);
  }
  flush();
  return batches;
}

function storedMessage(message: Message): HonchoBenchmarkStoredMessage {
  const sourceId = message.metadata.nochehSourceId;
  return {
    id: message.id,
    sourceId: typeof sourceId === "string" ? sourceId : "",
    text: message.content,
    tokenCount: message.tokenCount,
  };
}

function stableHonchoId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24)}`;
}

function assertAllowedHonchoUrl(value: string, allowRemoteHost: boolean): void {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!allowRemoteHost && !loopback) {
    throw new Error("Private benchmark corpora may only use a loopback Honcho host unless explicitly approved");
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isInteger(value) || value <= 0 ? fallback : value;
}

import type { ConversationWindow } from "../dto/conversation-window.js";
import type { IncomingMessage } from "../dto/incoming-message.js";
import type { IncomingReactionEvent } from "../dto/incoming-reaction-event.js";
import type { NoteInput } from "../dto/incoming-note.js";
import type { ClockPort } from "../ports/clock.js";
import type { GroupAssistantSettingsRepositoryPort } from "../ports/group-assistant-settings-repository.js";
import type { ConversationProcessorPort, IncomingMessageProcessorPort } from "../ports/incoming-message-processor.js";
import type { LiveMessageBufferRepositoryPort } from "../ports/live-message-buffer-repository.js";
import type { LoggerPort } from "../ports/logger.js";
import type { SecretDetectorPort } from "../ports/secret-detector.js";
import {
  createGroupAssistantSettings,
  type CreateGroupAssistantSettingsInput,
} from "../../domain/assistant/group-assistant-settings.js";
import { isQuarantined, type BufferedMessage } from "../../domain/assistant/buffered-message.js";

/**
 * Recognises a fail-closed secret guard error without the application layer
 * depending on the infrastructure class that raises it.
 */
function isSecretGuardUnavailable(error: unknown): boolean {
  return error instanceof Error && error.name === "SecretGuardUnavailableError";
}

export interface LiveMessageBufferResult {
  readonly processedImmediately: boolean;
  readonly flushedMessageCount: number;
  /** True when the flush was abandoned because the secret guard was unavailable. */
  readonly guardUnavailable?: boolean;
  /** True when a flush for this conversation was already running and this call did nothing. */
  readonly alreadyRunning?: boolean;
}

/** How many guard failures a message tolerates before it is set aside. */
export const DEFAULT_MAX_GUARD_ATTEMPTS = 5;

/** Buffers live group messages and flushes them into the pipeline as one conversation window. */
export class LiveMessageBufferService implements IncomingMessageProcessorPort {
  /**
   * Conversations with a flush in progress.
   *
   * Analysis can take minutes while the sweep ticks every minute, so without this a
   * second sweep reads the same still-unremoved rows and pays for the same window
   * twice. Buffer rows are only deleted after `executeWindow` returns, which is
   * deliberate — losing the window would be worse — so overlap has to be prevented
   * here rather than by the storage layer.
   */
  private readonly flushing = new Set<string>();

  public constructor(
    private readonly bufferRepository: LiveMessageBufferRepositoryPort,
    private readonly settingsRepository: GroupAssistantSettingsRepositoryPort,
    private readonly downstream: ConversationProcessorPort,
    private readonly secretDetector: SecretDetectorPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly defaultSettings: Omit<CreateGroupAssistantSettingsInput, "conversationId"> = {},
    private readonly maxGuardAttempts: number = DEFAULT_MAX_GUARD_ATTEMPTS,
  ) {}

  /**
   * Accepts a message and returns. In batch mode it never analyses.
   *
   * Analysis takes minutes; a Telegram webhook has seconds. Flushing here meant
   * Telegram timed out, retried the same update, and a second analysis was paid for
   * while the first was still running. The flush sweep owns analysis now, so this path
   * is a settings lookup, a pattern redaction, and an append.
   */
  public async execute(message: IncomingMessage): Promise<LiveMessageBufferResult> {
    const settings = await this.settingsRepository.findByConversationId(message.conversationId)
      ?? createGroupAssistantSettings({ conversationId: message.conversationId, ...this.defaultSettings }, this.clock.now());

    if (settings.analysisMode === "immediate") {
      await this.downstream.execute(message);
      return { processedImmediately: true, flushedMessageCount: 1 };
    }

    // Pattern redaction on the webhook path: cheap, deterministic, and enough to keep
    // an obvious credential out of storage. The authoritative guard runs at flush time.
    const redacted = await this.secretDetector.redact(message.text);
    await this.bufferRepository.append({
      ...message,
      text: redacted.text,
      bufferedAt: this.clock.now(),
    });

    return { processedImmediately: false, flushedMessageCount: 0 };
  }

  /** Reactions are not buffered; they are interpreted immediately against prior knowledge. */
  public async executeReaction(event: IncomingReactionEvent): Promise<unknown> {
    return this.downstream.executeReaction(event);
  }

  /** Manual notes bypass buffering and update knowledge immediately. */
  public async executeNote(input: NoteInput): Promise<unknown> {
    return this.downstream.executeNote(input);
  }

  public async flush(conversationId: string): Promise<number> {
    return (await this.flushWithResult(conversationId)).flushedMessageCount;
  }

  /**
   * Flushes every conversation whose buffer is due.
   *
   * Without this, a batch only flushes when the next message arrives, so the analysis
   * interval never fires in a quiet conversation and a guard-failed window is never
   * retried.
   */
  public async flushDue(): Promise<number> {
    let flushed = 0;
    for (const conversationId of await this.bufferRepository.conversationIds()) {
      const settings = await this.settingsRepository.findByConversationId(conversationId)
        ?? createGroupAssistantSettings({ conversationId, ...this.defaultSettings }, this.clock.now());
      if (settings.analysisMode === "immediate") {
        continue;
      }
      const buffered = (await this.bufferRepository.findByConversationId(conversationId))
        .filter((entry) => !isQuarantined(entry));
      if (!this.shouldFlush(buffered, settings.analysisIntervalSeconds, settings.maxMessagesPerBatch)) {
        continue;
      }
      const result = await this.flushWithResult(conversationId);
      flushed += result.flushedMessageCount;
    }
    return flushed;
  }

  /**
   * Flushes one conversation and reports why nothing happened when nothing did.
   *
   * `flush` returns only a count, which cannot distinguish "buffer empty" from "guard
   * down" or "already running". Callers that need to react to those need this.
   */
  public async flushWithResult(conversationId: string): Promise<LiveMessageBufferResult> {
    if (this.flushing.has(conversationId)) {
      this.logger.info("Flush skipped: one is already running for this conversation", { conversationId });
      return { processedImmediately: false, flushedMessageCount: 0, alreadyRunning: true };
    }
    this.flushing.add(conversationId);
    try {
      return await this.runFlush(conversationId);
    } finally {
      this.flushing.delete(conversationId);
    }
  }

  private async runFlush(conversationId: string): Promise<LiveMessageBufferResult> {
    const settings = await this.settingsRepository.findByConversationId(conversationId)
      ?? createGroupAssistantSettings({ conversationId, ...this.defaultSettings }, this.clock.now());
    const buffered = [...await this.bufferRepository.findByConversationId(conversationId)]
      // Quarantined messages are kept for inspection but never re-analysed.
      .filter((message) => !isQuarantined(message))
      .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
      .slice(0, settings.maxMessagesPerBatch);

    if (buffered.length === 0) {
      return { processedImmediately: false, flushedMessageCount: 0 };
    }

    const first = buffered[0];
    if (first === undefined) {
      return { processedImmediately: false, flushedMessageCount: 0 };
    }

    // Field-by-field on purpose: buffered rows must not leak storage-only fields
    // into the window. Every new IncomingMessage field has to be added here too.
    const messages: IncomingMessage[] = buffered.map((message) => ({
      platform: message.platform,
      conversationId: message.conversationId,
      messageId: message.messageId,
      senderId: message.senderId,
      ...(message.senderDisplayName === undefined ? {} : { senderDisplayName: message.senderDisplayName }),
      ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
      text: message.text,
      occurredAt: message.occurredAt,
      ...(message.attachments === undefined || message.attachments.length === 0
        ? {}
        : { attachments: message.attachments }),
    }));

    const window: ConversationWindow = {
      platform: first.platform,
      conversationId,
      messages,
      projectHint: settings.projectHint,
    };

    try {
      await this.downstream.executeWindow(window, settings);
    } catch (error) {
      if (!isSecretGuardUnavailable(error)) {
        throw error;
      }
      // The buffer is deliberately left intact so nothing is lost, and the error is
      // swallowed so the webhook can still ack: a non-2xx would make Telegram retry
      // the same update and hammer an already-failing guard.
      await this.recordGuardFailure(conversationId, buffered);
      return { processedImmediately: false, flushedMessageCount: 0, guardUnavailable: true };
    }

    await this.bufferRepository.remove(conversationId, buffered.map((message) => message.messageId));
    this.logger.info("Flushed live message batch", {
      conversationId,
      messageCount: buffered.length,
    });
    return { processedImmediately: false, flushedMessageCount: buffered.length };
  }

  /** Counts a guard failure and quarantines messages once retries are exhausted. */
  private async recordGuardFailure(
    conversationId: string,
    buffered: readonly BufferedMessage[],
  ): Promise<void> {
    const now = this.clock.now();
    let quarantined = 0;
    for (const message of buffered) {
      const attempts = (message.guardAttempts ?? 0) + 1;
      const exhausted = attempts >= this.maxGuardAttempts;
      if (exhausted) {
        quarantined += 1;
      }
      await this.bufferRepository.append({
        ...message,
        guardAttempts: attempts,
        ...(exhausted ? { quarantinedAt: now } : {}),
      });
    }

    if (quarantined > 0) {
      this.logger.error("Messages quarantined after repeated secret guard failures.", {
        conversationId,
        quarantined,
        maxGuardAttempts: this.maxGuardAttempts,
      });
      return;
    }
    this.logger.warn("Secret guard unavailable; batch kept buffered for retry.", {
      conversationId,
      messageCount: buffered.length,
    });
  }

  private shouldFlush(
    buffered: readonly { readonly bufferedAt: Date }[],
    intervalSeconds: number,
    maxMessagesPerBatch: number,
  ): boolean {
    const first = buffered[0];
    if (first === undefined) {
      return false;
    }

    const ageMs = this.clock.now().getTime() - first.bufferedAt.getTime();
    return buffered.length >= maxMessagesPerBatch || ageMs >= intervalSeconds * 1000;
  }
}

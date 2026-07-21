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

export interface LiveMessageBufferResult {
  readonly processedImmediately: boolean;
  readonly flushedMessageCount: number;
}

/** Buffers live group messages and flushes them into the pipeline as one conversation window. */
export class LiveMessageBufferService implements IncomingMessageProcessorPort {
  public constructor(
    private readonly bufferRepository: LiveMessageBufferRepositoryPort,
    private readonly settingsRepository: GroupAssistantSettingsRepositoryPort,
    private readonly downstream: ConversationProcessorPort,
    private readonly secretDetector: SecretDetectorPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly defaultSettings: Omit<CreateGroupAssistantSettingsInput, "conversationId"> = {},
  ) {}

  public async execute(message: IncomingMessage): Promise<LiveMessageBufferResult> {
    const settings = await this.settingsRepository.findByConversationId(message.conversationId)
      ?? createGroupAssistantSettings({ conversationId: message.conversationId, ...this.defaultSettings }, this.clock.now());

    if (settings.analysisMode === "immediate") {
      await this.downstream.execute(message);
      return { processedImmediately: true, flushedMessageCount: 1 };
    }

    const redacted = this.secretDetector.redact(message.text);
    await this.bufferRepository.append({
      ...message,
      text: redacted.text,
      bufferedAt: this.clock.now(),
    });

    const buffered = await this.bufferRepository.findByConversationId(message.conversationId);
    if (!this.shouldFlush(buffered, settings.analysisIntervalSeconds, settings.maxMessagesPerBatch)) {
      return { processedImmediately: false, flushedMessageCount: 0 };
    }

    return {
      processedImmediately: false,
      flushedMessageCount: await this.flush(message.conversationId),
    };
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
    const settings = await this.settingsRepository.findByConversationId(conversationId)
      ?? createGroupAssistantSettings({ conversationId, ...this.defaultSettings }, this.clock.now());
    const buffered = [...await this.bufferRepository.findByConversationId(conversationId)]
      .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
      .slice(0, settings.maxMessagesPerBatch);

    if (buffered.length === 0) {
      return 0;
    }

    const first = buffered[0];
    if (first === undefined) {
      return 0;
    }

    const messages: IncomingMessage[] = buffered.map((message) => ({
      platform: message.platform,
      conversationId: message.conversationId,
      messageId: message.messageId,
      senderId: message.senderId,
      ...(message.senderDisplayName === undefined ? {} : { senderDisplayName: message.senderDisplayName }),
      ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
      text: message.text,
      occurredAt: message.occurredAt,
    }));

    const window: ConversationWindow = {
      platform: first.platform,
      conversationId,
      messages,
      projectHint: settings.projectHint,
    };
    await this.downstream.executeWindow(window);

    await this.bufferRepository.remove(conversationId, buffered.map((message) => message.messageId));
    this.logger.info("Flushed live message batch", {
      conversationId,
      messageCount: buffered.length,
    });
    return buffered.length;
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

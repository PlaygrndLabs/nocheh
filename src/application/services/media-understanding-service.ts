import type { ConversationWindow } from "../dto/conversation-window.js";
import type { IncomingMessage } from "../dto/incoming-message.js";
import {
  isUnderstandableAttachment,
  selectAttachmentVariant,
  type MessageAttachment,
  type MessageAttachmentUnderstanding,
} from "../../domain/messaging/message-attachment.js";
import type { AiTokenUsage } from "../../domain/observability/audit.js";
import type { AttachmentFetcherPort } from "../ports/attachment-fetcher.js";
import type { ClockPort } from "../ports/clock.js";
import type { LoggerPort } from "../ports/logger.js";
import {
  NoopMediaUnderstandingCache,
  type MediaUnderstandingCachePort,
} from "../ports/media-understanding-cache.js";
import type { MediaUnderstandingPort } from "../ports/media-understanding.js";

export interface MediaUnderstandingLimits {
  /** Hard ceiling on perception calls per window, so one noisy album cannot blow the budget. */
  readonly maxAttachmentsPerWindow: number;
  /** Refuse to download more than this. Protects memory and cost. */
  readonly maxDownloadBytes: number;
  /**
   * Largest rendition to send inline.
   *
   * The NVIDIA catalog endpoint imposed no observable inline cap in testing
   * (10.7MB of base64 was accepted), so this is a latency and memory guard rather
   * than a protocol limit. It sits above any Telegram photo variant so the best
   * rendition is normally sent: downscaling costs OCR accuracy on whiteboards and
   * screenshots, which is most of the point.
   */
  readonly maxInlineBytes: number;
}

export const DEFAULT_MEDIA_UNDERSTANDING_LIMITS: MediaUnderstandingLimits = {
  maxAttachmentsPerWindow: 8,
  maxDownloadBytes: 20 * 1024 * 1024,
  maxInlineBytes: 5 * 1024 * 1024,
};

export interface MediaUnderstandingOutcome {
  readonly window: ConversationWindow;
  readonly attempted: number;
  readonly understood: number;
  readonly fromCache: number;
  readonly failed: number;
  readonly skipped: number;
  readonly tokenUsage?: AiTokenUsage;
  readonly errors: readonly string[];
}

/**
 * Turns a window's image and audio attachments into text before analysis.
 *
 * Failure is never fatal: an attachment that cannot be fetched or understood stays
 * undescribed and the window proceeds. Losing a description degrades quality;
 * failing the window would lose the conversation.
 */
export class MediaUnderstandingService {
  private readonly limits: MediaUnderstandingLimits;

  public constructor(
    private readonly understanding: MediaUnderstandingPort,
    private readonly fetchers: readonly AttachmentFetcherPort[],
    private readonly logger: LoggerPort,
    private readonly clock: ClockPort,
    limits: Partial<MediaUnderstandingLimits> = {},
    private readonly cache: MediaUnderstandingCachePort = new NoopMediaUnderstandingCache(),
  ) {
    this.limits = { ...DEFAULT_MEDIA_UNDERSTANDING_LIMITS, ...limits };
  }

  public async execute(window: ConversationWindow): Promise<MediaUnderstandingOutcome> {
    const errors: string[] = [];
    let attempted = 0;
    let understood = 0;
    let fromCache = 0;
    let failed = 0;
    let skipped = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let provider: string | undefined;
    let model: string | undefined;

    const messages: IncomingMessage[] = [];
    for (const message of window.messages) {
      const attachments = message.attachments;
      if (attachments === undefined || attachments.length === 0) {
        messages.push(message);
        continue;
      }

      const enriched: MessageAttachment[] = [];
      for (const attachment of attachments) {
        if (!isUnderstandableAttachment(attachment) || !this.understanding.supports(attachment.kind)) {
          skipped += 1;
          enriched.push(attachment);
          continue;
        }

        const cached = await this.cache.find(attachment.fileUniqueId);
        if (cached !== undefined) {
          fromCache += 1;
          enriched.push({ ...attachment, understanding: cached });
          continue;
        }

        if (attempted >= this.limits.maxAttachmentsPerWindow) {
          skipped += 1;
          enriched.push(attachment);
          continue;
        }

        attempted += 1;
        const result = await this.understandOne(window.platform, attachment, message.text);
        if (result === undefined) {
          failed += 1;
          errors.push(`Attachment ${attachment.fileUniqueId} (${attachment.kind}) could not be understood.`);
          enriched.push(attachment);
          continue;
        }

        understood += 1;
        inputTokens += result.tokenUsage?.inputTokens ?? 0;
        outputTokens += result.tokenUsage?.outputTokens ?? 0;
        provider ??= result.tokenUsage?.provider;
        model ??= result.tokenUsage?.model;
        await this.cache.save(attachment.fileUniqueId, result.understanding);
        enriched.push({ ...attachment, understanding: result.understanding });
      }

      messages.push({ ...message, attachments: enriched });
    }

    const tokenUsage: AiTokenUsage | undefined = provider === undefined || model === undefined
      ? undefined
      : { provider, model, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };

    return {
      window: { ...window, messages },
      attempted,
      understood,
      fromCache,
      failed,
      skipped,
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
      errors,
    };
  }

  private async understandOne(
    platform: string,
    attachment: MessageAttachment,
    hint: string,
  ): Promise<{
    readonly understanding: MessageAttachmentUnderstanding;
    readonly tokenUsage?: AiTokenUsage;
  } | undefined> {
    const fetcher = this.fetchers.find((candidate) => candidate.supports(platform));
    if (fetcher === undefined) {
      this.logger.warn("No attachment fetcher for platform; attachment stays undescribed.", { platform });
      return undefined;
    }

    const variant = selectAttachmentVariant(attachment, this.limits.maxInlineBytes);
    const startedAt = this.clock.now();
    try {
      const fetched = await fetcher.fetch(
        { ...attachment, fileId: variant.fileId, fileUniqueId: variant.fileUniqueId },
        this.limits.maxDownloadBytes,
      );
      const result = await this.understanding.understand({
        attachment: fetched,
        ...(hint.trim().length === 0 ? {} : { hint }),
      });
      this.logger.info("Attachment understood.", {
        kind: attachment.kind,
        fileUniqueId: attachment.fileUniqueId,
        bytes: fetched.bytes.byteLength,
        durationMs: this.clock.now().getTime() - startedAt.getTime(),
      });
      return {
        understanding: result.understanding,
        ...(result.tokenUsage === undefined ? {} : { tokenUsage: result.tokenUsage }),
      };
    } catch (error) {
      this.logger.warn("Attachment understanding failed; continuing without a description.", {
        kind: attachment.kind,
        fileUniqueId: attachment.fileUniqueId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}

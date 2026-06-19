import type { IncomingMessage } from "../dto/incoming-message.js";
import type { ClockPort } from "../ports/clock.js";
import type { IncomingMessageProcessorPort } from "../ports/incoming-message-processor.js";
import type { LoggerPort } from "../ports/logger.js";
import type { SecretDetectorPort } from "../ports/secret-detector.js";

export interface HistoryImportMessage {
  readonly platform: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly senderDisplayName?: string;
  readonly text: string;
  readonly occurredAt: Date;
}

export interface HistoryImportOptions {
  readonly chunkMessageCount: number;
  readonly chunkDays: number;
}

export interface HistoryImportResult {
  readonly importedMessageCount: number;
  readonly processedChunkCount: number;
  readonly redactedFindingCount: number;
}

/** One-time backfill pipeline for old group exports. Sends chunks, never full history, to the processor. */
export class HistoryImportService {
  public constructor(
    private readonly processor: IncomingMessageProcessorPort,
    private readonly secretDetector: SecretDetectorPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
  ) {}

  public async importMessages(
    messages: readonly HistoryImportMessage[],
    options: HistoryImportOptions,
  ): Promise<HistoryImportResult> {
    const sorted = [...messages]
      .filter((message) => message.text.trim().length > 0)
      .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());

    let redactedFindingCount = 0;
    let processedChunkCount = 0;
    for (const chunk of this.chunk(sorted, options)) {
      const first = chunk[0];
      const last = chunk[chunk.length - 1];
      if (first === undefined || last === undefined) {
        continue;
      }

      const lines = chunk.map((message) => {
        const redacted = this.secretDetector.redact(message.text);
        redactedFindingCount += redacted.findings.length;
        return `${message.occurredAt.toISOString()} ${message.senderDisplayName ?? message.senderId}: ${redacted.text}`;
      });

      const syntheticMessage: IncomingMessage = {
        platform: `${first.platform}-history`,
        conversationId: first.conversationId,
        messageId: `history:${first.messageId}-${last.messageId}`,
        senderId: "nocheh-history-importer",
        text: lines.join("\n"),
        occurredAt: last.occurredAt,
      };

      await this.processor.execute(syntheticMessage);
      processedChunkCount += 1;
    }

    this.logger.info("Imported history messages", {
      messageCount: sorted.length,
      processedChunkCount,
      completedAt: this.clock.now().toISOString(),
    });
    return {
      importedMessageCount: sorted.length,
      processedChunkCount,
      redactedFindingCount,
    };
  }

  private chunk(
    messages: readonly HistoryImportMessage[],
    options: HistoryImportOptions,
  ): readonly (readonly HistoryImportMessage[])[] {
    const chunks: HistoryImportMessage[][] = [];
    let current: HistoryImportMessage[] = [];
    let chunkStartedAt: Date | undefined;

    for (const message of messages) {
      chunkStartedAt ??= message.occurredAt;
      const ageDays = (message.occurredAt.getTime() - chunkStartedAt.getTime()) / 86_400_000;
      if (current.length >= options.chunkMessageCount || ageDays >= options.chunkDays) {
        chunks.push(current);
        current = [];
        chunkStartedAt = message.occurredAt;
      }
      current.push(message);
    }

    if (current.length > 0) {
      chunks.push(current);
    }
    return chunks;
  }
}

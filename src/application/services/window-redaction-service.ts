import type { ConversationWindow } from "../dto/conversation-window.js";
import type { IncomingMessage } from "../dto/incoming-message.js";
import type { MessageAttachment } from "../../domain/messaging/message-attachment.js";
import type { SensitiveFindingKind } from "../../domain/security/redaction.js";
import type { SecretDetectorPort } from "../ports/secret-detector.js";

/** Which field of a window a text segment came from, so it can be put back. */
type SegmentTarget =
  | { readonly kind: "text"; readonly messageIndex: number }
  | { readonly kind: "description"; readonly messageIndex: number; readonly attachmentIndex: number }
  | { readonly kind: "transcript"; readonly messageIndex: number; readonly attachmentIndex: number };

interface Segment {
  readonly target: SegmentTarget;
  readonly value: string;
}

export interface WindowRedactionResult {
  readonly window: ConversationWindow;
  readonly findingCount: number;
  /** Counts per finding kind, for auditing what was caught without storing values. */
  readonly findingKinds: Readonly<Partial<Record<SensitiveFindingKind, number>>>;
  /** Number of text segments inspected. More than the message count when media is described. */
  readonly segmentCount: number;
}

/**
 * Redacts every text-bearing field of a window in one pass.
 *
 * Attachment descriptions and transcripts are text derived from raw media, so they
 * are just as capable of carrying a secret as a typed message and must be redacted
 * with it. Batching all segments into a single detector call keeps a model-backed
 * detector at one request per window rather than one per field.
 */
export class WindowRedactionService {
  public constructor(private readonly secretDetector: SecretDetectorPort) {}

  public async execute(window: ConversationWindow): Promise<WindowRedactionResult> {
    const segments = collectSegments(window.messages);
    if (segments.length === 0) {
      return { window, findingCount: 0, findingKinds: {}, segmentCount: 0 };
    }

    const redacted = await this.secretDetector.redactMany(segments.map((segment) => segment.value));
    if (redacted.length !== segments.length) {
      throw new Error(
        `Secret detector returned ${redacted.length} results for ${segments.length} segments; refusing to guess the mapping.`,
      );
    }

    let findingCount = 0;
    const findingKinds: Partial<Record<SensitiveFindingKind, number>> = {};
    const replacements = new Map<string, string>();
    for (const [index, segment] of segments.entries()) {
      const result = redacted[index];
      if (result === undefined) {
        continue;
      }
      findingCount += result.findings.length;
      for (const finding of result.findings) {
        findingKinds[finding.kind] = (findingKinds[finding.kind] ?? 0) + 1;
      }
      replacements.set(segmentKey(segment.target), result.text);
    }

    return {
      window: { ...window, messages: applySegments(window.messages, replacements) },
      findingCount,
      findingKinds,
      segmentCount: segments.length,
    };
  }
}

function segmentKey(target: SegmentTarget): string {
  return target.kind === "text"
    ? `text:${target.messageIndex}`
    : `${target.kind}:${target.messageIndex}:${target.attachmentIndex}`;
}

function collectSegments(messages: readonly IncomingMessage[]): readonly Segment[] {
  const segments: Segment[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (message.text.length > 0) {
      segments.push({ target: { kind: "text", messageIndex }, value: message.text });
    }
    for (const [attachmentIndex, attachment] of (message.attachments ?? []).entries()) {
      const understanding = attachment.understanding;
      if (understanding === undefined) {
        continue;
      }
      segments.push({
        target: { kind: "description", messageIndex, attachmentIndex },
        value: understanding.description,
      });
      if (understanding.transcript !== undefined && understanding.transcript.length > 0) {
        segments.push({
          target: { kind: "transcript", messageIndex, attachmentIndex },
          value: understanding.transcript,
        });
      }
    }
  }
  return segments;
}

function applySegments(
  messages: readonly IncomingMessage[],
  replacements: ReadonlyMap<string, string>,
): readonly IncomingMessage[] {
  return messages.map((message, messageIndex) => {
    const text = replacements.get(`text:${messageIndex}`) ?? message.text;
    const attachments = message.attachments;
    if (attachments === undefined || attachments.length === 0) {
      return { ...message, text };
    }

    const nextAttachments: MessageAttachment[] = attachments.map((attachment, attachmentIndex) => {
      const understanding = attachment.understanding;
      if (understanding === undefined) {
        return attachment;
      }
      const description = replacements.get(`description:${messageIndex}:${attachmentIndex}`)
        ?? understanding.description;
      const transcript = replacements.get(`transcript:${messageIndex}:${attachmentIndex}`)
        ?? understanding.transcript;
      return {
        ...attachment,
        understanding: {
          ...understanding,
          description,
          ...(transcript === undefined ? {} : { transcript }),
        },
      };
    });

    return { ...message, text, attachments: nextAttachments };
  });
}

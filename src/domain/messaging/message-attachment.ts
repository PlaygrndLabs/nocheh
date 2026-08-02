/**
 * Non-text content attached to a message.
 *
 * Attachments carry identity and shape only. Raw bytes are never stored here and
 * never persisted: a perception model turns them into text, and only that text
 * travels further into the pipeline.
 */
export type MessageAttachmentKind = "image" | "audio" | "video" | "document" | "sticker";

/** Attachment kinds a perception model can currently turn into text. */
export const UNDERSTANDABLE_ATTACHMENT_KINDS: readonly MessageAttachmentKind[] = ["image", "audio"];

/**
 * One downloadable rendition of an attachment.
 *
 * Telegram ships photos in several resolutions. Perception providers cap inline
 * payload size, so an adapter needs every rendition to pick the largest one that
 * fits instead of failing on the original.
 */
export interface MessageAttachmentVariant {
  /** Download handle. Platform-scoped and may rotate; not a stable identity. */
  readonly fileId: string;
  /** Stable identity across resends. Safe as a cache key. */
  readonly fileUniqueId: string;
  readonly sizeBytes?: number;
  readonly width?: number;
  readonly height?: number;
}

/** Text derived from an attachment by a perception model. */
export interface MessageAttachmentUnderstanding {
  /** What the attachment shows or contains, in plain language. */
  readonly description: string;
  /** Verbatim speech for audio attachments, when the model returns it. */
  readonly transcript?: string;
  readonly confidence: number;
  readonly provider: string;
  readonly model: string;
}

export interface MessageAttachment {
  readonly kind: MessageAttachmentKind;
  /** Stable identity across resends. Safe as a cache key. */
  readonly fileUniqueId: string;
  /** Preferred rendition for download. */
  readonly fileId: string;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
  readonly durationSeconds?: number;
  readonly width?: number;
  readonly height?: number;
  readonly fileName?: string;
  /** Ordered smallest to largest. Present when the platform exposes renditions. */
  readonly variants?: readonly MessageAttachmentVariant[];
  /** Absent until media understanding runs, or when it is disabled or failed. */
  readonly understanding?: MessageAttachmentUnderstanding;
}

/** True when a perception model could turn this attachment into text. */
export function isUnderstandableAttachment(attachment: MessageAttachment): boolean {
  return UNDERSTANDABLE_ATTACHMENT_KINDS.includes(attachment.kind);
}

/**
 * Picks the largest rendition whose size fits the budget, falling back to the
 * smallest when every rendition is too large.
 */
export function selectAttachmentVariant(
  attachment: MessageAttachment,
  maxBytes: number,
): MessageAttachmentVariant {
  const fallback: MessageAttachmentVariant = {
    fileId: attachment.fileId,
    fileUniqueId: attachment.fileUniqueId,
    ...(attachment.sizeBytes === undefined ? {} : { sizeBytes: attachment.sizeBytes }),
    ...(attachment.width === undefined ? {} : { width: attachment.width }),
    ...(attachment.height === undefined ? {} : { height: attachment.height }),
  };

  const variants = attachment.variants ?? [];
  if (variants.length === 0) {
    return fallback;
  }

  const ascending = [...variants].sort((left, right) => (left.sizeBytes ?? 0) - (right.sizeBytes ?? 0));
  let selected: MessageAttachmentVariant | undefined;
  for (const variant of ascending) {
    // Unknown size is treated as fitting: the download itself enforces the cap.
    if (variant.sizeBytes === undefined || variant.sizeBytes <= maxBytes) {
      selected = variant;
    }
  }
  return selected ?? ascending[0] ?? fallback;
}

/**
 * Renders an attachment for the analysis prompt.
 *
 * Understanding text is included when present so the text model can reason about
 * media it cannot see. Without it the model still learns that media was sent,
 * which keeps the conversation coherent instead of silently truncated.
 */
export function describeAttachment(attachment: MessageAttachment): string {
  const shape = [
    attachment.kind,
    attachment.fileName,
    attachment.durationSeconds === undefined ? undefined : `${attachment.durationSeconds}s`,
  ].filter((part): part is string => part !== undefined && part.length > 0).join(", ");

  const understanding = attachment.understanding;
  if (understanding === undefined) {
    return `[${shape}: no description available]`;
  }

  const transcript = understanding.transcript === undefined || understanding.transcript.trim().length === 0
    ? undefined
    : `transcript: ${understanding.transcript}`;
  return [`[${shape}: ${understanding.description}`, transcript].filter(Boolean).join(" | ") + "]";
}

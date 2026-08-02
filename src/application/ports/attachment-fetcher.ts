import type { MessageAttachment } from "../../domain/messaging/message-attachment.js";
import type { FetchedAttachment } from "./media-understanding.js";

/** Raised when an attachment cannot be downloaded. Callers degrade instead of failing the window. */
export class AttachmentFetchError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "AttachmentFetchError";
  }
}

/**
 * Downloads attachment bytes from the platform that delivered the message.
 *
 * Bytes are returned, never stored. Implementations enforce a byte cap so a large
 * upload cannot exhaust memory.
 */
export interface AttachmentFetcherPort {
  /** True when this fetcher handles the platform the message came from. */
  supports(platform: string): boolean;
  fetch(attachment: MessageAttachment, maxBytes: number): Promise<FetchedAttachment>;
}

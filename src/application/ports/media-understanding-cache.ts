import type { MessageAttachmentUnderstanding } from "../../domain/messaging/message-attachment.js";

/**
 * Caches derived attachment text keyed by the platform's stable file identity.
 *
 * Resending the same image or forwarding a voice note is common, and perception
 * calls are the most expensive step in the pipeline. Only derived text is cached;
 * bytes are never stored.
 */
export interface MediaUnderstandingCachePort {
  find(fileUniqueId: string): Promise<MessageAttachmentUnderstanding | undefined>;
  save(fileUniqueId: string, understanding: MessageAttachmentUnderstanding): Promise<void>;
}

/** Used when no cache is wired: every attachment is understood fresh. */
export class NoopMediaUnderstandingCache implements MediaUnderstandingCachePort {
  public async find(): Promise<MessageAttachmentUnderstanding | undefined> {
    return undefined;
  }

  public async save(): Promise<void> {
    // Intentionally empty.
  }
}

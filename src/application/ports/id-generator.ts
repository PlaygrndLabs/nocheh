/** Provides testable, environment-neutral identifier generation. */
export interface IdGeneratorPort {
  generate(): string;
}

/**
 * System implementation backed by the Web Crypto global (`crypto.randomUUID`).
 *
 * This uses the WHATWG standard global rather than `node:crypto`, so the same
 * adapter runs unchanged on Node.js and inside a V8 isolate (e.g. Telegram
 * Serverless). Wire a different adapter in the composition root for any runtime
 * that lacks Web Crypto.
 */
export class SystemIdGenerator implements IdGeneratorPort {
  public generate(): string {
    return crypto.randomUUID();
  }
}

/** Logging port. Implementations must avoid logging raw message contents. */
export interface LoggerPort {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/** No-op logger useful for tests and local composition. */
export class NoopLogger implements LoggerPort {
  public info(): void {}
  public warn(): void {}
  public error(): void {}
}

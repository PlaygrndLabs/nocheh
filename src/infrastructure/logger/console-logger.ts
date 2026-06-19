import type { LoggerPort } from "../../application/ports/logger.js";

/** Console logger that receives only sanitized operational metadata. */
export class ConsoleLogger implements LoggerPort {
  public info(message: string, context?: Record<string, unknown>): void {
    console.info(message, context ?? {});
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    console.warn(message, context ?? {});
  }

  public error(message: string, context?: Record<string, unknown>): void {
    console.error(message, context ?? {});
  }
}

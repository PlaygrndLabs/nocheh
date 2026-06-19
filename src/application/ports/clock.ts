/** Provides testable access to wall-clock time. */
export interface ClockPort {
  now(): Date;
}

/** System clock implementation for production wiring. */
export class SystemClock implements ClockPort {
  public now(): Date {
    return new Date();
  }
}

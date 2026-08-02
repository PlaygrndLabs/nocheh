/**
 * Shared request timeout for outbound model calls.
 *
 * Without an explicit signal, a slow provider hangs until Node's own socket timeout
 * (300s by default) and surfaces as an opaque `fetch failed`. Model latency varies
 * enormously — a real analysis window against `z-ai/glm-5.2` measured over 200
 * seconds — so every adapter states its own budget and fails with a message that
 * names the knob to turn.
 */
export const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 120_000;

export interface TimedFetchOptions {
  readonly timeoutMs: number;
  /** Included in the error message so the operator knows which call gave up. */
  readonly label: string;
}

/**
 * Performs a fetch that aborts after `timeoutMs`.
 *
 * An abort is translated into a plain Error, because an unhandled `AbortError`
 * reads like a bug rather than a provider that was too slow.
 */
export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  options: TimedFetchOptions,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
  } catch (error) {
    if (isAbort(error)) {
      throw new Error(
        `${options.label} timed out after ${options.timeoutMs}ms. Raise its timeout or use a faster model.`,
        { cause: error },
      );
    }
    throw error;
  }
}

function isAbort(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = (error as { readonly name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * Represents an operation that can either succeed with a value or fail with an error.
 */
export type Result<T, E extends Error = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Creates a successful result. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Creates a failed result. */
export function err<E extends Error>(error: E): Result<never, E> {
  return { ok: false, error };
}

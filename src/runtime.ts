import { HttpError } from './http.js';

/** Helper services Nocheh calls besides the brain: secret checks, file, voice and image reading, prices and the memory
 * filter, plus the Telegram calls the Hermes service still answers. Turns and the brain's own state go through the brain
 * socket instead (ADR-0234). */
export const runtimeOperations = ['source.file', 'guard.detect', 'action.execute', 'memory.filter','telegram.chat','telegram.approval',
  'telegram.refusal','telegram.notice','usage.price','file.extract','voice.transcribe','image.read'] as const;
export type RuntimeOperation = typeof runtimeOperations[number];
export type RuntimeCall = (operation: RuntimeOperation, input: Record<string, unknown>, timeout?: number) => Promise<Record<string, unknown>>;
export interface RuntimeAdapter {
  readonly id: string;
  readonly capabilities: Readonly<Record<RuntimeOperation, boolean>>;
  readonly call: RuntimeCall;
}

/** Reject unsupported operations before invoking a harness or producing effects. */
export function runtimeCall(adapter: RuntimeAdapter): RuntimeCall {
  return async (operation, input, timeout) => {
    if (!adapter.capabilities[operation]) throw new HttpError(409, 'runtime_capability_unavailable');
    return adapter.call(operation, input, timeout);
  };
}

export interface RunSource {
  readonly event_id: string;
  readonly scope: string;
  readonly channel: 'telegram' | 'browser' | 'scheduler';
  readonly source_key: string;
}

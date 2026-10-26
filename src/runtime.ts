import { HttpError } from './http.js';

/** Nocheh capabilities, independent of a harness's URL or native profile names. */
export const runtimeOperations = ['status', 'profiles.list', 'config.read', 'config.write',
  'memory.read', 'persona.read', 'persona.write', 'prompts.defaults', 'run.start', 'run.resume', 'run.cancel', 'run.events', 'lifecycle',
  'source.file', 'guard.detect', 'action.execute', 'memory.review', 'memory.recall', 'memory.filter','schedule.advance','telegram.chat','telegram.approval','telegram.refusal','telegram.notice','usage.price'] as const;
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

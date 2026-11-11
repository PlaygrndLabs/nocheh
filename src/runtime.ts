import { HttpError } from './http.js';

/** Helper services Nocheh calls besides the brain: secret checks, file, voice and image reading, prices and the memory
 * filter from the Hermes service, and the front door calls of Nocheh's own Telegram bot (ADR-0235). Turns and the brain's
 * own state go through the brain socket instead (ADR-0234). */
export const runtimeOperations = ['source.file', 'guard.detect', 'action.execute', 'memory.filter','telegram.chat','telegram.approval',
  'telegram.refusal','telegram.notice','telegram.status','telegram.identity','telegram.presence','telegram.reply',
  'usage.price','file.extract','voice.transcribe','image.read'] as const;
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

/** Several services as one adapter: each operation goes to the first service that offers it. */
export function combinedAdapter(...adapters: RuntimeAdapter[]): RuntimeAdapter {
  const owner = (operation: RuntimeOperation) => adapters.find(adapter => adapter.capabilities[operation]);
  return {
    id: adapters.map(adapter => adapter.id).join('+'),
    capabilities: Object.freeze(Object.fromEntries(runtimeOperations.map(op => [op, !!owner(op)]))) as Record<RuntimeOperation, boolean>,
    call: async (operation, input, timeout) => {
      const adapter = owner(operation);
      if (!adapter) throw new HttpError(409, 'runtime_capability_unavailable');
      return adapter.call(operation, input, timeout);
    },
  };
}

export interface RunSource {
  readonly event_id: string;
  readonly scope: string;
  readonly channel: 'telegram' | 'browser' | 'scheduler';
  readonly source_key: string;
}

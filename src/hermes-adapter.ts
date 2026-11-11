import { HttpError, object } from './http.js';
import { runtimeOperations, type RuntimeAdapter, type RuntimeOperation } from './runtime.js';

type Options = {url: string; token: string; fetch?: typeof fetch};
/** Only this adapter knows the private paths of the helper services the Hermes service hosts. The brain itself is in
 * `brain/hermes.ts` (ADR-0234). */
export function hermesAdapter(options: Options): RuntimeAdapter {
  const transport = options.fetch ?? fetch;
  const routes: Partial<Record<RuntimeOperation, string>> = {
    'source.file': '/internal/file',
    'guard.detect': '/internal/detect', 'action.execute': '/internal/action',
    'memory.filter':'/internal/memory/filter',
    'telegram.chat':'/internal/telegram/chat',
    'telegram.approval':'/internal/telegram/approval',
    'telegram.refusal':'/internal/telegram/refusal',
    'telegram.notice':'/internal/telegram/notice',
    'usage.price':'/internal/usage/price',
    'file.extract':'/internal/extract',
    'voice.transcribe':'/internal/transcribe',
    'image.read':'/internal/image',
  };
  return {
    id: 'hermes',
    capabilities: Object.freeze(Object.fromEntries(runtimeOperations.map(op => [op, !!routes[op]]))) as Record<RuntimeOperation, boolean>,
    async call(operation, input, timeout = 120000) {
      const path = routes[operation];
      if (!path) throw new HttpError(409, 'runtime_capability_unavailable');
      const {channel: _channel, ...payload} = input;
      const response = await transport(new URL(path, options.url), {
        method: 'POST',
        headers: {authorization: `Bearer ${options.token}`, 'content-type': 'application/json'},
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) {
        let code = response.status === 429 ? 'quota_paused' : 'runtime_unavailable';
        const error = await response.json().catch(() => null) as {error?: string} | null;
        // No provider chosen in Settings › Models is a waiting condition, not a runtime fault.
        if (error?.error === 'provider_not_configured') code = error.error;
        // A file too large for the bot to download settles instead of retrying.
        else if (operation === 'source.file' && error?.error === 'attachment_too_large') code = error.error;
        else if (operation === 'guard.detect' && error?.error === 'detector_contract_rejected') code = error.error;
        throw new HttpError(response.status, code);
      }
      return object(await response.json());
    },
  };
}

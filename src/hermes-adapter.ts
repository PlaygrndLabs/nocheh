import { HttpError, object } from './http.js';
import { runtimeOperations, type RuntimeAdapter, type RuntimeOperation } from './runtime.js';

type Options = {url: string; token: string; fetch?: typeof fetch};
/** Only this adapter knows Hermes's private RPC paths and management actions. */
export function hermesAdapter(options: Options): RuntimeAdapter {
  const transport = options.fetch ?? fetch;
  const routes: Partial<Record<RuntimeOperation, string>> = {
    status: '/health', 'profiles.list': '/internal/manage', 'config.read': '/internal/manage',
    'config.write': '/internal/manage', 'memory.read': '/internal/manage', 'run.start': '/internal/dispatch',
    'source.file': '/internal/file', 'perception.transcribe': '/internal/transcribe',
    'guard.detect': '/internal/detect', 'action.execute': '/internal/action',
  };
  const actions: Partial<Record<RuntimeOperation, string>> = {
    'profiles.list': 'profiles', 'config.read': 'preferences', 'config.write': 'preferences', 'memory.read': 'memory',
  };
  return {
    id: 'hermes',
    capabilities: Object.freeze(Object.fromEntries(runtimeOperations.map(op => [op, !!routes[op]]))) as Record<RuntimeOperation, boolean>,
    async call(operation, input, timeout = 120000) {
      const path = routes[operation];
      if (!path) throw new HttpError(409, 'runtime_capability_unavailable');
      // Unsupported channels cannot accidentally enter the Telegram runner.
      if (operation === 'run.start' && input.channel !== undefined && input.channel !== 'telegram')
        throw new HttpError(409, 'runtime_channel_unavailable');
      const {channel: _channel, ...body} = input;
      const payload = actions[operation] ? {...body, action: actions[operation]} : body;
      const response = await transport(new URL(path, options.url), {
        method: operation === 'status' ? 'GET' : 'POST',
        headers: {authorization: `Bearer ${options.token}`, 'content-type': 'application/json'},
        ...(operation === 'status' ? {} : {body: JSON.stringify(payload)}),
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) {
        let code = response.status === 429 ? 'quota_paused' : 'runtime_unavailable';
        if (operation === 'guard.detect') {
          const error = await response.json().catch(() => null) as {error?: string} | null;
          if (error?.error === 'detector_contract_rejected') code = error.error;
        }
        throw new HttpError(response.status, code);
      }
      return object(await response.json());
    },
  };
}

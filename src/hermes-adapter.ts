import { HttpError, object } from './http.js';
import { runtimeOperations, type RuntimeAdapter, type RuntimeOperation } from './runtime.js';

type Options = {url: string; token: string; fetch?: typeof fetch};
/** Only this adapter knows Hermes's private RPC paths and management actions. */
export function hermesAdapter(options: Options): RuntimeAdapter {
  const transport = options.fetch ?? fetch;
  const routes: Partial<Record<RuntimeOperation, string>> = {
    status: '/health', 'profiles.list': '/internal/manage', 'config.read': '/internal/manage',
    'config.write': '/internal/manage', 'memory.read': '/internal/manage', 'run.start': '/internal/dispatch',
    'persona.read': '/internal/manage', 'persona.write': '/internal/manage', 'prompts.defaults': '/internal/manage',
    'source.file': '/internal/file',
    'guard.detect': '/internal/detect', 'action.execute': '/internal/action',
    'memory.review':'/internal/memory/review', 'memory.recall':'/internal/memory/recall',
    'memory.filter':'/internal/memory/filter',
    'schedule.advance':'/internal/schedule/advance',
    'telegram.chat':'/internal/telegram/chat',
    'usage.price':'/internal/usage/price',
    'run.resume':'/internal/run/resume','run.events':'/internal/run/events','run.cancel':'/internal/run/cancel',
  };
  const actions: Partial<Record<RuntimeOperation, string>> = {
    'profiles.list': 'profiles', 'config.read': 'preferences', 'config.write': 'preferences', 'memory.read': 'memory',
    'persona.read': 'persona', 'persona.write': 'persona', 'prompts.defaults': 'prompts',
  };
  return {
    id: 'hermes',
    capabilities: Object.freeze(Object.fromEntries(runtimeOperations.map(op => [op, !!routes[op]]))) as Record<RuntimeOperation, boolean>,
    async call(operation, input, timeout = 120000) {
      const path = operation==='run.start'&&input.asynchronous===true?'/internal/run/start':routes[operation];
      if (!path) throw new HttpError(409, 'runtime_capability_unavailable');
      // Unsupported channels cannot accidentally enter the Telegram runner.
      if (operation === 'run.start' && input.channel !== undefined && input.channel !== 'telegram' &&
          !(input.asynchronous===true&&['browser','scheduler'].includes(String(input.channel))))
        throw new HttpError(409, 'runtime_channel_unavailable');
      const body=path.startsWith('/internal/run/')?input:(({channel:_channel,...rest})=>rest)(input);
      const payload = actions[operation] ? {...body, action: actions[operation]} : body;
      const response = await transport(new URL(path, options.url), {
        method: operation === 'status' ? 'GET' : 'POST',
        headers: {authorization: `Bearer ${options.token}`, 'content-type': 'application/json'},
        ...(operation === 'status' ? {} : {body: JSON.stringify(payload)}),
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) {
        let code = response.status === 429 ? 'quota_paused' : 'runtime_unavailable';
        const error = await response.json().catch(() => null) as {error?: string} | null;
        // No provider chosen in Settings › Models is a waiting condition, not a runtime fault.
        if (error?.error === 'provider_not_configured') code = error.error;
        else if (['guard.detect','config.write','config.read','persona.read','persona.write','prompts.defaults'].includes(operation)) {
          if (error?.error && ['detector_contract_rejected','configuration_conflict','unsupported_preference','profile_scope_denied','invalid_preference','invalid_persona'].includes(error.error)) code = error.error;
        }
        throw new HttpError(response.status, code);
      }
      return object(await response.json());
    },
  };
}

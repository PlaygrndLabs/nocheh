import { HttpError, object } from '../http.js';
import { runtimeOperations, type RuntimeAdapter, type RuntimeOperation } from '../runtime.js';

type Options = {url: string; token: string; fetch?: typeof fetch};
/** Nocheh's own Telegram bot, the `nocheh-telegram` service (ADR-0235). Only this adapter knows its routes. It is the one
 * process that holds the bot token: it polls Telegram, and shows presence, sends replies, cards, refusals and notices,
 * runs approved sends and reads files and chats when Nocheh asks. */
export function telegramAdapter(options: Options): RuntimeAdapter {
  const transport = options.fetch ?? fetch;
  const routes: Partial<Record<RuntimeOperation, string>> = {
    'source.file': '/internal/telegram/file',
    'action.execute': '/internal/telegram/action',
    'telegram.chat': '/internal/telegram/chat',
    'telegram.approval': '/internal/telegram/approval',
    'telegram.refusal': '/internal/telegram/refusal',
    'telegram.notice': '/internal/telegram/notice',
    'telegram.status': '/health',
    'telegram.identity': '/internal/telegram/identity',
    'telegram.presence': '/internal/telegram/presence',
    'telegram.reply': '/internal/telegram/reply',
  };
  return {
    id: 'telegram',
    capabilities: Object.freeze(Object.fromEntries(runtimeOperations.map(op => [op, !!routes[op]]))) as Record<RuntimeOperation, boolean>,
    async call(operation, input, timeout = 60000) {
      const path = routes[operation];
      if (!path) throw new HttpError(409, 'runtime_capability_unavailable');
      const read = operation === 'telegram.status';
      let response: Response;
      try {
        response = await transport(new URL(path, options.url), read
          ? {method: 'GET', signal: AbortSignal.timeout(timeout)}
          : {method: 'POST', headers: {authorization: `Bearer ${options.token}`, 'content-type': 'application/json'},
            body: JSON.stringify(input), signal: AbortSignal.timeout(timeout)});
      } catch {throw new HttpError(503, 'telegram_unavailable');}
      if (!response.ok) {
        const error = await response.json().catch(() => null) as {error?: string} | null;
        // A file too large for the bot to download settles instead of retrying.
        const code = response.status === 429 ? 'quota_paused' : operation === 'source.file' && error?.error === 'attachment_too_large' ? error.error :
          response.status === 400 ? 'telegram_rejected_request' : 'telegram_unavailable';
        throw new HttpError(response.status, code);
      }
      return object(await response.json());
    },
  };
}

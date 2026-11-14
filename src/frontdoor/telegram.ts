import { HttpError, object } from '../http.js';
import { runtimeOperations, type RuntimeAdapter, type RuntimeOperation } from '../runtime.js';
import { chats, type AppBinding, type ChatDirectory } from '../chats.js';

/*
 * The front door's translation between Nocheh's chats and Telegram's own ids (ADR-0250), in one place. Storage names a
 * chat by its Nocheh id everywhere; every call that sends to a chat (a reply, presence, an approved send, a card, a notice,
 * a reminder) is given that chat's current Telegram id and topic here, so sends follow a group Telegram upgraded. An
 * incoming Telegram id is turned into its Nocheh chat here too. A chat the directory does not know is never sent to
 * (ADR-0242, fail closed).
 */

/** Where a Nocheh chat or topic is in Telegram now: its current chat id and the topic there, a number as Telegram
 *  writes a message_thread_id. */
export interface TelegramTarget {chat_id: string; topic?: number}
/** The chat's current Telegram id and topic, or null for an unknown chat, one with no Telegram id, or a topic key
 *  Telegram could not have given. */
export function telegramAddress(chat: string | null | undefined, directory: ChatDirectory = chats()): TelegramTarget | null {
  const address = directory.appIds(chat);
  if (!address || address.app !== 'telegram') return null;
  if (address.topic === null) return {chat_id: address.chat};
  const topic = Number(address.topic);
  return Number.isSafeInteger(topic) && topic > 0 && String(topic) === address.topic ? {chat_id: address.chat, topic} : null;
}
/** The same, for a send that must not go anywhere else: an unknown chat refuses the send. */
export function telegramTarget(chat: string | null | undefined, directory: ChatDirectory = chats()): TelegramTarget {
  const target = telegramAddress(chat, directory);
  if (!target) throw new HttpError(409, 'chat_not_found');
  return target;
}
/** The app binding a turn pass carries for a chat or topic (ADR-0250): its current app id and topic key, or null. */
export function appBindingOf(space: string | null | undefined, directory: ChatDirectory = chats()): AppBinding | null {
  const address = directory.appIds(space);
  return address ? {app: address.app, chat: address.chat, topic: address.topic} : null;
}
/** The Nocheh chat a Telegram chat id names (current or old), or that chat's topic; null when no chat row names it. */
export function telegramChat(chatId: unknown, topic?: string | number | null, directory: ChatDirectory = chats()): string | null {
  if (typeof chatId !== 'string' && typeof chatId !== 'number') return null;
  return directory.resolve('telegram', String(chatId), topic === '' ? null : topic ?? null);
}
/** Every Telegram id a chat has had (current and old), a topic counting as its chat: the archive's events.scope values
 * that hold its originals. `own` (the original at hand) is always included, so an unknown chat still reads its own id
 * and nothing more. */
export function telegramScopes(chat: string | null | undefined, own?: string | null, directory: ChatDirectory = chats()): string[] {
  return [...new Set([...(chat ? directory.rawScopes([chat], 'telegram') : []), ...(own ? [own] : [])])].sort();
}

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

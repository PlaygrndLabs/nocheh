/** Hooks and small pieces shared by the Chats page sections. */
import {useRef, useState} from 'react';
import {apiPost} from '../../lib/api';
import {refreshResources, useResource} from '../../lib/resource';
import {href} from '../../lib/routes';
import {useSettings} from '../../lib/settings';
import {useChatDirectory} from '../../lib/chat-directory';
import {
  appIds,
  chatError,
  chatName,
  unknownChat,
  type Chat,
  type Directory,
  type IdentityGroup,
} from '../../lib/chats-model';
import {Badge, Notice} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';

export const chatHref = (space: string) => href('chats', {chat: space});
export const rulesHref = (params: Record<string, string> = {}) => href('chats', {view: 'rules', ...params});
export const telegramSettingsHref = href('settings', {view: 'telegram'});
export const memoryRequestsHref = href('inbox', {kind: 'memory_access'});

/**
 * The Telegram settings that decide how Nocheh answers in a group. Changes are drafts in the shared settings store; the
 * bottom save bar saves and applies them. Which groups Nocheh is on in is no setting: it is each group's state, which its
 * switch changes at once (ADR-0253). Who may talk there is no setting either: members are kept on the Members page, where
 * every switch saves at once (step 3).
 */
export function useTelegram() {
  const settings = useSettings();
  return {
    loaded: !!settings.data,
    error: settings.error,
    busy: settings.busy,
    enabled: settings.value('TELEGRAM_ENABLED') === 'true',
    /** The owner's Telegram user ID: an account, compared with people, never a chat. */
    ownerAccount: settings.value('TELEGRAM_OWNER_ID'),
    replies: settings.value('TELEGRAM_GROUP_REPLIES') || 'addressed',
    names: settings
      .value('TELEGRAM_BOT_NAMES')
      .split(',')
      .map(name => name.trim())
      .filter(Boolean),
    topicMemory: settings.value('TELEGRAM_TOPIC_MEMORY') || 'group',
    topicMemoryChanged: settings.changed('TELEGRAM_TOPIC_MEMORY'),
    setTopicMemory(value: 'group' | 'topic') {
      settings.set('TELEGRAM_TOPIC_MEMORY', value);
    },
  };
}
export type Telegram = ReturnType<typeof useTelegram>;

/** Every chat Nocheh knows: the directory plus groups people were seen in but not listed yet. */
export function useChats(query = '') {
  const chats = useChatDirectory(30000);
  // Past the first page, a search asks the server instead of filtering what is loaded.
  const remote = useResource<Directory>(
    query.trim() && chats.more ? '/conversations?limit=100&q=' + encodeURIComponent(query.trim()) : null,
  );
  const identities = useResource<{groups: IdentityGroup[]}>('/telegram/identities', 60000);
  const items = remote.data?.items ?? chats.items;
  const find = (space: string | null | undefined): Chat | null =>
    (space && items.find(item => item.space_id === space)) || chats.find(space);
  /** Who was seen in a group, by its Nocheh id or any of its Telegram ids. */
  const seen = (chat: Chat | null | undefined) =>
    chat
      ? identities.data?.groups.find(group => group.id === chat.space_id || appIds(chat).includes(group.id))
      : undefined;
  return {...chats, directory: chats.directory, identities, items, find, seen};
}

/** A chat by its id; one the directory doesn't know is an unknown chat, named by who was seen there if anyone. */
export function useChat(space: string): Chat {
  const {find, identities} = useChats();
  const found = find(space);
  if (found) return found;
  return unknownChat(space, identities.data?.groups.find(group => group.id === space)?.name ?? null);
}

/** Names chats by id, as useChat does for one: for lists such as a project's groups. */
export function useChatNames(): (space: string) => string {
  const {find, identities} = useChats();
  return space =>
    chatName(
      find(space) ?? unknownChat(space, identities.data?.groups.find(group => group.id === space)?.name ?? null),
    );
}

/**
 * Runs one owner action right away: busy state, plain error, toast, then fresh data.
 * Retrying the same failed request reuses its operation ID so it is never applied twice.
 * `describe` puts a refusal in plain words; the Members page passes its own.
 */
export function useAction(describe: (error: unknown) => string = chatError) {
  const {toast} = useFeedback();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const operations = useRef(new Map<string, string>());
  async function run<T = any>(
    key: string,
    path: string,
    body: Record<string, unknown>,
    options: {success?: string; operation?: boolean} = {},
  ): Promise<T | null> {
    const signature = path + JSON.stringify(body);
    const operation = operations.current.get(signature) ?? crypto.randomUUID();
    operations.current.set(signature, operation);
    setBusy(key);
    setError('');
    try {
      const result = await apiPost<T>(path, options.operation === false ? body : {...body, operation_id: operation});
      operations.current.delete(signature);
      if (options.success) toast(options.success);
      void refreshResources();
      return (result ?? ({} as T)) as T;
    } catch (failure) {
      setError(describe(failure));
      return null;
    } finally {
      setBusy(null);
    }
  }
  return {busy, error, run, clear: () => setError('')};
}

export function Unsaved({show = true}: {show?: boolean}) {
  if (!show) return null;
  return (
    <Badge tone="warn" dot>
      Not saved yet
    </Badge>
  );
}

export function ActionError({text}: {text: string}) {
  if (!text) return null;
  return (
    <Notice tone="bad" className="mt-3">
      {text}
    </Notice>
  );
}

/** Hooks and small pieces shared by the Chats page sections. */
import {useRef, useState} from 'react';
import {apiPost} from '../../lib/api';
import {refreshResources, useResource} from '../../lib/resource';
import {href} from '../../lib/routes';
import {useSettings} from '../../lib/settings';
import {useChatDirectory} from '../../lib/chat-directory';
import {
  accessKey,
  appIds,
  chatError,
  chatName,
  emptyRule,
  groupListed,
  parseAccess,
  parseGroupIds,
  serializeAccess,
  serializeGroupIds,
  unknownChat,
  withGroupListed,
  withPersonDecision,
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
 * The Telegram settings that decide where Nocheh answers and who may talk to it.
 * Changes are drafts in the shared settings store; the bottom save bar saves and applies them.
 * Until step 2b-2, TELEGRAM_GROUP_IDS still lists the groups Nocheh serves by their Telegram ids, and
 * TELEGRAM_GROUP_ACCESS keeps a group's people under one of them (ADR-0251); a chat is passed whole, never its id.
 */
export function useTelegram() {
  const settings = useSettings();
  const groupIds = parseGroupIds(settings.value('TELEGRAM_GROUP_IDS'));
  const savedGroupIds = parseGroupIds(settings.saved('TELEGRAM_GROUP_IDS'));
  const access = parseAccess(settings.value('TELEGRAM_GROUP_ACCESS'));
  const savedAccess = parseAccess(settings.saved('TELEGRAM_GROUP_ACCESS'));
  const writeAccess = (next: typeof access) => serializeAccess(next, settings.saved('TELEGRAM_GROUP_ACCESS'));
  const ruleOf = (map: typeof access, chat: Chat | null | undefined) => {
    const key = accessKey(map, chat);
    return (key && map[key]) || emptyRule();
  };
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
    savedGroupIds,
    isOn: (chat: Chat | null | undefined) => groupListed(groupIds, chat),
    onChanged: (chat: Chat | null | undefined) => groupListed(groupIds, chat) !== groupListed(savedGroupIds, chat),
    rule: (chat: Chat | null | undefined) => ruleOf(access, chat),
    savedRule: (chat: Chat | null | undefined) => ruleOf(savedAccess, chat),
    /** Turning a group off also drops who was allowed there; turning it back on restores the saved list. */
    setGroup(chat: Chat, on: boolean) {
      const ids = withGroupListed(groupIds, chat, on, savedGroupIds);
      const next = {...access};
      if (on) {
        // The saved people come back under an id the group is listed by now, as the settings require.
        const from = accessKey(savedAccess, chat);
        const to = accessKey({}, chat, ids, savedAccess);
        if (from && to && savedAccess[from] && !appIds(chat).some(id => next[id])) next[to] = savedAccess[from]!;
      } else for (const id of appIds(chat)) delete next[id];
      settings.setMany({
        TELEGRAM_GROUP_IDS: serializeGroupIds(ids, settings.saved('TELEGRAM_GROUP_IDS')),
        TELEGRAM_GROUP_ACCESS: writeAccess(next),
      });
    },
    setPerson(chat: Chat, id: string, allow: boolean) {
      const key = accessKey(access, chat, groupIds, savedAccess);
      if (!key) return;
      settings.set('TELEGRAM_GROUP_ACCESS', writeAccess(withPersonDecision(access, savedAccess, key, id, allow)));
    },
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
 */
export function useAction() {
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
      setError(chatError(failure));
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

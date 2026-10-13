/** Hooks and small pieces shared by the Chats page sections. */
import {useRef, useState} from 'react';
import {apiPost} from '../../lib/api';
import {refreshResources, useResource} from '../../lib/resource';
import {href} from '../../lib/routes';
import {useSettings} from '../../lib/settings';
import {
  chatError,
  chatFromId,
  emptyRule,
  parseAccess,
  parseGroupIds,
  serializeAccess,
  serializeGroupIds,
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
 */
export function useTelegram() {
  const settings = useSettings();
  const groupIds = parseGroupIds(settings.value('TELEGRAM_GROUP_IDS'));
  const savedGroupIds = parseGroupIds(settings.saved('TELEGRAM_GROUP_IDS'));
  const access = parseAccess(settings.value('TELEGRAM_GROUP_ACCESS'));
  const savedAccess = parseAccess(settings.saved('TELEGRAM_GROUP_ACCESS'));
  const writeAccess = (next: typeof access) => serializeAccess(next, settings.saved('TELEGRAM_GROUP_ACCESS'));
  return {
    loaded: !!settings.data,
    error: settings.error,
    busy: settings.busy,
    enabled: settings.value('TELEGRAM_ENABLED') === 'true',
    owner: settings.value('TELEGRAM_OWNER_ID'),
    replies: settings.value('TELEGRAM_GROUP_REPLIES') || 'addressed',
    names: settings
      .value('TELEGRAM_BOT_NAMES')
      .split(',')
      .map(name => name.trim())
      .filter(Boolean),
    topicMemory: settings.value('TELEGRAM_TOPIC_MEMORY') || 'group',
    topicMemoryChanged: settings.changed('TELEGRAM_TOPIC_MEMORY'),
    groupIds,
    savedGroupIds,
    isOn: (group: string) => groupIds.includes(group),
    onChanged: (group: string) => groupIds.includes(group) !== savedGroupIds.includes(group),
    rule: (group: string) => access[group] ?? emptyRule(),
    savedRule: (group: string) => savedAccess[group] ?? emptyRule(),
    /** Turning a group off also drops who was allowed there; turning it back on restores the saved list. */
    setGroup(group: string, on: boolean) {
      const ids = on ? [...groupIds, group] : groupIds.filter(id => id !== group);
      const next = {...access};
      if (on) {
        if (savedAccess[group] && !next[group]) next[group] = savedAccess[group]!;
      } else delete next[group];
      settings.setMany({
        TELEGRAM_GROUP_IDS: serializeGroupIds(ids, settings.saved('TELEGRAM_GROUP_IDS')),
        TELEGRAM_GROUP_ACCESS: writeAccess(next),
      });
    },
    setPerson(group: string, id: string, allow: boolean) {
      settings.set('TELEGRAM_GROUP_ACCESS', writeAccess(withPersonDecision(access, savedAccess, group, id, allow)));
    },
    setTopicMemory(value: 'group' | 'topic') {
      settings.set('TELEGRAM_TOPIC_MEMORY', value);
    },
  };
}
export type Telegram = ReturnType<typeof useTelegram>;

/** Every chat Nocheh knows: the directory plus groups seen or turned on but not listed yet. */
export function useChats(query = '') {
  const directory = useResource<Directory>('/conversations?limit=100', 30000);
  // Past the first page, a search asks the server instead of filtering what is loaded.
  const remote = useResource<Directory>(
    query.trim() && directory.data?.next_cursor
      ? '/conversations?limit=100&q=' + encodeURIComponent(query.trim())
      : null,
  );
  const identities = useResource<{groups: IdentityGroup[]}>('/telegram/identities', 60000);
  const items = remote.data?.items ?? directory.data?.items ?? [];
  const find = (space: string): Chat | null =>
    items.find(item => item.space_id === space) ?? directory.data?.items.find(item => item.space_id === space) ?? null;
  return {directory, identities, items, find, more: !!directory.data?.next_cursor};
}

/** A chat by ID, falling back to what the ID itself says. */
export function useChat(space: string): Chat {
  const {find, identities} = useChats();
  const found = find(space);
  if (found) return found;
  const seen = identities.data?.groups.find(group => group.id === space);
  return {...chatFromId(space), name: seen?.name ?? null};
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

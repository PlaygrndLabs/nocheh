/**
 * The chat directory as the dashboard reads it (ADR-0250): every chat with what it is (private chat, group or topic,
 * its group, its app ids, whether it is the owner's), from /conversations. Nothing here works anything out from a
 * chat's id. The first 100 chats are loaded; a chat past them is looked up by itself, once, so it is still named.
 */
import {useEffect, useRef, useSyncExternalStore} from 'react';
import {apiGet} from './api';
import {useResource} from './resource';
import {appIds, groupOf, parentOf, type Chat, type Directory} from './chats-model';

const lookups = new Map<string, Chat | null>();
const asked = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => {
  version++;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const named = (chat: Chat, key: string) => chat.space_id === key || appIds(chat).includes(key);
async function lookUp(key: string) {
  if (asked.has(key)) return;
  asked.add(key);
  try {
    const page = await apiGet<Directory>('/conversations?limit=100&q=' + encodeURIComponent(key));
    lookups.set(key, page?.items?.find(item => named(item, key)) ?? null);
  } catch {
    lookups.set(key, null);
  }
  notify();
}
// Names looked up one by one are fetched again after any change, as the loaded list is.
if (typeof window !== 'undefined')
  window.addEventListener('nocheh:refresh', () => {
    lookups.clear();
    asked.clear();
    notify();
  });

export type ChatDirectoryView = ReturnType<typeof useChatDirectory>;

export function useChatDirectory(interval = 30000) {
  const directory = useResource<Directory>('/conversations?limit=100', interval);
  useSyncExternalStore(subscribe, () => version);
  const misses = useRef(new Set<string>());
  const items = directory.data?.items ?? [];
  const more = !!directory.data?.next_cursor;
  const looked = (key: string, match: (chat: Chat) => boolean): Chat | null => {
    const found = lookups.get(key);
    if (found && match(found)) return found;
    if (!lookups.has(key) && more && key.length <= 200) misses.current.add(key);
    return null;
  };
  /** A chat by its Nocheh id. */
  const find = (space: string | null | undefined): Chat | null => {
    if (!space) return null;
    return items.find(item => item.space_id === space) ?? looked(space, chat => chat.space_id === space);
  };
  /** The chat an app id names, current or old: how an archive original's raw scope is named. */
  const byAppId = (external: string | null | undefined): Chat | null => {
    if (!external) return null;
    return (
      items.find(item => appIds(item).includes(external)) ?? looked(external, chat => appIds(chat).includes(external))
    );
  };
  useEffect(() => {
    for (const key of misses.current) void lookUp(key);
    misses.current.clear();
  });
  return {
    directory,
    items,
    more,
    find,
    byAppId,
    /** A group, or one of its topics. An unknown chat is no group. */
    isGroup: (space: string | null | undefined) => groupOf(find(space), find) !== null,
    /** The group of a group or of one of its topics. */
    groupOf: (space: string | null | undefined) => groupOf(find(space), find),
    /** A topic's chat. */
    parentOf: (space: string | null | undefined) => parentOf(find(space)),
  };
}

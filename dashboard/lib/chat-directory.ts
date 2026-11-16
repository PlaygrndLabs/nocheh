/**
 * The chat directory as the dashboard reads it (ADR-0252): every chat with what it is (private chat, group or topic,
 * its group, its app ids, whether it is the owner's), from /conversations. Nothing here works anything out from a
 * chat's id. The first 100 chats are loaded; a chat past them is looked up by itself, once, so it is still named. A
 * lookup that fails is asked again a little later: until one answers, the chat is not settled, which is not the same
 * as unknown.
 */
import {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {apiGet} from './api';
import {useResource} from './resource';
import {appIds, groupOf, parentOf, type Chat, type Directory} from './chats-model';

const lookups = new Map<string, Chat | null>();
const asked = new Set<string>();
const retryAfter = 10000;
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
    // Not an answer: the chat stays unsettled and is asked again, never taken as unknown.
    setTimeout(() => {
      asked.delete(key);
      notify();
    }, retryAfter);
    return;
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
  /**
   * Whether the directory has answered what a chat is: the list is loaded and has it, or has every chat and not it, or
   * a lookup of it answered; for a topic, its chat too. A chat that isn't settled may still be a group, so it is never
   * dropped as private.
   */
  const settled = (space: string | null | undefined): boolean => {
    if (!space) return true;
    if (!directory.data) return false;
    const chat = find(space);
    if (chat) return chat.kind !== 'topic' || !chat.parent_space || settled(chat.parent_space);
    return !more || lookups.has(space);
  };
  return {
    directory,
    items,
    more,
    find,
    byAppId,
    /** A group, or one of its topics. An unknown chat is no group. */
    isGroup: (space: string | null | undefined) => groupOf(find(space), find) !== null,
    settled,
    /** A chat the directory has answered is no group: a private chat, one of its topics, or one it doesn't know. */
    notGroup: (space: string | null | undefined) => settled(space) && groupOf(find(space), find) === null,
    /** The group of a group or of one of its topics. */
    groupOf: (space: string | null | undefined) => groupOf(find(space), find),
    /** A topic's chat. */
    parentOf: (space: string | null | undefined) => parentOf(find(space)),
  };
}

/** The groups Nocheh is on in (ADR-0253): the server filters before paging, so its pages hold only them. */
const servedPath = '/conversations?kind=group&state=active&limit=100';
/** Pages read after the first: enough for any owner's groups, and never an endless loop. */
const servedPages = 20;

/** Reads up to `pages` pages of a /conversations list after `cursor`; complete when its last page said so. */
export async function readPages(
  get: (path: string) => Promise<Directory | null>,
  path: string,
  cursor: string,
  pages: number,
): Promise<{items: Chat[]; complete: boolean}> {
  const items: Chat[] = [];
  let after: string | null = cursor;
  for (let page = 0; after && page < pages; page++) {
    const next: Directory | null = await get(path + '&after=' + encodeURIComponent(after));
    items.push(...(next?.items ?? []));
    after = next?.next_cursor ?? null;
  }
  return {items, complete: !after};
}

/**
 * Every group Nocheh is on in, whatever page of the whole directory each falls on: the groups the import page offers
 * and the name refresh asks Telegram about. The first page is a shared resource; the pages after it, rare, are read
 * again each time it is.
 */
export function useServedGroups(interval = 60000) {
  const first = useResource<Directory>(servedPath, interval);
  const cursor = first.data?.next_cursor ?? null;
  const [rest, setRest] = useState<{items: Chat[]; error: string}>({items: [], error: ''});
  useEffect(() => {
    if (!cursor) return;
    let live = true;
    readPages(path => apiGet<Directory>(path), servedPath, cursor, servedPages).then(
      read => live && setRest({items: read.items, error: ''}),
      (error: unknown) =>
        live &&
        setRest(current => ({...current, error: error instanceof Error ? error.message : 'Request unavailable'})),
    );
    return () => {
      live = false;
    };
  }, [cursor, first.receivedAt]);
  const items = first.data?.items ?? [];
  const seen = new Set(items.map(chat => chat.space_id));
  return {
    items: cursor ? [...items, ...rest.items.filter(chat => !seen.has(chat.space_id))] : items,
    error: first.error || (cursor ? rest.error : ''),
  };
}

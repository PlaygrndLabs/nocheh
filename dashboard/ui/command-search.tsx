/**
 * The dashboard's search: Cmd+K (Ctrl+K) or the Search button opens it anywhere. It finds pages, tabs and settings at
 * once, and asks the server for chats, members, people, projects, tasks and schedules as the owner types. Enter or a
 * click opens the item's page and, for a setting or a schedule, shows the field or row itself.
 */
import * as React from 'react';
import {Dialog as DialogPrimitive} from 'radix-ui';
import {CornerDownLeft, Search} from 'lucide-react';
import {apiGet} from '../lib/api';
import {chatName, type Chat, type Directory} from '../lib/chats-model';
import {href} from '../lib/routes';
import {rank, scheduleRowId, staticItems, type SearchItem, type SearchTarget} from '../lib/search';
import {cn} from '../lib/utils';
import {Spinner} from './core';

const LIMIT = 5;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const searchShortcut = isMac ? '⌘K' : 'Ctrl K';

type Named = {id: string; name: string | null};
type Lists = {
  members: (Named & {username: string | null})[];
  projects: (Named & {description?: string})[];
  schedules: {id: string; profile: string; name: string; schedule: string}[];
};

/** Lists small enough to load whole once the search opens; each is matched here as the owner types. */
async function loadLists(): Promise<Lists> {
  const [members, projects, schedules] = await Promise.all([
    apiGet<{members: Lists['members']}>('/members').catch(() => null),
    apiGet<{projects: Lists['projects']}>('/projects?after=').catch(() => null),
    apiGet<{schedules: Lists['schedules']}>('/schedules').catch(() => null),
  ]);
  return {members: members?.members ?? [], projects: projects?.projects ?? [], schedules: schedules?.schedules ?? []};
}

const chatKind = (chat: Chat) =>
  chat.kind === 'topic'
    ? 'Topic' + (chat.parent_name ? ' in ' + chat.parent_name : '')
    : chat.kind === 'group'
      ? 'Group'
      : 'Private chat';

/** Chats, people and tasks are many, so the server finds them by the typed text. */
async function findOnServer(query: string, signal: AbortSignal): Promise<SearchItem[]> {
  const q = encodeURIComponent(query);
  const [chats, people, tasks] = await Promise.all([
    apiGet<Directory>(`/conversations?limit=${LIMIT}&q=${q}`, {signal}).catch(() => null),
    apiGet<{entities: Named[]}>(`/entities?kind=person&state=active&after=&q=${q}`, {signal}).catch(() => null),
    apiGet<{tasks: {id: string; title: string; state: string}[]}>(`/tasks?state=all&limit=${LIMIT}&q=${q}`, {
      signal,
    }).catch(() => null),
  ]);
  return [
    ...(chats?.items ?? []).slice(0, LIMIT).map(chat => ({
      key: 'chat:' + chat.space_id,
      group: 'Chats',
      title: chatName(chat),
      detail: chatKind(chat),
      href: href('chats', {chat: chat.space_id}),
    })),
    ...(people?.entities ?? []).slice(0, LIMIT).map(person => ({
      key: 'person:' + person.id,
      group: 'People',
      title: person.name ?? 'Unnamed person',
      detail: 'Memory › People',
      href: href('memory', {view: 'people', person: person.id}),
    })),
    ...(tasks?.tasks ?? []).slice(0, LIMIT).map(task => ({
      key: 'task:' + task.id,
      group: 'Tasks',
      title: task.title,
      detail: task.state === 'open' ? 'Task' : 'Task, ' + task.state,
      href: href('tasks', {task: task.id}),
    })),
  ];
}

function listItems(lists: Lists | null, query: string): SearchItem[] {
  if (!lists || !query.trim()) return [];
  const members = lists.members.map(member => ({
    key: 'member:' + member.id,
    group: 'Members',
    title: member.name ?? (member.username ? '@' + member.username : 'Unnamed member'),
    keywords: member.username ?? '',
    detail: 'Member',
    href: href('members', {member: member.id}),
  }));
  const projects = lists.projects.map(project => ({
    key: 'project:' + project.id,
    group: 'Projects',
    title: project.name ?? 'Unnamed project',
    detail: 'Memory › Projects',
    href: href('memory', {view: 'projects', project: project.id}),
  }));
  const schedules = lists.schedules.map(row => ({
    key: 'schedule:' + row.profile + ':' + row.id,
    group: 'Schedules',
    title: row.name,
    detail: 'Schedule',
    href: href('schedules'),
    target: {id: scheduleRowId(row)},
  }));
  return [members, projects, schedules].flatMap(group => rank(group, query).slice(0, LIMIT));
}

function findTarget(target: SearchTarget): HTMLElement | null {
  const main = document.getElementById('main');
  if (!main) return null;
  const visible = (element: Element | null): element is HTMLElement =>
    !!element && element instanceof HTMLElement && !element.closest('[hidden]') && main.contains(element);
  if ('id' in target) {
    const element = document.getElementById(target.id);
    return visible(element) ? element : null;
  }
  const wanted = target.text.trim();
  for (const element of main.querySelectorAll('h2, h3, label, legend, p'))
    if (visible(element) && element.textContent?.trim() === wanted) return element;
  return null;
}

const marks = ['ring-2', 'ring-accent', 'ring-offset-2', 'ring-offset-surface', 'rounded-md'];
const unmark = (element: HTMLElement) => {
  element.classList.remove(...marks);
  delete element.dataset.searchFound;
};

/** Once the page has drawn it, scrolls to a setting or row, puts the cursor in it if it takes one, and marks it briefly. */
export function reveal(target: SearchTarget, timeout = 4000) {
  const started = Date.now();
  const attempt = () => {
    const element = findTarget(target);
    if (!element) {
      if (Date.now() - started < timeout) setTimeout(attempt, 100);
      return;
    }
    // A label points at its field; show the row that holds both.
    const field =
      element instanceof HTMLLabelElement && element.htmlFor ? document.getElementById(element.htmlFor) : element;
    const row = (element.closest('tr, [data-setting-row]') as HTMLElement | null) ?? element;
    row.scrollIntoView({block: 'center'});
    if (field && field.matches('input, select, textarea, button')) field.focus({preventScroll: true});
    for (const old of document.querySelectorAll<HTMLElement>('[data-search-found]')) unmark(old);
    row.classList.add(...marks);
    row.dataset.searchFound = '';
    setTimeout(() => unmark(row), 1800);
  };
  setTimeout(attempt, 50);
}

function open(item: SearchItem) {
  if (location.hash === item.href) dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = item.href;
  if (item.target) reveal(item.target);
}

/** The button that opens the search, for the sidebar and the phone header. */
export function SearchButton({onClick, compact}: {onClick: () => void; compact?: boolean}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={compact ? `Search (${searchShortcut})` : undefined}
      aria-label={compact ? 'Search' : undefined}
      aria-keyshortcuts="Meta+K Control+K"
      className={cn(
        'flex items-center gap-2.5 rounded-lg border border-line bg-bg text-[13px] text-muted hover:border-line-strong hover:text-fg',
        compact ? 'size-9 justify-center' : 'h-9 w-full px-3',
      )}
    >
      <Search aria-hidden className="size-4 shrink-0" />
      {!compact && (
        <>
          <span className="flex-1 text-left">Search</span>
          <kbd className="rounded border border-line px-1.5 font-sans text-[11px]">{searchShortcut}</kbd>
        </>
      )}
    </button>
  );
}

/** Opens and closes the search with Cmd+K or Ctrl+K, from anywhere on the dashboard. */
export function useSearchShortcut(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(current => !current);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  return [open, setOpen];
}

const groupOrder = ['Pages', 'Settings', 'Chats', 'Members', 'People', 'Projects', 'Tasks', 'Schedules', 'Messages'];

export function CommandSearch({open: shown, onOpenChange}: {open: boolean; onOpenChange: (open: boolean) => void}) {
  const [typed, setTyped] = React.useState('');
  const [active, setActive] = React.useState(0);
  const [lists, setLists] = React.useState<Lists | null>(null);
  const [found, setFound] = React.useState<{query: string; items: SearchItem[]} | null>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  // Once a result is chosen, the cursor goes where the result leads, not back to what opened the search.
  const chosen = React.useRef(false);
  const fixed = React.useMemo(staticItems, []);
  const query = typed.trim();

  // Fresh lists each time the search opens, so a new member or schedule is found.
  React.useEffect(() => {
    if (!shown) return;
    setTyped('');
    setActive(0);
    setFound(null);
    chosen.current = false;
    let current = true;
    void loadLists().then(value => current && setLists(value));
    return () => {
      current = false;
    };
  }, [shown]);

  React.useEffect(() => {
    if (!shown || !query) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void findOnServer(query, controller.signal).then(items => {
        if (!controller.signal.aborted) setFound({query, items});
      });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [shown, query]);

  const searching = !!query && found?.query !== query;
  const items = React.useMemo(() => {
    if (!query) return fixed.filter(item => item.key.startsWith('page:'));
    const local = rank(fixed, query);
    const pages = local.filter(item => item.group === 'Pages').slice(0, 6);
    const settings = local.filter(item => item.group === 'Settings').slice(0, 6);
    const server = found?.items ?? [];
    const messages: SearchItem = {
      key: 'messages:' + query,
      group: 'Messages',
      title: `Search messages for “${query}”`,
      href: href('messages', {q: query}),
    };
    const all = [...pages, ...settings, ...server, ...listItems(lists, query), messages];
    return groupOrder.flatMap(group => all.filter(item => item.group === group));
  }, [fixed, query, found, lists]);

  React.useEffect(() => setActive(0), [query]);
  React.useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({block: 'nearest'});
  }, [active]);

  const choose = (item: SearchItem | undefined) => {
    if (!item) return;
    chosen.current = true;
    onOpenChange(false);
    open(item);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')) {
      event.preventDefault();
      setActive(index => (index + 1) % Math.max(items.length, 1));
    } else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')) {
      event.preventDefault();
      setActive(index => (index - 1 + items.length) % Math.max(items.length, 1));
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      choose(items[active]);
    }
  };

  let index = -1;
  return (
    <DialogPrimitive.Root open={shown} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onCloseAutoFocus={event => chosen.current && event.preventDefault()}
          className="fixed top-[12dvh] left-1/2 z-50 flex max-h-[min(70dvh,560px)] w-[calc(100vw-24px)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl focus:outline-none"
        >
          <DialogPrimitive.Title className="sr-only">Search the dashboard</DialogPrimitive.Title>
          <div className="flex items-center gap-2.5 border-b border-line px-4">
            <Search aria-hidden className="size-4 shrink-0 text-muted" />
            <input
              autoFocus
              role="combobox"
              aria-label="Search the dashboard"
              aria-expanded="true"
              aria-controls="command-search-results"
              aria-activedescendant={items[active] ? 'command-search-' + active : undefined}
              aria-autocomplete="list"
              placeholder="Pages, settings, chats, people, tasks…"
              value={typed}
              onChange={event => setTyped(event.target.value)}
              onKeyDown={onKeyDown}
              className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
            />
            {searching && <Spinner className="size-4" />}
            <kbd className="hidden rounded border border-line px-1.5 font-sans text-[11px] text-muted sm:block">
              Esc
            </kbd>
          </div>
          <div
            ref={listRef}
            id="command-search-results"
            role="listbox"
            aria-label="Results"
            className="min-h-0 flex-1 overflow-y-auto p-1.5"
          >
            {groupOrder.map(group => {
              const rows = items.filter(item => item.group === group);
              if (!rows.length) return null;
              return (
                <div key={group} role="group" aria-label={group} className="pb-1">
                  <div className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
                    {query ? group : 'Go to'}
                  </div>
                  {rows.map(item => {
                    index++;
                    const at = index;
                    const selected = at === active;
                    return (
                      <div
                        key={item.key}
                        id={'command-search-' + at}
                        data-index={at}
                        role="option"
                        aria-selected={selected}
                        onMouseMove={() => active !== at && setActive(at)}
                        onClick={() => choose(item)}
                        className={cn(
                          'flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm',
                          selected ? 'bg-accent-soft text-accent-text' : 'text-fg',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">{item.title}</span>
                        {item.detail && (
                          <span className={cn('shrink-0 truncate text-xs', selected ? 'opacity-80' : 'text-muted')}>
                            {item.detail}
                          </span>
                        )}
                        {selected && <CornerDownLeft aria-hidden className="size-3.5 shrink-0" />}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {query && !searching && items.length === 1 && (
              <p className="px-2.5 py-3 text-[13px] text-muted">No pages, settings or items match “{query}”.</p>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

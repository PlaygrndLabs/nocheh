/**
 * The tabs of each page, in order; the first one opens without `?view=`.
 * Pages and the sidebar both read them, so the two always list the same tabs.
 */
import {href, type PageId} from './routes';

export const pageTabs = {
  inbox: {waiting: 'Waiting', allowed: 'Allowed actions', history: 'History'},
  tasks: {
    open: 'Open',
    today: 'Today',
    upcoming: 'Upcoming',
    board: 'Board',
    done: 'Done',
    dropped: 'Dropped',
    archive: 'Archive',
    trash: 'Trash',
  },
  chats: {chats: 'Chats', rules: 'Sharing'},
  messages: {messages: 'Messages', import: 'Import'},
  memory: {
    facts: 'Facts',
    people: 'People',
    projects: 'Projects',
    notes: 'Assistant notes',
    longterm: 'Long-term memory',
  },
  system: {health: 'Health', work: 'Background work', backups: 'Backups', databases: 'Databases'},
  settings: {
    telegram: 'Telegram',
    models: 'Models',
    speed: 'Speed',
    privacy: 'Privacy & data',
    assistant: 'Assistant',
    tasks: 'Tasks',
    advanced: 'Advanced',
  },
} as const satisfies Partial<Record<PageId, Record<string, string>>>;

type TabPage = keyof typeof pageTabs;
export type TabId<P extends TabPage> = keyof (typeof pageTabs)[P] & string;

export function tabIds<P extends TabPage>(page: P): TabId<P>[] {
  return Object.keys(pageTabs[page]) as TabId<P>[];
}

export function tabLabel<P extends TabPage>(page: P, id: TabId<P>): string {
  return (pageTabs[page] as Record<string, string>)[id]!;
}

/** The tabs of a page as sidebar links, or none for a page without tabs. */
export function tabLinks(page: PageId): {id: string; label: string; href: string}[] {
  if (!(page in pageTabs)) return [];
  const ids = tabIds(page as TabPage);
  return ids.map((id, index) => ({
    id,
    label: tabLabel(page as TabPage, id as never),
    href: href(page, {view: index ? id : null}),
  }));
}

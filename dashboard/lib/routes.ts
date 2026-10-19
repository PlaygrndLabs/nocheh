/**
 * Addresses are `#page?view=tab&...`. Links Nocheh already sent (Telegram
 * messages, bookmarks) use older page names; they open the page and tab that
 * now hold that content, keeping their other details.
 */
export const pageIds = [
  'home',
  'inbox',
  'tasks',
  'chats',
  'messages',
  'memory',
  'usage',
  'system',
  'settings',
] as const;
export type PageId = (typeof pageIds)[number];

const aliases: Record<string, {page: PageId; view?: string}> = {
  overview: {page: 'home'},
  activity: {page: 'inbox'},
  access: {page: 'chats'},
  sharing: {page: 'chats', view: 'rules'},
  spaces: {page: 'chats', view: 'rules'},
  archive: {page: 'messages'},
  imports: {page: 'messages', view: 'import'},
  projects: {page: 'memory', view: 'projects'},
  graph: {page: 'memory', view: 'people'},
  entities: {page: 'memory', view: 'people'},
  memoryMap: {page: 'memory', view: 'people'},
  learned: {page: 'memory', view: 'facts'},
  honcho: {page: 'memory', view: 'longterm'},
  monitoring: {page: 'system'},
  integrations: {page: 'system'},
  databases: {page: 'system', view: 'databases'},
  operations: {page: 'system', view: 'backups'},
  maintenance: {page: 'system', view: 'backups'},
};

/** Tabs whose names changed; the old name in `?view=` still opens the right tab. */
const viewAliases: Partial<Record<PageId, Record<string, string>>> = {
  chats: {chats: '', requests: 'rules', shared: 'rules', defaults: 'rules'},
  messages: {messages: '', imports: 'import'},
  memory: {working: 'notes', learned: 'facts', relations: 'people', graph: 'people', honcho: 'longterm'},
  system: {health: '', connections: '', maintenance: 'backups'},
};

/**
 * The page a location hash shows. `hash` is the corrected address when the
 * given one used an old name, so the address bar can be rewritten in place.
 */
export function resolveRoute(hash: string): {page: PageId; hash: string | null} {
  const [key = '', search = ''] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(search);
  let page: PageId;
  let changed = false;
  if ((pageIds as readonly string[]).includes(key)) page = key as PageId;
  else if (aliases[key]) {
    const alias = aliases[key]!;
    // A memory-access request link opens that exact request in the Inbox.
    const request = params.get('request');
    if (request && (key === 'memoryMap' || key === 'entities'))
      return {page: 'inbox', hash: '#inbox?' + new URLSearchParams({kind: 'memory_access', decision: request})};
    page = alias.page;
    if (alias.view && !params.has('view')) params.set('view', alias.view);
    changed = true;
  } else return {page: 'home', hash: key ? '#home' : null};
  const view = params.get('view');
  // Usage was a System tab; it is its own page now.
  if (page === 'system' && view === 'usage') return {page: 'usage', hash: '#usage'};
  const renamed = view !== null ? viewAliases[page]?.[view] : undefined;
  if (renamed !== undefined) {
    if (renamed) params.set('view', renamed);
    else params.delete('view');
    changed = true;
  }
  if (!changed) return {page, hash: null};
  const query = params.toString();
  return {page, hash: '#' + page + (query ? '?' + query : '')};
}

export function currentParams(): URLSearchParams {
  return new URLSearchParams(location.hash.split('?')[1] ?? '');
}

/** A link to a page, optionally with a tab and other details. */
export function href(page: PageId, params: Record<string, string | null | undefined> = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const text = query.toString();
  return '#' + page + (text ? '?' + text : '');
}

/** Changes details of the current address without adding a history entry for each keystroke. */
export function setParams(patch: Record<string, string | null | undefined>, replace = false) {
  const [page = 'home'] = location.hash.replace(/^#/, '').split('?');
  const params = currentParams();
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === '') params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  const next = '#' + page + (query ? '?' + query : '');
  if (next === location.hash) return;
  if (replace) {
    history.replaceState(null, '', next);
    dispatchEvent(new HashChangeEvent('hashchange'));
  } else location.hash = next;
}

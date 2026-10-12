/** Dashboard pages in sidebar order, and where old bookmarks now lead. */
export const pageIds = ['home', 'inbox', 'sharing', 'memory', 'archive', 'projects', 'system', 'settings'] as const;
export type PageId = (typeof pageIds)[number];

/**
 * Old page names keep working: links already sent to Telegram, bookmarks, and
 * pages that still link by the old name. `view` selects a tab on the new page.
 */
const aliases: Record<string, {page: PageId; view?: string}> = {
  overview: {page: 'home'},
  activity: {page: 'inbox'},
  spaces: {page: 'sharing'},
  graph: {page: 'memory', view: 'graph'},
  learned: {page: 'memory', view: 'learned'},
  entities: {page: 'memory', view: 'relations'},
  memoryMap: {page: 'memory', view: 'relations'},
  honcho: {page: 'memory', view: 'honcho'},
  imports: {page: 'archive', view: 'imports'},
  monitoring: {page: 'system', view: 'health'},
  integrations: {page: 'system', view: 'connections'},
  databases: {page: 'system', view: 'databases'},
  operations: {page: 'system', view: 'maintenance'},
};

/**
 * Resolves a location hash to the page it shows. `hash` is the canonical hash
 * when the given one used an old name, so the address bar can be corrected.
 */
export function resolveRoute(hash: string): {page: PageId; hash: string | null} {
  const [key = '', search = ''] = hash.replace(/^#/, '').split('?');
  if ((pageIds as readonly string[]).includes(key)) return {page: key as PageId, hash: null};
  const alias = aliases[key];
  if (!alias) return {page: 'home', hash: key ? '#home' : null};
  const params = new URLSearchParams(search);
  if (alias.view && !params.has('view')) params.set('view', alias.view);
  const query = params.toString();
  return {page: alias.page, hash: '#' + alias.page + (query ? '?' + query : '')};
}

/** The selected tab of a page with tabs, from `?view=` in the hash. */
export function currentView<T extends string>(views: readonly T[], fallback: T): T {
  const view = new URLSearchParams(location.hash.split('?')[1] ?? '').get('view');
  return views.includes(view as T) ? (view as T) : fallback;
}

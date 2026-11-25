/**
 * What the dashboard's search (Cmd+K or Ctrl+K) finds without asking the server: every page, every tab and the
 * settings by their plain names, and how a typed text ranks them. Chats, people, tasks and other data are asked of
 * the server as the owner types (ui/command-search.tsx).
 */
import {href, pageIds, type PageId} from './routes';
import {pageTabs, pageTitles, tabLinks} from './page-tabs';

/** What to show once an item's page is open: an element by its id, or a label or heading by its exact text. */
export type SearchTarget = {id: string} | {text: string};

export type SearchItem = {
  key: string;
  group: string;
  title: string;
  /** Where it is, such as "Settings › Telegram". */
  detail?: string;
  /** Other words that find it. */
  keywords?: string;
  href: string;
  target?: SearchTarget;
};

/** A setting: its page tab, the sub-tab inside it, and the field or heading that holds it. */
type Setting = [
  title: string,
  view: keyof typeof pageTabs.settings,
  tab: string | null,
  target: SearchTarget,
  keywords?: string,
];
const id = (value: string): SearchTarget => ({id: value});
const text = (value: string): SearchTarget => ({text: value});

/** Settings by plain name. Each target is checked in a real browser (test/dashboard-pages.browser.mjs). */
const settings: Setting[] = [
  ['Telegram on/off', 'telegram', null, id('telegram-enabled'), 'bot connect turn on off'],
  ['Bot token', 'telegram', null, id('telegram-token'), 'telegram key botfather'],
  ['Your Telegram user ID', 'telegram', null, id('telegram-owner'), 'owner account'],
  ['Show typing while working', 'telegram', 'activity', id('telegram-typing')],
  ['React while working', 'telegram', 'activity', id('telegram-reactions'), 'reactions emoji'],
  ['Tell me about problems', 'telegram', 'activity', id('telegram-problem-notices'), 'notices alerts errors'],
  ['Quiet hours', 'telegram', 'activity', id('quiet-hours'), 'night silent do not disturb'],
  ['Dashboard address', 'telegram', 'activity', id('dashboard-url'), 'url link'],
  ['When Nocheh answers in groups', 'telegram', 'groups', text('When Nocheh answers'), 'group replies mention'],
  ['Names that call Nocheh', 'telegram', 'groups', id('telegram-names'), 'nickname wake word groups'],
  ['Topic memory', 'telegram', 'groups', text('Topic memory'), 'forum topics groups'],
  ['Mini app address', 'telegram', 'miniapp', id('mini-app-url'), 'url link'],
  ['Mini app tunnel token', 'telegram', 'miniapp', id('mini-app-tunnel'), 'cloudflare'],
  ['Main model', 'models', null, id('main-model'), 'default provider llm'],
  ['Replies model', 'models', null, id('reply-model'), 'answers llm'],
  ['Memory model', 'models', null, id('memory-model'), 'llm'],
  ['Secret check model', 'models', null, id('guard-model'), 'guard llm'],
  ['Backup for replies', 'models', null, id('reply-backup-model'), 'fallback model'],
  ['Memory search model', 'models', null, id('embedding-model'), 'embeddings'],
  ['Voice notes model', 'models', null, id('voice-model'), 'transcription audio speech'],
  ['Monthly spending limit', 'models', null, id('monthly-limit'), 'budget cost dollars cap money'],
  ['Providers and API keys', 'models', 'providers', text('Providers'), 'openai anthropic custom key'],
  ['Chats answered at once', 'speed', null, id('NOCHEH_PARALLEL_REPLIES'), 'parallel'],
  ['Assistant runs at once', 'speed', null, id('NOCHEH_PARALLEL_RUNS'), 'parallel'],
  ['Secret checks at once', 'speed', null, id('NOCHEH_PARALLEL_GUARD_CHECKS'), 'parallel'],
  ['Change password', 'privacy', null, id('password-current'), 'sign in login'],
  ['Signed in elsewhere', 'privacy', null, text('Signed in elsewhere'), 'sessions sign out devices'],
  ['Secret check', 'privacy', null, text('Hide secrets from the assistant'), 'guard passwords keys'],
  ['How long to keep records', 'privacy', 'records', text('How long to keep records'), 'retention history logs'],
  ['Automatic backups', 'privacy', 'records', text('Automatic backups'), 'backup time keep'],
  ['Off-site copies', 'privacy', 'offsite', text('Send off-site copies'), 'backup cloud r2 backblaze encrypted'],
  ['Acting for you', 'assistant', null, text('Acting for you'), 'autonomy approvals'],
  ['Role in your private chat', 'assistant', null, id('role-default'), 'persona skills instructions'],
  ['Role in groups', 'assistant', null, id('role-default:groups'), 'persona skills instructions'],
  ['Tools in every chat', 'assistant', 'tools', text('Tools in every chat'), 'commands web pages outside tools'],
  ['Steps per answer', 'assistant', 'tools', id('pref-agent.max_iterations'), 'limits iterations'],
  ['Notes size', 'assistant', 'tools', id('pref-memory.memory_char_limit'), 'limits characters'],
  ['Cost limit per job', 'assistant', 'jobs', id('job-cost_limit_usd'), 'background jobs dollars'],
  ['Time limit per job', 'assistant', 'jobs', id('job-minutes_limit'), 'background jobs minutes'],
  ['Member jobs spending', 'assistant', 'jobs', id('job-member_notice_usd'), 'background jobs dollars pause'],
  ['Sealed box for jobs', 'assistant', 'jobs', id('job-box-tools'), 'background jobs sandbox'],
  ['Built-in instructions', 'assistant', 'instructions', text('Built-in instructions'), 'prompts wording texts'],
  ['Task statuses', 'tasks', null, text('Statuses'), 'to do in progress done'],
  ['Task priorities', 'tasks', 'priorities', text('Priorities'), 'urgent high low'],
  ['Time zone', 'tasks', 'priorities', text('Time zone'), 'timezone clock'],
  ['Task columns', 'tasks', 'columns', text('Your columns'), 'fields'],
  ['Machine control', 'machines', null, id('machine-control'), 'vm ssh computer'],
];

/** Settings that live outside the Settings page. */
const elsewhere: {
  title: string;
  page: PageId;
  params: Record<string, string>;
  target: SearchTarget;
  keywords?: string;
}[] = [
  {
    title: 'Hide replaced facts',
    page: 'memory',
    params: {view: 'longterm', tab: 'cleanup'},
    target: id('memory-retire-old-facts'),
    keywords: 'honcho clean-up',
  },
  {title: 'Hide unused facts', page: 'memory', params: {}, target: text('Hide unused facts'), keywords: 'clean-up'},
];

const settingsTabLabel = (view: string) => (pageTabs.settings as Record<string, string>)[view]!;

/** Every page, tab and setting, in the order they show before anything is typed. */
export function staticItems(): SearchItem[] {
  const items: SearchItem[] = [];
  for (const page of pageIds) {
    items.push({key: 'page:' + page, group: 'Pages', title: pageTitles[page], href: href(page)});
    tabLinks(page).forEach((tab, index) => {
      if (index === 0) return;
      items.push({
        key: `tab:${page}:${tab.id}`,
        group: 'Pages',
        title: tab.label,
        detail: pageTitles[page],
        href: tab.href,
      });
    });
  }
  const firstView = Object.keys(pageTabs.settings)[0];
  for (const [title, view, tab, target, keywords] of settings)
    items.push({
      key: 'setting:' + title,
      group: 'Settings',
      title,
      detail: 'Settings › ' + settingsTabLabel(view),
      keywords,
      href: href('settings', {view: view === firstView ? null : view, tab}),
      target,
    });
  for (const item of elsewhere)
    items.push({
      key: 'setting:' + item.title,
      group: 'Settings',
      title: item.title,
      detail: pageTitles[item.page],
      keywords: item.keywords,
      href: href(item.page, item.params),
      target: item.target,
    });
  return items;
}

/** The element id of a schedule's row on the Schedules page, so the search can show it. */
export const scheduleRowId = (row: {profile: string; id: string}) => 'schedule-' + row.profile + '-' + row.id;

const fold = (value: string) => value.toLocaleLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/**
 * How well an item matches the typed text, or 0 when it does not: every typed word must start a word of its title,
 * place or other words. A title that starts with the text ranks first, then a title holding every word.
 */
export function score(item: Pick<SearchItem, 'title' | 'detail' | 'keywords'>, query: string): number {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const title = fold(item.title);
  const titleWords = title.split(/[^\p{L}\p{N}]+/u);
  const otherWords = fold(`${item.detail ?? ''} ${item.keywords ?? ''}`).split(/[^\p{L}\p{N}]+/u);
  const starts = (list: string[], word: string) => list.some(each => each.startsWith(word));
  if (!words.every(word => starts(titleWords, word) || starts(otherWords, word) || title.includes(word))) return 0;
  const whole = fold(query).trim();
  if (title === whole) return 100;
  if (title.startsWith(whole)) return 80;
  if (words.every(word => starts(titleWords, word))) return 60;
  if (words.every(word => title.includes(word))) return 40;
  return 20;
}

/** The items that match, best first; ties keep their order. */
export function rank<T extends Pick<SearchItem, 'title' | 'detail' | 'keywords'>>(items: T[], query: string): T[] {
  return items
    .map((item, index) => ({item, index, score: score(item, query)}))
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(row => row.item);
}

/**
 * Telegram's signed launch data for the members' app (ADR-0265 D2). Telegram hands it to the page in the address; the
 * page takes it and strips the address at once. It is kept, in this page's own sessionStorage key, only once the member
 * listener has accepted it, so an owner or a closed launch is never stored. The page never reads the owner page's keys.
 */
import {MEMBER_APP_STORAGE_KEYS} from '../../src/member-app-wire';

export type Launch = {data: string; fresh: boolean; theme: string | null};

const read = (store: () => Storage, key: string): string | null => {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
};
const write = (store: () => Storage, key: string, value: string | null) => {
  try {
    if (value === null) store().removeItem(key);
    else store().setItem(key, value);
  } catch {}
};

/** Takes the launch from the address (or this visit's kept one) and leaves the address bare. */
export function takeLaunch(): Launch {
  const hash = location.hash.replace(/^#/, '');
  const params = new URLSearchParams(hash);
  const fresh = params.get('tgWebAppData') || '';
  let theme: string | null = null;
  try {
    theme = JSON.parse(params.get('tgWebAppThemeParams') || 'null')?.bg_color ?? null;
  } catch {}
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  const data = fresh || read(() => sessionStorage, MEMBER_APP_STORAGE_KEYS.launch) || '';
  return {data, fresh: !!fresh, theme};
}

/** Keeps the launch for this visit, once the member listener accepted it. */
export const keepLaunch = (data: string) => write(() => sessionStorage, MEMBER_APP_STORAGE_KEYS.launch, data);

/** The launch is no longer accepted (too old, or signed out): this visit forgets it. */
export const dropLaunch = () => write(() => sessionStorage, MEMBER_APP_STORAGE_KEYS.launch, null);

/** What the page remembers on this phone: the last project chosen. */
export type MemberUi = {project?: string};
export function readUi(): MemberUi {
  try {
    const value = JSON.parse(read(() => localStorage, MEMBER_APP_STORAGE_KEYS.ui) || '{}');
    return typeof value?.project === 'string' && /^[a-f0-9]{64}$/.test(value.project) ? {project: value.project} : {};
  } catch {
    return {};
  }
}
export const writeUi = (ui: MemberUi) => write(() => localStorage, MEMBER_APP_STORAGE_KEYS.ui, JSON.stringify(ui));

/** Sign out, a closed app or an owner launch: forget everything this page kept, and only its own keys. */
export function forgetAll() {
  write(() => sessionStorage, MEMBER_APP_STORAGE_KEYS.launch, null);
  write(() => localStorage, MEMBER_APP_STORAGE_KEYS.ui, null);
}

/** Follows Telegram's light or dark theme when the launch gives one, else the device's. */
export function applyTheme(background: string | null) {
  const match = (background ?? '').match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  const dark = match
    ? 0.2126 * parseInt(match[1]!, 16) + 0.7152 * parseInt(match[2]!, 16) + 0.0722 * parseInt(match[3]!, 16) < 128
    : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', dark);
}

const telegramWeb = ['https://web.telegram.org', 'https://webk.telegram.org', 'https://webz.telegram.org'];
/** Tells Telegram something: that the page is ready, to take the full height, or to close the app. */
export function telegramEvent(type: 'web_app_ready' | 'web_app_expand' | 'web_app_close') {
  try {
    const proxy = (window as any).TelegramWebviewProxy;
    if (proxy?.postEvent) proxy.postEvent(type, '{}');
    else if (window.parent !== window) {
      const web = telegramWeb.find(origin => document.referrer.startsWith(origin + '/')) ?? 'https://web.telegram.org';
      window.parent.postMessage(JSON.stringify({eventType: type, eventData: {}}), web);
    }
  } catch {}
}

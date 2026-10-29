/** The one place the dashboard talks to the owner API. */
declare global {
  interface Window {
    __NOCHEH_CSRF__?: string;
    /** The Telegram Mini App's signed launch data; the mini app server checks it on every call. */
    __NOCHEH_TELEGRAM__?: string;
    /** Set instead of the CSRF value when the dashboard opens signed out: create the password, or sign in. */
    __NOCHEH_LOGIN__?: 'create' | 'sign_in';
    /** Set on the development stack, which skips the login. */
    __NOCHEH_LOGIN_OFF__?: boolean;
    /** The mini app's password sign-in for this phone. */
    __NOCHEH_MINI_SESSION__?: string;
  }
}

export const apiBase = '/api/nocheh';

export type ApiError = Error & {status?: number};

/** Fetches with the owner session cookie and CSRF header. */
export async function authedFetch(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.headers as Record<string, string> | undefined),
      'X-Nocheh-CSRF': window.__NOCHEH_CSRF__ ?? '',
      ...(window.__NOCHEH_TELEGRAM__ ? {'X-Telegram-Init-Data': window.__NOCHEH_TELEGRAM__} : {}),
      ...(window.__NOCHEH_MINI_SESSION__ ? {'X-Nocheh-Mini-Session': window.__NOCHEH_MINI_SESSION__} : {}),
    },
  });
}

/** Fetches JSON from an absolute path and throws the API error code on failure. */
export async function fetchJSON<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await authedFetch(path, options);
  const value = await response.json();
  if (!response.ok) {
    // The mini app shows its sign-in again when the password changed or the phone was signed out.
    if (response.status === 401 && /^mini_app_(?:sign_in_required|password_not_set)$/.test(value?.error))
      window.dispatchEvent(new CustomEvent('nocheh:mini-signed-out', {detail: value.error}));
    // A browser signed out elsewhere, or after a new password, opens on the sign-in screen.
    if (response.status === 401 && value?.error === 'owner_session_required' && !window.__NOCHEH_TELEGRAM__)
      location.reload();
    const error: ApiError = new Error(value?.error || 'request_failed');
    error.status = response.status;
    throw error;
  }
  return value as T;
}

/** Reads an owner API path such as `/settings`. */
export function apiGet<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  return fetchJSON<T>(apiBase + path, options);
}

/** Posts a JSON body to an owner API path. */
export function apiPost<T = any>(path: string, body: unknown, options: RequestInit = {}): Promise<T> {
  return fetchJSON<T>(apiBase + path, {
    ...options,
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...(options.headers as Record<string, string> | undefined)},
    body: JSON.stringify(body),
  });
}

/** Reads `path`, or posts `body` to it when a body is given. */
export function call<T = any>(path: string, body?: unknown, options: RequestInit = {}): Promise<T> {
  return body === undefined ? apiGet<T>(path, options) : apiPost<T>(path, body, options);
}

/** Starts a browser download of an owner API file. */
export function download(path: string, name: string): void {
  clickLink(apiBase + path + '?name=' + encodeURIComponent(name), name);
}

/** Saves a value as a JSON file in the browser. */
export function exportJSON(value: unknown, name: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'}));
  clickLink(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function clickLink(href: string, name: string) {
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

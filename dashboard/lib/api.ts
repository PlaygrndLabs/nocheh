/** The one place the dashboard talks to the owner API. */
declare global {
  interface Window {
    __NOCHEH_CSRF__?: string;
    /** The Telegram Mini App's signed launch data; the mini app server checks it on every call. */
    __NOCHEH_TELEGRAM__?: string;
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
    },
  });
}

/** Fetches JSON from an absolute path and throws the API error code on failure. */
export async function fetchJSON<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await authedFetch(path, options);
  const value = await response.json();
  if (!response.ok) {
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

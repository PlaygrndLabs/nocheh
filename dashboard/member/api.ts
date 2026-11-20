/**
 * The members' app's only way out (ADR-0265): `/api/member/<route>` with Telegram's launch data, never the owner's API,
 * a phone session or a cookie. A 401 shows the reopen screen, member_app_closed the closed screen, member_required the
 * owner's screen; the caller handles the rest (a conflict reloads the drawer).
 */
import {
  MEMBER_APP_PUBLIC_PREFIX,
  MEMBER_LAUNCH_HEADER,
  memberAppErrors,
  type MemberDetail,
  type MemberMe,
  type MemberReminder,
  type MemberTaskCommentRequest,
  type MemberTaskCreateRequest,
  type MemberTaskPage,
  type MemberTaskQuery,
  type MemberTaskUpdateRequest,
} from '../../src/member-app-wire';

export type Screen = 'reopen' | 'closed' | 'owner';
export class MemberApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** The screen an answer ends the visit with, or null. */
export function screenFor(status: number, code: string): Screen | null {
  if (status === 401) return 'reopen';
  if (status === 403 && code === memberAppErrors.closed) return 'closed';
  if (status === 403 && code === memberAppErrors.memberRequired) return 'owner';
  return null;
}

export const SCREEN_EVENT = 'nocheh:member-screen';
let launch = '';
export const useLaunch = (data: string) => {
  launch = data;
};

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(MEMBER_APP_PUBLIC_PREFIX + path, {
      method,
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        [MEMBER_LAUNCH_HEADER]: launch,
        ...(body === undefined ? {} : {'content-type': 'application/json'}),
      },
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
  } catch {
    throw new MemberApiError(0, 'unreachable');
  }
  const value = await response.json().catch(() => null);
  if (response.ok) return value as T;
  const code = typeof value?.error === 'string' ? value.error : 'http_' + response.status;
  const screen = screenFor(response.status, code);
  if (screen) window.dispatchEvent(new CustomEvent(SCREEN_EVENT, {detail: screen}));
  throw new MemberApiError(response.status, code);
}

/** One uuid per action; a retry of the same action sends the same one. */
export function operationId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The GET /tasks address for these filters; only the keys the member listener accepts. */
export function tasksPath(query: MemberTaskQuery): string {
  const params = new URLSearchParams({project: query.project});
  if (query.group) params.set('group', query.group);
  if (query.mine) params.set('mine', '1');
  if (query.trash) params.set('trash', '1');
  else if (query.state && query.state !== 'open') params.set('state', query.state);
  if (query.tag) params.set('tag', query.tag);
  if (query.cursor) params.set('cursor', query.cursor);
  return '/tasks?' + params.toString();
}

export const memberApi = {
  me: () => call<MemberMe>('GET', '/me'),
  tasks: (query: MemberTaskQuery) => call<MemberTaskPage>('GET', tasksPath(query)),
  task: (id: string) => call<MemberDetail>('GET', '/tasks/' + id),
  create: (request: MemberTaskCreateRequest) => call<MemberDetail>('POST', '/tasks', request),
  update: (id: string, request: MemberTaskUpdateRequest) => call<MemberDetail>('POST', '/tasks/' + id, request),
  comment: (id: string, request: MemberTaskCommentRequest) =>
    call<MemberDetail>('POST', '/tasks/' + id + '/comments', request),
  reminders: () => call<MemberReminder[]>('GET', '/reminders'),
  signOut: () => call<Record<string, never>>('POST', '/sign-out'),
};

/** Inbox wording, shapes and small helpers shared by its tabs and drawers. */
import {useCallback, useRef, useState} from 'react';
import {Globe, Plug, Send, Terminal, type LucideIcon} from 'lucide-react';
import {apiPost} from '../../lib/api';
import {refreshResources, useResource} from '../../lib/resource';
import type {DecisionKind} from '../../lib/supervision';
import type {Tone} from '../../ui/core';

export type Action = {
  id: string;
  event_id?: string;
  fingerprint: string;
  kind: string;
  scope: string;
  profile?: string;
  logical_profile?: string;
  arguments: any;
  result?: unknown;
  state: string;
  revision?: number;
  error_code?: string | null;
  created_at: string;
};
export type Permission = {
  id: string;
  kind: string;
  scope: string;
  arguments: any;
  remaining: number;
  expires_at: string;
  revoked_at?: string | null;
  revision?: number;
  created_at?: string;
};
export type ActionQueue = {actions: Action[]; telegram?: Action[]; permissions: Permission[]};
export type Run = {
  event_id: string;
  state: string;
  created_at: string;
  updated_at?: string;
  channel: string;
  job_name?: string;
  job_id?: string;
  profile?: string;
  scope: string;
  error_code?: string | null;
};
export type DecisionItem = {
  kind: DecisionKind;
  id: string;
  title: string;
  state: string;
  revision?: number;
  source_scope?: string | null;
  destination?: string | null;
  fingerprint?: string | null;
  /** One line on what it would do, from the server; null when the record can't say. */
  summary?: string | null;
  created_at: string;
};
export type DecisionList = {
  items: DecisionItem[];
  total: number;
  totals: Record<string, number>;
  next_cursor: string | null;
  state?: string;
};
export type DecisionDetail = DecisionItem & {detail?: any; observation?: string};

/** Short owner-facing names for each kind of decision, used on filter chips. */
export const kindNames: Record<DecisionKind, string> = {
  controlled_action: 'Actions',
  telegram_action: 'Messages',
  memory_access: 'Memory sharing',
  entity: 'People',
  knowledge: 'Organization',
};
export const decisionKinds = Object.keys(kindNames) as DecisionKind[];

export const actionNames: Record<string, string> = {
  shell: 'Run a command',
  browser: 'Open a web page',
  mcp: 'Use a connected tool',
  telegram_message: 'Send a Telegram message',
};
export const actionName = (kind: string) => actionNames[kind] ?? 'Do something outside Nocheh';
const actionIcons: Record<string, LucideIcon> = {shell: Terminal, browser: Globe, mcp: Plug, telegram_message: Send};
export const actionIcon = (kind: string): LucideIcon => actionIcons[kind] ?? Terminal;

/** The one line that says exactly what an action will do. */
export function actionSummary(action: Pick<Action, 'kind' | 'arguments'>): string {
  const args = action.arguments && typeof action.arguments === 'object' ? action.arguments : {};
  if (action.kind === 'telegram_message') return typeof args.text === 'string' ? args.text : '';
  if (action.kind === 'shell') return typeof args.command === 'string' ? args.command : '';
  if (action.kind === 'browser') return typeof args.url === 'string' ? args.url : '';
  if (action.kind === 'mcp')
    return args.operation === 'list'
      ? `List the tools at ${args.url ?? 'a connected service'}`
      : `${args.tool ?? 'A tool'} at ${args.url ?? 'a connected service'}`;
  return '';
}

/** Where a Telegram message goes, or where an action was asked for. */
export const actionPlace = (action: Action) =>
  action.kind === 'telegram_message' && typeof action.arguments?.destination === 'string'
    ? action.arguments.destination
    : action.scope;

const stateText: Record<string, [string, Tone]> = {
  proposed: ['Needs you', 'warn'],
  pending: ['Needs you', 'warn'],
  review: ['Needs you', 'warn'],
  ambiguous: ['Unclear if it ran', 'warn'],
  approved: ['Approved, starting', 'info'],
  queued: ['Approved, waiting to apply', 'info'],
  waiting: ['Waiting to apply', 'info'],
  running: ['Running', 'info'],
  captured: ['Not started', 'neutral'],
  done: ['Done', 'good'],
  applied: ['Done', 'good'],
  delivered: ['Shared', 'good'],
  confirmed: ['Confirmed', 'good'],
  rejected: ['Denied', 'neutral'],
  cancelled: ['Cancelled', 'neutral'],
  undone: ['Undone', 'neutral'],
  expired: ['Expired', 'neutral'],
  failed: ['Failed', 'bad'],
  stale: ['Can’t be applied', 'bad'],
  interrupted: ['Interrupted', 'warn'],
  suspended: ['Paused', 'warn'],
};
export const stateLabel = (state: string): [string, Tone] =>
  stateText[state] ?? [
    state ? state.charAt(0).toUpperCase() + state.slice(1).replaceAll('_', ' ') : 'Unknown',
    'neutral',
  ];

/** Plain words for an error code from the API. */
export function problemText(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error ?? '');
  if (/expired/.test(code)) return 'This request expired. Nocheh will ask again if it is still needed.';
  if (code === 'memory_fact_changed')
    return 'The fact changed after this was suggested, so it can’t be shared in this form.';
  if (/context_changed|guard/.test(code))
    return 'Secret checking changed after this was prepared, so it can’t be approved now.';
  if (code === 'action_already_started_or_closed') return 'This was already decided, or it has started.';
  if (code === 'action_delivery_denied') return 'Your security settings don’t allow sending this message.';
  if (code === 'invalid_permission_bounds') return 'Choose up to 30 days and up to 1000 uses.';
  if (code === 'entity_target_required' || code === 'active_entity_required')
    return 'Enter the ID of a person Nocheh already knows.';
  if (code === 'entity_kind_mismatch') return 'That ID belongs to something of a different kind.';
  if (/changed|conflict/.test(code)) return 'This changed somewhere else. Reload to see the latest, your text is kept.';
  if (/not_found/.test(code)) return 'This no longer exists. It may have been handled already.';
  if (/pending|busy|in_progress/.test(code)) return 'Nocheh is busy with this right now. Try again in a moment.';
  if (code === 'tools_operation_unavailable' || code === 'fixture_capability_unavailable')
    return 'This can’t be reached right now. Try again in a moment.';
  if (!code || code === 'request_failed' || /fetch|network|JSON/i.test(code))
    return 'Couldn’t reach Nocheh. Try again.';
  return 'It didn’t go through: ' + code.replaceAll('_', ' ') + '.';
}

function newOperationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

/**
 * Sends an owner command. Retrying the exact same request reuses its
 * operation id, so a request that reached the server is never applied twice.
 */
export function useCommand() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const last = useRef<{signature: string; id: string} | null>(null);
  const run = useCallback(
    async <T = any>(
      path: string,
      body: Record<string, unknown>,
      tag = 'default',
      idempotent = true,
    ): Promise<T | null> => {
      const signature = JSON.stringify([path, body]);
      if (!last.current || last.current.signature !== signature) last.current = {signature, id: newOperationId()};
      setBusy(tag);
      setError('');
      try {
        const result = await apiPost<T>(path, idempotent ? {...body, operation_id: last.current.id} : body);
        last.current = null;
        void refreshResources();
        return result;
      } catch (caught) {
        setError(problemText(caught));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [],
  );
  return {busy, error, run, clear: () => setError('')};
}

/** Chat names by Telegram space, for saying where something happens. */
export function useChatNames(): (space: string | null | undefined) => string {
  const {data} = useResource<{
    items: {space_id: string; name: string | null; kind: string; parent_name?: string | null}[];
  }>('/conversations?limit=100', 60000);
  const settings = useResource<{fields?: {key: string; value: unknown}[]}>('/settings');
  const owner = String(settings.data?.fields?.find(field => field.key === 'TELEGRAM_OWNER_ID')?.value ?? '');
  return useCallback(
    (space: string | null | undefined) => {
      if (!space) return 'Unknown chat';
      if (owner && space === owner) return 'your private chat';
      const row = data?.items?.find(item => item.space_id === space);
      if (row?.name) return row.kind === 'topic' && row.parent_name ? `${row.name} · ${row.parent_name}` : row.name;
      if (space.includes('/topic/')) return 'A topic in a group';
      return space.startsWith('-') ? 'A group chat' : 'A private chat';
    },
    [data, owner],
  );
}

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];
const relative = new Intl.RelativeTimeFormat(undefined, {numeric: 'auto', style: 'short'});
/** "5 min. ago" or "in 2 hr." */
export function fromNow(iso: string | null | undefined): string {
  if (!iso) return '';
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  if (!Number.isFinite(seconds)) return '';
  if (Math.abs(seconds) < 60) return seconds < 0 ? 'just now' : 'in under a minute';
  for (const [unit, size] of units)
    if (Math.abs(seconds) >= size || unit === 'minute') return relative.format(Math.round(seconds / size), unit);
  return '';
}
export const fullTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '');

export const byNewest = <T extends {created_at: string}>(a: T, b: T) =>
  String(b.created_at).localeCompare(String(a.created_at));

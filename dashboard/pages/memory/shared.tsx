/** Small pieces shared by the Memory tabs: saving, plain error words, chat names and evidence links. */
import {useCallback, useRef, useState} from 'react';
import {apiPost} from '../../lib/api';
import {refreshResources, useResource} from '../../lib/resource';
import {cn} from '../../lib/utils';

export const CONFLICT_TEXT = 'This changed somewhere else. Reload to see the latest, your text is kept.';

/** Plain words for an error code the owner API returns. */
export function errorWords(error: unknown): string {
  const code = String((error as Error)?.message ?? error ?? '');
  if (/conflict|changed/.test(code)) return CONFLICT_TEXT;
  const known: Record<string, string> = {
    honcho_live_acceptance_pending: 'Long-term memory hasn’t passed its checks yet, so it can’t be connected.',
    honcho_budget_requires_accepted_memory: 'Connect long-term memory first, then change the limit.',
    active_project_required: 'Choose a project that isn’t archived.',
    memory_fact_not_found: 'This fact was retired or removed.',
    entity_rename_invalid: 'Only active people can be renamed.',
    memory_correction_required: 'Type the corrected wording first.',
    invalid_entity_relationship: 'That kind of relationship can’t be used here.',
    invalid_grant_expiration: 'Choose an end date in the future.',
    invalid_organization_delegation: 'Give it a name, pick at least one chat, and an end date in the future.',
    owner_required: 'Only the owner can do this.',
    wait_for_active_jobs: 'Nocheh is busy with another job. Try again in a minute.',
    operation_in_progress: 'Nocheh is busy with another job. Try again in a minute.',
    fixture_capability_unavailable: 'This server doesn’t offer that yet.',
    not_found: 'This server doesn’t offer that yet.',
    request_failed: 'Nocheh didn’t answer. Try again.',
  };
  if (known[code]) return known[code]!;
  if (/^invalid_/.test(code)) return 'Something in the form isn’t accepted. Check it and try again.';
  if (/pending|busy/.test(code)) return 'Nocheh is busy right now. Try again in a minute.';
  if (/Failed to fetch|NetworkError|JSON/.test(code))
    return 'Couldn’t reach Nocheh. Check that it is running and try again.';
  const words = code.replace(/_/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) + '.' : 'Something went wrong. Try again.';
}

/**
 * Sends one owner change. A retry of the very same change reuses its
 * operation id so the server applies it once. On success every visible list
 * refreshes; on failure the plain error is kept for the form to show.
 */
export function useCommand() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const last = useRef<{key: string; id: string} | null>(null);
  const run = useCallback(async <T = any,>(path: string, body: Record<string, unknown>): Promise<T | null> => {
    const key = path + '\u0000' + JSON.stringify(body);
    const id = last.current?.key === key ? last.current.id : crypto.randomUUID();
    last.current = {key, id};
    setBusy(true);
    setError('');
    try {
      const result = await apiPost<T>(path, {...body, operation_id: id});
      last.current = null;
      void refreshResources();
      return result;
    } catch (failure) {
      setError(errorWords(failure));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);
  return {busy, error, run, clear: () => setError('')};
}

export type Conversation = {
  space_id: string;
  name: string | null;
  kind: string;
  parent_space?: string | null;
  parent_name?: string | null;
};

/** Chat names by their id, for showing a chat instead of a number. */
export function useChats() {
  const {data, error, loading} = useResource<{items: Conversation[]}>('/conversations?limit=100', 60000);
  const items = data?.items ?? [];
  const name = (space: string | null | undefined): string => {
    if (!space) return 'Unknown chat';
    const row = items.find(item => item.space_id === space);
    if (row) return chatName(row);
    const topic = space.match(/^(.+)\/topic\/(\d+)$/);
    if (topic) {
      const parent = items.find(item => item.space_id === topic[1]);
      return (parent ? chatName(parent) : 'Group') + ' › topic ' + topic[2];
    }
    return 'Chat ' + space;
  };
  return {items, name, error, loading};
}

export function chatName(row: Conversation): string {
  const own = row.name?.trim();
  if (row.kind === 'topic') return (row.parent_name?.trim() || 'Group') + ' › ' + (own || 'topic');
  return own || (row.kind === 'private' ? 'Private chat' : 'Group') + ' ' + row.space_id;
}

/** Links to the original messages a fact came from. */
export function EvidenceLinks({sources, className}: {sources?: {id: string}[] | null; className?: string}) {
  const list = (sources ?? []).filter(source => source?.id);
  if (!list.length) return <p className={cn('text-[13px] text-muted', className)}>No linked messages.</p>;
  return (
    <ul className={cn('flex flex-wrap gap-x-4 gap-y-1 text-[13px]', className)}>
      {list.slice(0, 12).map((source, index) => (
        <li key={source.id + index}>
          <a className="text-accent-text hover:underline" href={'#messages?source=' + encodeURIComponent(source.id)}>
            Original message {list.length > 1 ? index + 1 : ''}
          </a>
        </li>
      ))}
      {list.length > 12 && <li className="text-muted">and {list.length - 12} more</li>}
    </ul>
  );
}

/** A thin bar for "how much of something is used". */
export function Meter({
  value,
  label,
  tone = 'accent',
}: {
  value: number;
  label: string;
  tone?: 'accent' | 'warn' | 'bad';
}) {
  const percent = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      className="h-2 w-full overflow-hidden rounded-full bg-subtle"
    >
      <div
        className={cn('h-full rounded-full', tone === 'bad' ? 'bg-bad' : tone === 'warn' ? 'bg-warn' : 'bg-accent')}
        style={{width: percent + '%'}}
      />
    </div>
  );
}

/** A short date such as "12 Oct 2026, 14:05". */
export function when(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

/** Cursor pages: the stack of `after` values seen so far. */
export function useCursorPages(reset: string) {
  const [state, setState] = useState<{reset: string; pages: string[]}>({reset, pages: ['']});
  const pages = state.reset === reset ? state.pages : [''];
  return {
    after: pages.at(-1)!,
    page: pages.length - 1,
    go: (page: number, next: string | null | undefined) =>
      setState({
        reset,
        pages: page > pages.length - 1 && next ? [...pages, next] : pages.slice(0, Math.max(1, page + 1)),
      }),
  };
}

export const certainty: Record<string, {label: string; tone: 'good' | 'info' | 'warn'}> = {
  explicit: {label: 'Stated', tone: 'good'},
  supported: {label: 'Likely', tone: 'info'},
  uncertain: {label: 'Unsure', tone: 'warn'},
};

/**
 * The panels the Inbox address can open: one decision (`?kind=&decision=`),
 * one action (`?action=`) or one assistant run (`?run=`). Each keeps the copy
 * the owner first saw, so a change made elsewhere is noticed, not swapped in.
 */
import {useEffect, useState} from 'react';
import {ArrowUpRight} from 'lucide-react';
import {refreshResources, useResource} from '../../lib/resource';
import type {DecisionKind} from '../../lib/supervision';
import {Badge, Empty, LoadError, LoadingRows, Notice, Technical} from '../../ui/core';
import {ActionReview} from './action-review';
import {IdentityReview} from './identity-review';
import {KnowledgeReview} from './knowledge-review';
import {MemoryAccessReview} from './memory-access-review';
import {Fact, Facts, ReviewDrawer, type ReviewState} from './review-drawer';
import {fromNow, fullTime, stateLabel, useChatNames, type ActionQueue, type DecisionDetail, type Run} from './shared';

/** What identifies one version of a record: any difference means it changed. */
const version = (record: any) =>
  record ? [record.revision, record.state, record.status, record.fingerprint].map(v => String(v ?? '')).join('|') : '';

/** Remembers the first copy seen; `reload` adopts the latest one. */
function useFirstSeen<T>(current: T | null | undefined): [T | null, () => void] {
  const [base, setBase] = useState<T | null>(null);
  useEffect(() => {
    if (current && !base) setBase(current);
  }, [current, base]);
  return [base ?? current ?? null, () => current && setBase(current)];
}

function Missing({title, error, onClose}: {title: string; error: string; onClose: () => void}) {
  return (
    <ReviewDrawer title={/not_found/.test(error) ? 'Not found' : title} onClose={onClose}>
      {/not_found/.test(error) ? (
        <Empty title="Nothing to decide here">It was already handled, or it no longer exists.</Empty>
      ) : (
        <LoadError what="this item" onRetry={() => void refreshResources()} />
      )}
    </ReviewDrawer>
  );
}

function Loading({onClose}: {onClose: () => void}) {
  return (
    <ReviewDrawer title="Loading…" onClose={onClose}>
      <LoadingRows rows={4} />
    </ReviewDrawer>
  );
}

export function DecisionDrawer({kind, id, onClose}: {kind: DecisionKind; id: string; onClose: () => void}) {
  const res = useResource<DecisionDetail>('/decisions/' + kind + '/' + encodeURIComponent(id), 15000);
  const current = res.data && res.data.id === id ? res.data : null;
  const [shown, reload] = useFirstSeen(current);
  if (!shown)
    return res.error ? (
      <Missing title="Couldn’t open this" error={res.error} onClose={onClose} />
    ) : (
      <Loading onClose={onClose} />
    );
  const review: ReviewState = {
    changed: !!current && version(current.detail) !== version(shown.detail),
    stale: (current ?? shown).observation === 'stale',
    unavailable: !!res.error,
    onReload: reload,
  };
  const record = shown.detail;
  if (!record)
    return (
      <ReviewDrawer title={shown.title || 'Decision'} onClose={onClose}>
        <Notice tone="warn" title="Only part of this could be loaded">
          Nothing can be decided from a partial copy. Try again in a moment.
        </Notice>
      </ReviewDrawer>
    );
  if (kind === 'controlled_action' || kind === 'telegram_action')
    return <ActionReview action={record} review={review} onClose={onClose} />;
  if (kind === 'memory_access') return <MemoryAccessReview request={record} review={review} onClose={onClose} />;
  if (kind === 'entity') return <IdentityReview suggestion={record} review={review} onClose={onClose} />;
  return <KnowledgeReview proposal={record} review={review} onClose={onClose} />;
}

/**
 * One action by id. Recent actions come from the action list; an older one is
 * read through its decision record, which keeps every state.
 */
export function ActionDrawer({id, onClose}: {id: string; onClose: () => void}) {
  const queue = useResource<ActionQueue>('/tools/actions', 15000);
  const listed = [...(queue.data?.actions ?? []), ...(queue.data?.telegram ?? [])].find(action => action.id === id);
  const lookup = !listed && (!!queue.data || !!queue.error);
  const controlled = useResource<DecisionDetail>(
    lookup ? '/decisions/controlled_action/' + encodeURIComponent(id) : null,
    15000,
  );
  const telegram = useResource<DecisionDetail>(
    lookup && controlled.error ? '/decisions/telegram_action/' + encodeURIComponent(id) : null,
    15000,
  );
  const fallback = controlled.data?.detail ? controlled : telegram.data?.detail ? telegram : null;
  const current = listed ?? fallback?.data?.detail ?? null;
  const [shown, reload] = useFirstSeen(current);
  if (!shown) {
    const error = lookup && controlled.error && telegram.error ? telegram.error : '';
    return error ? (
      <Missing title="Couldn’t open this action" error={error} onClose={onClose} />
    ) : (
      <Loading onClose={onClose} />
    );
  }
  const review: ReviewState = {
    changed: !!current && version(current) !== version(shown),
    stale: fallback?.data?.observation === 'stale',
    unavailable: listed ? !!queue.error : !!fallback?.error,
    onReload: reload,
  };
  return <ActionReview action={shown} review={review} onClose={onClose} />;
}

export const runName = (run: Run) =>
  run.channel === 'scheduler' ? run.job_name || 'Scheduled job' : 'Conversation in the browser';

export function RunDrawer({id, onClose}: {id: string; onClose: () => void}) {
  const status = useResource<{archive?: {managed_runs?: Run[]}}>('/status', 15000);
  const chat = useChatNames();
  const run = status.data?.archive?.managed_runs?.find(item => item.event_id === id);
  if (!run) {
    if (!status.data && !status.error) return <Loading onClose={onClose} />;
    return (
      <ReviewDrawer title="Assistant run" onClose={onClose}>
        {status.error && !status.data ? (
          <LoadError what="assistant runs" onRetry={() => void refreshResources()} />
        ) : (
          <Empty title="Not in the recent list">Only the latest 50 runs are kept here.</Empty>
        )}
        <OriginalLink id={id} />
      </ReviewDrawer>
    );
  }
  const [label, tone] = stateLabel(run.state);
  return (
    <ReviewDrawer title={runName(run)} onClose={onClose}>
      <Badge tone={tone} dot>
        {label}
      </Badge>
      {run.error_code && (
        <Notice tone={run.state === 'failed' ? 'bad' : 'warn'} title="What went wrong">
          {run.error_code.replaceAll('_', ' ')}
        </Notice>
      )}
      <Facts>
        <Fact label="Kind">{run.channel === 'scheduler' ? 'Scheduled job' : 'Browser conversation'}</Fact>
        <Fact label="Chat">{chat(run.scope)}</Fact>
        <Fact label="Started">
          <span title={fullTime(run.created_at)}>{fromNow(run.created_at)}</span>
        </Fact>
        {run.updated_at && (
          <Fact label="Last update">
            <span title={fullTime(run.updated_at)}>{fromNow(run.updated_at)}</span>
          </Fact>
        )}
      </Facts>
      <OriginalLink id={run.event_id} />
      {run.channel === 'scheduler' && (
        <a className="flex items-center gap-1 text-sm text-accent-text hover:underline" href="/hermes/cron">
          Manage schedules in the assistant console <ArrowUpRight className="size-3.5" aria-hidden />
        </a>
      )}
      <Technical value={run} />
    </ReviewDrawer>
  );
}

function OriginalLink({id}: {id: string}) {
  return (
    <a className="block text-sm text-accent-text hover:underline" href={'#messages?source=' + encodeURIComponent(id)}>
      Open the original message
    </a>
  );
}

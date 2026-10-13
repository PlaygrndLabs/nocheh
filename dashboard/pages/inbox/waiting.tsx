/** Everything waiting for the owner's yes or no, newest first. */
import {useState} from 'react';
import {CheckCircle2, FolderTree, Send, Share2, Terminal, UserRound} from 'lucide-react';
import {useParam} from '../../lib/navigation';
import {refreshResources, useResource} from '../../lib/resource';
import {href, setParams} from '../../lib/routes';
import type {DecisionKind} from '../../lib/supervision';
import {cn} from '../../lib/utils';
import {Badge, Card, Empty, LoadError, LoadingRows, Notice, Pager} from '../../ui/core';
import {identityTitle} from './identity-review';
import {proposalEffect, proposalTitle} from './knowledge-review';
import {
  actionIcon,
  actionName,
  actionSummary,
  byNewest,
  decisionKinds,
  fromNow,
  fullTime,
  kindNames,
  stateLabel,
  useChatNames,
  type ActionQueue,
  type DecisionItem,
  type DecisionList,
} from './shared';

const icons: Record<DecisionKind, typeof Terminal> = {
  controlled_action: Terminal,
  telegram_action: Send,
  memory_access: Share2,
  entity: UserRound,
  knowledge: FolderTree,
};
const ordinary = new Set(['proposed', 'pending', 'review']);

export function Waiting() {
  const raw = useParam('filter');
  const filter = decisionKinds.includes(raw as DecisionKind) ? (raw as DecisionKind) : null;
  return <WaitingList key={filter ?? 'all'} filter={filter} />;
}

function WaitingList({filter}: {filter: DecisionKind | null}) {
  const [cursors, setCursors] = useState<string[]>(['']);
  const query = new URLSearchParams({limit: '100'});
  if (filter) query.set('kind', filter);
  if (cursors.at(-1)) query.set('after', cursors.at(-1)!);
  const list = useResource<DecisionList>('/decisions?' + query, 15000);
  const queue = useResource<ActionQueue>('/tools/actions', 15000);
  const requests = useResource<{requests?: {id: string; wording: string | null}[]}>('/memory-access/requests', 30000);
  const chat = useChatNames();
  const actions = [...(queue.data?.actions ?? []), ...(queue.data?.telegram ?? [])];
  const totals = list.data?.totals ?? {};
  const all = decisionKinds.reduce((sum, kind) => sum + (totals[kind] ?? 0), 0);
  const items = [...(list.data?.items ?? [])].sort(byNewest);

  const describe = (item: DecisionItem): {title: string; summary: string; where: string} => {
    const action = actions.find(a => a.id === item.id);
    switch (item.kind) {
      case 'controlled_action':
        return {
          title: actionName(item.title),
          summary: action ? actionSummary(action) : '',
          where: item.source_scope ? 'Asked in ' + chat(item.source_scope) : '',
        };
      case 'telegram_action':
        return {
          title: 'Send a Telegram message',
          summary: action ? actionSummary(action) : '',
          where: item.destination ? 'To ' + chat(item.destination) : '',
        };
      case 'memory_access':
        return {
          title: 'Share a fact with ' + chat(item.destination),
          summary: requests.data?.requests?.find(r => r.id === item.id)?.wording ?? '',
          where: '',
        };
      case 'entity':
        return {
          title: identityTitle(undefined, item.title),
          summary: 'Nocheh noticed this name in a conversation.',
          where: '',
        };
      default:
        return {
          title: proposalTitle(item.title),
          summary: proposalEffect(item.title),
          where: item.source_scope ? 'Suggested in ' + chat(item.source_scope) : '',
        };
    }
  };

  const chips: {id: DecisionKind | null; label: string; count: number}[] = [
    {id: null, label: 'All', count: all},
    ...decisionKinds
      .filter(kind => (totals[kind] ?? 0) > 0 || kind === filter)
      .map(kind => ({id: kind, label: kindNames[kind], count: totals[kind] ?? 0})),
  ];

  return (
    <div className="space-y-4">
      {list.data && all > 0 && chips.length > 2 && (
        <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
          {chips.map(chip => (
            <button
              key={chip.id ?? 'all'}
              type="button"
              aria-pressed={filter === chip.id}
              onClick={() => setParams({filter: chip.id})}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors',
                filter === chip.id
                  ? 'border-accent bg-accent-soft text-accent-text'
                  : 'border-line bg-surface text-muted hover:border-line-strong hover:text-fg',
              )}
            >
              {chip.label}
              <span className="tabular text-xs opacity-80">{chip.count}</span>
            </button>
          ))}
        </div>
      )}

      {list.error && <LoadError what="what’s waiting" onRetry={() => void refreshResources()} />}
      {list.data?.state === 'partial' && (
        <Notice tone="warn" title="Some things couldn’t be checked">
          This list may be missing items. It fills in when everything answers again.
        </Notice>
      )}

      <Card>
        {!list.data ? (
          list.error ? (
            <Empty title="Waiting items are unavailable">Nocheh didn’t answer. Try again in a moment.</Empty>
          ) : (
            <LoadingRows rows={4} />
          )
        ) : items.length === 0 ? (
          filter ? (
            <Empty
              icon={CheckCircle2}
              title={`No ${kindNames[filter].toLowerCase()} waiting`}
              action={
                <a className="text-sm text-accent-text hover:underline" href={href('inbox')}>
                  Show everything
                </a>
              }
            />
          ) : (
            <Empty icon={CheckCircle2} title="Nothing needs you right now">
              When Nocheh wants to send a message, run something, share a fact or reorganize your memory, it asks here
              first.
            </Empty>
          )
        ) : (
          <ul className="divide-y divide-line" aria-label="Waiting for you">
            {items.map(item => {
              const Icon =
                item.kind === 'controlled_action' ? actionIcon(item.title) : (icons[item.kind] ?? CheckCircle2);
              const {title, summary, where} = describe(item);
              const [label, tone] = stateLabel(item.state);
              return (
                <li key={item.kind + ':' + item.id}>
                  <a
                    href={href('inbox', {filter, kind: item.kind, decision: item.id})}
                    className="flex gap-3 px-4 py-3.5 transition-colors hover:bg-subtle sm:px-5"
                  >
                    <span
                      aria-hidden
                      className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text"
                    >
                      <Icon className="size-[18px]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-sm font-medium">{title}</span>
                        <span className="shrink-0 text-xs text-muted" title={fullTime(item.created_at)}>
                          {fromNow(item.created_at)}
                        </span>
                      </span>
                      {summary && (
                        <span dir="auto" className="mt-0.5 line-clamp-2 text-[13px] break-words text-muted">
                          {summary}
                        </span>
                      )}
                      {(where || !ordinary.has(item.state)) && (
                        <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                          {!ordinary.has(item.state) && <Badge tone={tone}>{label}</Badge>}
                          {where && <span>{where}</span>}
                        </span>
                      )}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
        {list.data && (
          <Pager
            page={cursors.length - 1}
            hasNext={!!list.data.next_cursor}
            onPage={page =>
              setCursors(current =>
                page < current.length - 1 ? current.slice(0, page + 1) : [...current, list.data!.next_cursor!],
              )
            }
            summary={cursors.length > 1 || list.data.next_cursor ? `${list.data.total} waiting in all` : undefined}
          />
        )}
      </Card>
    </div>
  );
}

/** What Nocheh did: decided actions and their results, and assistant runs. */
import {useState, type ReactNode} from 'react';
import {Bot, CalendarClock, History as HistoryIcon, MessageSquare} from 'lucide-react';
import {refreshResources, useResource} from '../../lib/resource';
import {href} from '../../lib/routes';
import {Badge, Card, CardHeader, Empty, LoadError, LoadingRows, Pager} from '../../ui/core';
import {runName} from './drawers';
import {
  actionIcon,
  actionName,
  actionPlace,
  actionSummary,
  byNewest,
  fromNow,
  fullTime,
  stateLabel,
  useChatNames,
  type ActionQueue,
  type Run,
} from './shared';

const PAGE = 15;

export function History() {
  const queue = useResource<ActionQueue>('/tools/actions', 15000);
  const status = useResource<{archive?: {managed_runs?: Run[]}}>('/status', 15000);
  const chat = useChatNames();
  const [actionPage, setActionPage] = useState(0);
  const [runPage, setRunPage] = useState(0);
  const actions = [...(queue.data?.actions ?? []), ...(queue.data?.telegram ?? [])]
    .filter(action => action.state !== 'proposed')
    .sort(byNewest);
  const runs = [...(status.data?.archive?.managed_runs ?? [])].sort(byNewest);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Actions" description="Messages and actions you decided on, and how they turned out." />
        <div className="pt-3">
          {queue.error && <LoadError className="mx-5 mb-3" what="actions" onRetry={() => void refreshResources()} />}
          {!queue.data ? (
            queue.error ? null : (
              <LoadingRows rows={3} />
            )
          ) : actions.length === 0 ? (
            <Empty icon={HistoryIcon} title="No decided actions yet">
              After you approve or deny something in Waiting, it shows here with its result.
            </Empty>
          ) : (
            <ul className="divide-y divide-line border-t border-line">
              {actions.slice(actionPage * PAGE, (actionPage + 1) * PAGE).map(action => {
                const [label, tone] = stateLabel(action.state);
                const Icon = actionIcon(action.kind);
                return (
                  <li key={action.id}>
                    <Row
                      href={href('inbox', {view: 'history', action: action.id})}
                      icon={<Icon className="size-4" />}
                      title={actionName(action.kind)}
                      summary={actionSummary(action)}
                      meta={(action.kind === 'telegram_message' ? 'To ' : 'In ') + chat(actionPlace(action))}
                      badge={<Badge tone={tone}>{label}</Badge>}
                      time={action.created_at}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <Pager page={actionPage} hasNext={(actionPage + 1) * PAGE < actions.length} onPage={setActionPage} />
      </Card>

      <Card>
        <CardHeader
          title="Assistant runs"
          description="Scheduled jobs and conversations in the browser, latest 50."
          action={
            <a className="text-[13px] text-accent-text hover:underline" href="/hermes/cron">
              Manage schedules
            </a>
          }
        />
        <div className="pt-3">
          {status.error && (
            <LoadError className="mx-5 mb-3" what="assistant runs" onRetry={() => void refreshResources()} />
          )}
          {!status.data ? (
            status.error ? null : (
              <LoadingRows rows={3} />
            )
          ) : runs.length === 0 ? (
            <Empty icon={Bot} title="No runs yet">
              Scheduled jobs and browser conversations with the assistant show here.
            </Empty>
          ) : (
            <ul className="divide-y divide-line border-t border-line">
              {runs.slice(runPage * PAGE, (runPage + 1) * PAGE).map(run => {
                const [label, tone] = stateLabel(run.state);
                const Icon = run.channel === 'scheduler' ? CalendarClock : MessageSquare;
                return (
                  <li key={run.event_id}>
                    <Row
                      href={href('inbox', {view: 'history', run: run.event_id})}
                      icon={<Icon className="size-4" />}
                      title={runName(run)}
                      summary={run.error_code ? run.error_code.replaceAll('_', ' ') : ''}
                      meta={'In ' + chat(run.scope)}
                      badge={<Badge tone={tone}>{label}</Badge>}
                      time={run.created_at}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <Pager page={runPage} hasNext={(runPage + 1) * PAGE < runs.length} onPage={setRunPage} />
      </Card>
    </div>
  );
}

function Row({
  href: link,
  icon,
  title,
  summary,
  meta,
  badge,
  time,
}: {
  href: string;
  icon: ReactNode;
  title: string;
  summary: string;
  meta: string;
  badge: ReactNode;
  time: string;
}) {
  return (
    <a href={link} className="flex gap-3 px-4 py-3 transition-colors hover:bg-subtle sm:px-5">
      <span aria-hidden className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-subtle text-muted">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="truncate text-sm font-medium">{title}</span>
          <span className="shrink-0 text-xs text-muted" title={fullTime(time)}>
            {fromNow(time)}
          </span>
        </span>
        {summary && (
          <span dir="auto" className="mt-0.5 block truncate text-[13px] text-muted">
            {summary}
          </span>
        )}
        <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
          {badge}
          <span>{meta}</span>
        </span>
      </span>
    </a>
  );
}

/** System › Background work: the assistant's jobs, the tasks behind the scenes with each one's detail, and their history. */
import {lazy, Suspense, useState, type ReactNode} from 'react';
import {ArrowUpRight, ListChecks} from 'lucide-react';
import {apiPost} from '../../lib/api';
import {useParam, useSubTab} from '../../lib/navigation';
import {refreshResources, useResource} from '../../lib/resource';
import {href, setParams} from '../../lib/routes';
import {workCounts, workers} from '../../lib/system-health';
import {cn} from '../../lib/utils';
import {
  ago,
  controlError,
  count,
  dateTime,
  families,
  familyName,
  readable,
  reason,
  reasonHeading,
  runState,
  runStates,
  timeZone,
  waitingReason,
} from '../../lib/system-format';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  LoadError,
  LoadingRows,
  Notice,
  Pager,
  Segmented,
  Select,
  Skeleton,
  Table,
  Td,
  Technical,
  Th,
  type Tone,
} from '../../ui/core';
import {Drawer, useFeedback} from '../../ui/overlay';
import type {Metrics} from './work-charts';
import {LinkButton} from '../../ui/link-button';
import {SubPanel, SubTabs} from '../../ui/page';
import {BackgroundJobs} from './jobs';

const WorkCharts = lazy(() => import('./work-charts'));

const sentence = (text: string) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : '');

const subTabs = ['jobs', 'tasks', 'history'] as const;

function KindSelect({kind}: {kind: string}) {
  return (
    <Select
      aria-label="Kind of work"
      className="h-8 w-44 text-[13px]"
      value={kind}
      onChange={e => setParams({kind: e.target.value}, true)}
    >
      <option value="">All kinds</option>
      {Object.entries(families).map(([id, label]) => (
        <option key={id} value={id}>
          {label}
        </option>
      ))}
    </Select>
  );
}

export function WorkView() {
  const monitoring = useResource<any>('/monitoring', 10000);
  const health = monitoring.data?.workflows;
  const counts = workCounts(health);
  const kind = useParam('kind') ?? '';
  const status = useParam('status') ?? '';
  const [tab, setTab] = useSubTab(subTabs);
  return (
    <>
      {monitoring.error && !monitoring.data && <LoadError what="background work" />}
      {monitoring.error && monitoring.data && (
        <Notice tone="warn" title="These numbers may be out of date">
          The latest check didn’t answer, so this shows the last known state.
        </Notice>
      )}
      {monitoring.data && !counts.available && (
        <Notice tone="warn" title="Background work couldn’t be checked">
          Counts and failures are unknown right now. They will appear when the scheduler answers.
        </Notice>
      )}
      <SubTabs
        label="Background work"
        value={tab}
        onChange={setTab}
        tabs={[
          {id: 'jobs', label: 'Jobs'},
          {id: 'tasks', label: 'Tasks', count: counts.failed + counts.uncertain || null},
          {id: 'history', label: 'History'},
        ]}
      />
      {/* Only the open sub-tab is on the page: nothing here is edited, and charts can't draw while hidden. */}
      {tab === 'jobs' && (
        <SubPanel id="jobs" current={tab}>
          <BackgroundJobs />
        </SubPanel>
      )}
      {tab === 'tasks' && (
        <SubPanel id="tasks" current={tab}>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
            <Runs key={kind + ':' + status} kind={kind} status={status} />
            <div className="space-y-5 max-lg:order-first">
              <RightNow health={health} loaded={!!monitoring.data} />
              <Waiting health={health} />
            </div>
          </div>
        </SubPanel>
      )}
      {tab === 'history' && (
        <SubPanel id="history" current={tab}>
          <History kind={kind} counts={counts.available ? health.counts : null} />
        </SubPanel>
      )}
      <RunDrawer />
    </>
  );
}

/** A small table of a name, a line under it, and a figure at the right. */
function Figures({
  label,
  rows,
}: {
  label: string;
  rows: {name: string; hint?: ReactNode; value: ReactNode; tone?: Tone}[];
}) {
  return (
    <Table aria-label={label}>
      <tbody>
        {rows.map(row => (
          <tr key={row.name} className="last:[&>*]:border-b-0">
            <Th scope="row" className="bg-transparent py-2 text-[13px] font-normal whitespace-normal text-fg">
              {row.name}
              {row.hint && <span className="block text-xs text-muted">{row.hint}</span>}
            </Th>
            <Td
              className={cn(
                'tabular py-2 text-right font-semibold whitespace-nowrap',
                row.tone === 'bad' && 'text-bad',
                row.tone === 'warn' && 'text-warn',
              )}
            >
              {row.value}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** The totals of every kind of work, whatever the list is filtered to. */
function RightNow({health, loaded}: {health: any; loaded: boolean}) {
  const counts = workCounts(health);
  const team = workers(health);
  const show = (value: number) => (counts.available ? count(value) : '—');
  const rows: {family: string; state: string; count: number}[] = counts.available ? health.counts : [];
  const denied = rows.filter(row => row.state === 'denied').reduce((n, row) => n + row.count, 0);
  const backlog: number | null = typeof health?.outbox?.pending === 'number' ? health.outbox.pending : null;
  return (
    <Card>
      <CardHeader
        title="Right now"
        description="Counts every kind of work."
        action={
          <LinkButton href="/inngest/runs" variant="ghost" size="sm" external>
            Scheduler console <ArrowUpRight aria-hidden />
          </LinkButton>
        }
      />
      <div className="mt-3 border-t border-line">
        {!loaded ? (
          <LoadingRows rows={5} />
        ) : (
          <Figures
            label="Right now"
            rows={[
              {name: 'Running', hint: 'Working on it now', value: show(counts.running)},
              {
                name: 'Waiting',
                hint: `${count(counts.queued)} queued · ${count(counts.waiting)} waiting on something`,
                value: show(counts.queued + counts.waiting),
                tone: counts.waiting ? 'warn' : undefined,
              },
              {
                name: 'Failed',
                hint: `${count(counts.retrying)} will retry · ${count(counts.uncertain)} uncertain`,
                value: show(counts.failed + counts.retrying),
                tone: counts.failed ? 'bad' : counts.retrying ? 'warn' : undefined,
              },
              {
                name: 'Last finished',
                hint: team.total ? `${team.connected} of ${team.total} workers connected` : 'No workers registered',
                value: counts.available && health?.last_success_at ? ago(health.last_success_at) : '—',
                tone: team.connected < team.total ? 'warn' : undefined,
              },
              {
                name: 'Backlog',
                hint: backlog === null ? 'Couldn’t be checked' : 'Not yet handed to the scheduler',
                value: backlog === null ? '—' : count(backlog),
                tone: backlog ? 'warn' : undefined,
              },
            ]}
          />
        )}
      </div>
      {counts.available && denied > 0 && (
        <p className="border-t border-line px-5 py-3 text-xs text-muted">
          {count(denied)} {denied === 1 ? 'task was' : 'tasks were'} denied or refused. They are closed, not failed.
        </p>
      )}
    </Card>
  );
}

function Waiting({health}: {health: any}) {
  const counts = workCounts(health);
  const reasons: any[] = Array.isArray(health?.waiting_reasons) ? health.waiting_reasons : [];
  const byFamily: {family: string; count: number; oldest: string | null}[] = Array.isArray(health?.waiting_families)
    ? health.waiting_families
    : [];
  if (!(counts.queued + counts.waiting > 0 && reasons.length > 0)) return null;
  return (
    <Card>
      <CardHeader
        title="Why work is waiting"
        description={health?.oldest_waiting ? `Oldest has waited since ${dateTime(health.oldest_waiting)}.` : undefined}
      />
      <div className="mt-3 border-t border-line">
        <Figures
          label="By reason"
          rows={reasons.slice(0, 5).map(row => ({name: waitingReason(row), value: count(row.count)}))}
        />
      </div>
      {byFamily.length > 0 && (
        <div className="border-t border-line">
          <Figures
            label="By kind of work"
            rows={byFamily.slice(0, 5).map(row => ({
              name: familyName(row.family),
              hint: row.oldest ? `Oldest: ${ago(row.oldest)}` : undefined,
              value: count(row.count),
            }))}
          />
        </div>
      )}
      <p className="border-t border-line px-5 py-3 text-xs text-muted">
        These count tasks, not messages: one message can start several tasks.
      </p>
    </Card>
  );
}

function History({kind, counts}: {kind: string; counts: any[] | null}) {
  const [range, setRange] = useState<'24h' | '7d'>('24h');
  const {data, error, loading} = useResource<Metrics>(
    '/workflows/metrics?' + new URLSearchParams({range, family: kind}),
    60000,
  );
  const current = data && data.range === range && (data.family ?? '') === kind ? data : null;
  return (
    <Card>
      <CardHeader
        title="History"
        description={`Times in ${timeZone()}. ${range === '24h' ? 'One bar per hour.' : 'One bar per 6 hours.'}`}
        action={
          <>
            <KindSelect kind={kind} />
            <Segmented
              size="sm"
              label="History period"
              value={range}
              onChange={setRange}
              options={[
                {value: '24h', label: '24 hours'},
                {value: '7d', label: '7 days'},
              ]}
            />
          </>
        }
      />
      <div className="px-5 py-4">
        {error && <LoadError what="history" className="mb-4" />}
        {!current ? (
          error ? null : (
            <Skeleton className="h-64 w-full" />
          )
        ) : (
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <WorkCharts metrics={current} counts={counts} />
          </Suspense>
        )}
        {current && (
          <p className="mt-3 text-xs text-muted">
            Updated {ago(current.observed_at)}
            {loading ? ' · refreshing…' : ' · every minute'}
          </p>
        )}
      </div>
    </Card>
  );
}

function Runs({kind, status}: {kind: string; status: string}) {
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const after = pages.at(-1);
  const query = new URLSearchParams({
    limit: '10',
    ...(kind ? {family: kind} : {}),
    ...(status ? {state: status} : {}),
    ...(after ? {after} : {}),
  });
  const {data, error} = useResource<any>('/workflows?' + query, 10000);
  const rows: any[] = data?.workflows ?? [];
  return (
    <Card>
      <CardHeader
        title="Tasks"
        description="Newest first. Open one to see its steps, or retry or cancel it."
        action={
          <>
            <KindSelect kind={kind} />
            <Select
              aria-label="Status"
              className="h-8 w-44 text-[13px]"
              value={status}
              onChange={e => setParams({status: e.target.value}, true)}
            >
              <option value="">Any status</option>
              {Object.entries(runStates).map(([id, state]) => (
                <option key={id} value={id}>
                  {state.label}
                </option>
              ))}
            </Select>
          </>
        }
      />
      <div className="mt-3">
        {error && (
          <div className="px-5 pb-3">
            <LoadError what="tasks" />
          </div>
        )}
        {!data && !error ? (
          <LoadingRows rows={6} />
        ) : data && !rows.length ? (
          <Empty icon={ListChecks} title={kind || status ? 'No tasks match' : 'No background work yet'}>
            {kind || status
              ? 'Try another kind or status.'
              : 'Tasks appear here when Nocheh replies, imports chats or updates memory.'}
          </Empty>
        ) : rows.length ? (
          <>
            <Table aria-label="Background tasks">
              <thead>
                <tr>
                  <Th scope="col">Task</Th>
                  <Th scope="col">Status</Th>
                  <Th scope="col" className="hidden md:table-cell">
                    Step
                  </Th>
                  <Th scope="col" className="hidden text-right sm:table-cell">
                    Tries
                  </Th>
                  <Th scope="col" className="hidden sm:table-cell">
                    Updated
                  </Th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const state = runState(row.state);
                  return (
                    <tr
                      key={row.id}
                      className="cursor-pointer hover:bg-subtle/60"
                      onClick={() => setParams({run: row.id})}
                    >
                      <Td className="min-w-44">
                        <button
                          type="button"
                          className="text-left font-medium hover:underline"
                          onClick={() => setParams({run: row.id})}
                        >
                          {familyName(row.family)}
                        </button>
                        {row.waiting_reason && <p className="text-xs text-muted">{reason(row.waiting_reason)}</p>}
                        <p className="text-xs text-muted sm:hidden">Updated {ago(row.updated_at)}</p>
                      </Td>
                      <Td>
                        <Badge tone={state.tone}>{state.label}</Badge>
                      </Td>
                      <Td className="hidden min-w-32 text-muted md:table-cell">
                        {sentence(readable(row.stage)) || '—'}
                        {row.total != null && (
                          <span className="block text-xs">
                            {count(row.completed)} of {count(row.total)} done
                          </span>
                        )}
                      </Td>
                      <Td className="tabular hidden text-right sm:table-cell">{row.attempts}</Td>
                      <Td className="hidden whitespace-nowrap text-muted sm:table-cell">
                        <time dateTime={row.updated_at} title={dateTime(row.updated_at)}>
                          {ago(row.updated_at)}
                        </time>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <Pager
              page={pages.length - 1}
              hasNext={!!data?.next}
              onPage={page =>
                setPages(current => (page > current.length - 1 ? [...current, data.next] : current.slice(0, page + 1)))
              }
              summary={`Page ${pages.length} · updates every 10 seconds`}
            />
          </>
        ) : null}
      </div>
    </Card>
  );
}

function RunDrawer() {
  const id = useParam('run');
  const valid = !!id && /^[a-f0-9]{64}$/.test(id);
  const {data, error} = useResource<any>(valid ? '/workflows/' + id : null, 10000);
  const {toast, confirm} = useFeedback();
  const [busy, setBusy] = useState<'' | 'retry' | 'cancel'>('');
  const [problem, setProblem] = useState('');
  const detail = data?.id === id ? data : null;
  const close = () => {
    setProblem('');
    setParams({run: null});
  };
  const control = async (action: 'retry' | 'cancel') => {
    if (
      action === 'cancel' &&
      !(await confirm({
        title: 'Cancel this task?',
        body: 'It stops and won’t run again. You can’t undo this.',
        confirm: 'Cancel task',
        danger: true,
      }))
    )
      return;
    setBusy(action);
    setProblem('');
    try {
      await apiPost('/workflows/' + detail.id + '/' + action, {revision: detail.revision});
      toast(action === 'retry' ? 'Task queued to run again' : 'Task cancelled');
    } catch (err) {
      setProblem(controlError(err instanceof Error ? err.message : ''));
    } finally {
      setBusy('');
      void refreshResources();
    }
  };
  const state = detail ? runState(detail.state) : null;
  const facts: [string, ReactNode][] = detail
    ? [
        ['Started', dateTime(detail.created_at)],
        ['Updated', dateTime(detail.updated_at)],
        ['Step', sentence(readable(detail.stage)) || '—'],
        ['Tries', String(detail.attempts ?? '—')],
        ...(detail.waiting_reason
          ? ([[reasonHeading(detail.state), reason(detail.waiting_reason)]] as [string, string][])
          : []),
        ...(detail.total != null
          ? ([['Progress', `${count(detail.completed)} of ${count(detail.total)} done`]] as [string, string][])
          : []),
      ]
    : [];
  return (
    <Drawer
      open={!!id}
      onOpenChange={open => !open && close()}
      title={detail ? familyName(detail.family) : 'Task'}
      description={detail ? `Updated ${ago(detail.updated_at)}` : undefined}
      footer={
        detail && (
          <>
            <Button
              variant="primary"
              busy={busy === 'retry'}
              disabled={!!busy || !detail.can_retry}
              onClick={() => control('retry')}
            >
              Retry now
            </Button>
            <Button
              variant="danger"
              busy={busy === 'cancel'}
              disabled={!!busy || !detail.can_cancel}
              onClick={() => control('cancel')}
            >
              Cancel task
            </Button>
          </>
        )
      }
    >
      {!valid ? (
        <Notice tone="warn" title="This task can’t be found">
          The link may be incomplete.
        </Notice>
      ) : error && !detail ? (
        <LoadError what="this task" />
      ) : !detail ? (
        <LoadingRows rows={4} />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={state!.tone} dot>
              {state!.label}
            </Badge>
            {detail.source_event_id && (
              <a
                className="text-sm text-accent-text hover:underline"
                href={href('messages', {source: detail.source_event_id})}
              >
                Open the message
              </a>
            )}
          </div>
          {problem && <Notice tone="bad">{problem}</Notice>}
          {error && <Notice tone="warn">This may be out of date. Check again before retrying.</Notice>}
          {!detail.can_retry && !detail.can_cancel && detail.control_reason && (
            <p className="text-[13px] text-muted">{sentence(reason(detail.control_reason))}.</p>
          )}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted">{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <section>
            <h3 className="mb-2 text-sm font-semibold">Steps with outside effects</h3>
            {!detail.receipts?.length ? (
              <p className="text-[13px] text-muted">No step has had an outside effect yet.</p>
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {detail.receipts.map((receipt: any) => (
                  <li key={receipt.step + ':' + receipt.attempt} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <p>{sentence(readable(receipt.step))}</p>
                      <p className="text-xs text-muted">
                        Try {receipt.attempt} · {dateTime(receipt.updated_at)}
                      </p>
                    </div>
                    <Badge
                      tone={
                        receipt.state === 'done'
                          ? 'good'
                          : receipt.state === 'ambiguous'
                            ? 'warn'
                            : receipt.state === 'failed'
                              ? 'bad'
                              : 'neutral'
                      }
                    >
                      {sentence(readable(receipt.state))}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {detail.runs?.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">Scheduler runs</h3>
              <ul className="space-y-1 text-sm">
                {detail.runs.slice(0, 10).map((run: any) => (
                  <li key={run.run_id} className="flex flex-wrap justify-between gap-2">
                    <a
                      className="text-accent-text hover:underline"
                      href={'/inngest/run?runID=' + encodeURIComponent(run.run_id)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Run {run.dispatch} <ArrowUpRight className="inline size-3.5" aria-hidden />
                    </a>
                    <span className="text-xs text-muted">{dateTime(run.seen_at)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {detail.controls?.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">Your actions</h3>
              <ul className="space-y-1 text-sm">
                {detail.controls.map((item: any) => (
                  <li key={item.revision + ':' + item.action} className="flex justify-between gap-2">
                    <span>{item.action === 'retry' ? 'Retried' : 'Cancelled'}</span>
                    <span className="text-xs text-muted">{dateTime(item.created_at)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Technical value={detail} />
        </div>
      )}
    </Drawer>
  );
}

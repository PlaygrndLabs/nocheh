import {useState, useRef} from 'react';
import {Activity, Clock3, CircleX, CircleCheck, Inbox, type LucideIcon} from 'lucide-react';
import {useResource, refreshResources} from '../lib/resource';
import {StatusBadge} from './status';
import {Button, Sheet, Table, EmptyState, Progress} from './ui/primitives';

type Call = (path: string, body?: unknown) => Promise<any>;

const time = (value: string | null | undefined) => (value ? new Date(value).toLocaleString() : '—');
const families: Record<string, string> = {
  preparation: 'Source preparation',
  telegram: 'Telegram',
  imports: 'Imports',
  memory_review: 'Memory review',
  honcho: 'Honcho',
  browser: 'Browser turns',
  schedules: 'Schedules',
  actions: 'Approved messages',
  tools: 'Controlled tools',
  organization: 'Knowledge organization',
};
const states: Record<string, string> = {
  queued: 'Queued',
  waiting: 'Waiting',
  running: 'Running',
  retryable_failed: 'Failed · retry scheduled',
  completed: 'Completed',
  failed: 'Terminal failure',
  skipped: 'Intentionally skipped',
  cancelled: 'Cancelled',
  ambiguous: 'Effect uncertain',
  denied: 'Denied',
};
const reasons: Record<string, string> = {
  approval_required: 'Waiting for owner approval',
  owner_paused: 'Paused by owner',
  prerequisite: 'Waiting for a prerequisite',
  guard_pending: 'Waiting for guarded preparation',
  receipt_pending: 'Reconciling the existing execution receipt',
  provider_unavailable: 'Provider unavailable',
  runtime_unavailable: 'Runtime unavailable',
  workflow_execution_failed: 'Execution unavailable',
  legacy_owner: 'Managed by the existing runner',
  closed: 'This outcome is closed',
  native_schedule_control: 'Pause or edit this schedule in Schedules',
  source_policy_control: 'Manage this work through its source or memory policy',
  execution_in_progress: 'Execution is in progress; reconcile its receipt before another effect',
};
const readable = (value: string | null | undefined) =>
  reasons[value as string] || String(value || '').replaceAll('_', ' ');
const bad = (state: string) => ['retryable_failed', 'failed', 'ambiguous', 'denied'].includes(state);

export function WorkflowSummary({health, stale = false}: {health: any; stale?: boolean}) {
  const available = !!health && !health.unavailable && Array.isArray(health.counts);
  const counts: Record<string, number> = {};
  for (const row of available ? health.counts : []) counts[row.state] = (counts[row.state] || 0) + row.count;
  const failed = (counts.failed || 0) + (counts.retryable_failed || 0);
  const uncertain = counts.ambiguous || 0,
    denied = counts.denied || 0;
  const waiting = (counts.queued || 0) + (counts.waiting || 0);
  const waitingFamilies = Object.entries(families)
    .map(([family, label]) => ({
      label,
      count: (available ? health.counts : [])
        .filter((row: any) => row.family === family && ['queued', 'waiting'].includes(row.state))
        .reduce((total: number, row: any) => total + row.count, 0),
    }))
    .filter(row => row.count)
    .sort((a, b) => b.count - a.count);
  const waitingReasons: any[] = Array.isArray(health?.waiting_reasons) ? health.waiting_reasons : [];
  const reasonLabel = (row: any) =>
    row.state === 'queued' && !row.waiting_reason
      ? 'Queued to start'
      : row.waiting_reason
        ? readable(row.waiting_reason)
        : 'Reason not recorded';
  const workers: any[] = health?.workers || [],
    disconnected = workers.filter(worker => !worker.connected).length;
  const staleServices = (health?.services || []).filter((service: any) => !service.fresh).length;
  const metrics: [string, string | number, string, string, LucideIcon][] = [
    ['Running', counts.running || 0, 'Executing now', 'active', Activity],
    [
      'Waiting',
      waiting,
      `${counts.queued || 0} queued · ${counts.waiting || 0} awaiting a condition`,
      'warning',
      Clock3,
    ],
    [
      'Failed',
      failed,
      `${counts.retryable_failed || 0} retry scheduled · ${counts.failed || 0} terminal`,
      'danger',
      CircleX,
    ],
    [
      'Last success',
      health?.last_success_at ? time(health.last_success_at) : 'None recorded',
      'Last confirmed workflow completion',
      health?.last_success_at ? 'success' : 'neutral',
      CircleCheck,
    ],
    [
      'Backlog',
      health?.outbox?.pending ?? '—',
      'Requests awaiting publication',
      health?.outbox?.pending != null ? 'warning' : 'neutral',
      Inbox,
    ],
  ];
  return (
    <section className="n-panel n-workflow-summary" aria-label="Workflow summary">
      <div className="n-summary-line">
        <div>
          <h2>Workflows</h2>
          <p className="n-muted">All workflow families · refreshes every 10 seconds</p>
        </div>
        <a href="/inngest/runs" className="n-primary n-inngest-link">
          Open Inngest ↗
        </a>
      </div>
      {!available && <p role="alert">Workflow status is unavailable. Counts and the last success cannot be checked.</p>}
      {stale && <p role="alert">These are the last known workflow observations and may be out of date.</p>}
      <dl className="n-workflow-metrics">
        {metrics.map(([label, value, note, tone, Icon]) => (
          <div key={label} data-tone={available ? tone : 'neutral'}>
            <dt>
              <Icon size={14} aria-hidden={true} />
              {label}
            </dt>
            <dd className={label === 'Last success' ? 'n-workflow-time' : undefined}>{available ? value : '—'}</dd>
            <small>{available ? note : 'Unavailable'}</small>
          </div>
        ))}
      </dl>
      {available && waiting > 0 && (
        <section className="n-workflow-breakdown" aria-label="Waiting workflow breakdown">
          <div className="n-workflow-breakdown-heading">
            <h3>Why work is waiting</h3>
            <small>{'Oldest waiting record: ' + time(health.oldest_waiting)}</small>
          </div>
          <p className="n-muted">
            These are workflow records across all families. One source can have several workflows.
          </p>
          <div className="n-workflow-breakdown-grid">
            <div>
              <h4>By reason</h4>
              {!Array.isArray(health?.waiting_reasons) ? (
                <p>Reason breakdown unavailable.</p>
              ) : (
                <ul>
                  {waitingReasons.slice(0, 4).map((row, index) => (
                    <li key={row.state + ':' + row.waiting_reason + ':' + index}>
                      <span>{reasonLabel(row)}</span>
                      <strong>{row.count}</strong>
                    </li>
                  ))}
                  {waitingReasons.length > 4 && (
                    <li className="n-muted">{`${waitingReasons.length - 4} more reasons in Workflow details`}</li>
                  )}
                </ul>
              )}
            </div>
            <div>
              <h4>By family</h4>
              <ul>
                {waitingFamilies.slice(0, 4).map(row => (
                  <li key={row.label}>
                    <span>{row.label}</span>
                    <strong>{row.count}</strong>
                  </li>
                ))}
                {waitingFamilies.length > 4 && (
                  <li className="n-muted">{`${waitingFamilies.length - 4} more families in Workflow details`}</li>
                )}
              </ul>
            </div>
          </div>
        </section>
      )}
      {available && (failed > 0 || uncertain > 0) && (
        <p className="n-monitor-attention" role="status">
          {[
            failed > 0 ? `${failed} failed (${counts.retryable_failed || 0} retry scheduled)` : null,
            uncertain > 0 ? `${uncertain} uncertain — review before another effect` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {available && denied > 0 && (
        <p className="n-workflow-closed">{`${denied} denied or rejected outcomes · Closed records; inspect Workflow details for the individual reason.`}</p>
      )}
      {available && (
        <p
          className={disconnected || staleServices ? 'n-monitor-attention' : 'n-muted'}
          role={disconnected || staleServices ? 'status' : undefined}
        >
          {`${workers.length - disconnected}/${workers.length} workflow workers observed`}
          {disconnected ? ` · ${disconnected} stale or disconnected` : null}
          {staleServices ? ` · ${staleServices} stale service heartbeat${staleServices === 1 ? '' : 's'}` : null}
        </p>
      )}
      <small>
        {'Observed ' +
          time(health?.observed_at) +
          ' · Inngest history is read-only. Retry and cancel are in Workflow details.'}
      </small>
    </section>
  );
}

export function Workflows({call, health, onSource}: {call: Call; health: any; onSource: (id: string) => void}) {
  const [family, setFamily] = useState(''),
    [state, setState] = useState(''),
    [pages, setPages] = useState<(string | null)[]>([null]);
  const [selected, setSelected] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [controlError, setControlError] = useState(''),
    trigger = useRef<HTMLElement | null>(null);
  const after = pages.at(-1),
    query = new URLSearchParams({family, state, limit: '25', ...(after ? {after} : {})});
  const {data: page, error} = useResource<any>('/workflows?' + query, 10000);
  const {data: detail, error: detailError} = useResource<any>(selected ? '/workflows/' + selected : null, 10000);
  const filter = (setter: (value: string) => void, value: string) => {
    setter(value);
    setPages([null]);
  };
  const control = async (action: string) => {
    setBusy(true);
    setControlError('');
    try {
      await call('/workflows/' + detail.id + '/' + action, {revision: detail.revision});
    } catch {
      setControlError(
        'The workflow changed or cannot accept this action. Check its current receipt before trying again.',
      );
    } finally {
      refreshResources();
      setBusy(false);
    }
  };
  const row = (item: any) => (
    <tr key={item.id}>
      <td>
        <strong>{families[item.family]}</strong>
        {item.waiting_reason && <small>{readable(item.waiting_reason)}</small>}
      </td>
      <td>
        <StatusBadge state={item.state} label={states[item.state]} />
      </td>
      <td>
        {readable(item.stage)}
        {item.total != null && (
          <Progress
            value={item.total ? (100 * item.completed) / item.total : 0}
            label={`${item.completed}/${item.total} records · ${item.duplicates} duplicates`}
          />
        )}
      </td>
      <td>{item.attempts}</td>
      <td>
        <time dateTime={item.updated_at}>{time(item.updated_at)}</time>
        <small>{'Admitted ' + time(item.created_at)}</small>
      </td>
      <td>
        <Button
          size="sm"
          onClick={event => {
            trigger.current = event.currentTarget;
            setSelected(item.id);
            setControlError('');
          }}
          aria-label={'Execution details for ' + families[item.family] + ' ' + item.id.slice(0, 8)}
        >
          Details
        </Button>
      </td>
    </tr>
  );
  return (
    <>
      <section className="n-panel">
        <h2>Workflow history</h2>
        <p className="n-muted">Inspect receipts and authorized controls. Filters apply to this table only.</p>
        <div className="n-form">
          <label>
            Workflow family
            <select value={family} onChange={e => filter(setFamily, e.target.value)}>
              <option value="">All families</option>
              {Object.entries(families).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select value={state} onChange={e => filter(setState, e.target.value)}>
              <option value="">All statuses</option>
              {Object.entries(states).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && (
          <p role="alert">
            {page
              ? 'Showing the last successful workflow observation. It may be stale.'
              : 'Workflow observations are unavailable.'}
          </p>
        )}
        {!page && !error && <p role="status">Loading workflows…</p>}
        {page && !page.workflows.length && <EmptyState title="No workflows match these filters" />}
        {page?.workflows.length > 0 && (
          <Table aria-label="Workflow history">
            <thead>
              <tr>
                {['Family', 'Status', 'Stage', 'Attempts', 'Timing', 'Details'].map(label => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>{page.workflows.map(row)}</tbody>
          </Table>
        )}
        <div className="n-actions">
          <button
            type="button"
            disabled={pages.length === 1}
            onClick={() => {
              setPages(p => p.slice(0, -1));
            }}
          >
            Previous
          </button>
          <button
            type="button"
            disabled={!page?.next}
            onClick={() => {
              setPages(p => [...p, page.next]);
            }}
          >
            Next
          </button>
          <small>{'Observed ' + time(page?.observed_at) + ' · refreshes every 10 seconds'}</small>
        </div>
      </section>
      <Sheet
        open={!!selected}
        onOpenChange={open => {
          if (!open) {
            setSelected(null);
            setControlError('');
          }
        }}
        title="Workflow execution details"
        description="Inspect confirmed receipts before retrying or cancelling."
        returnFocus={trigger.current}
      >
        {detailError && (
          <p role="alert">
            {detail ? 'Receipt may be stale. Refresh before taking action.' : 'The execution receipt is unavailable.'}
          </p>
        )}
        {controlError && <p role="alert">{controlError}</p>}
        {!detail ? (
          <p role="status">{detailError ? 'No current receipt.' : 'Loading execution receipt…'}</p>
        ) : (
          <>
            <h3>{families[detail.family] || detail.family}</h3>
            <StatusBadge state={detail.state} label={states[detail.state]} />
            {detail.source_event_id && (
              <Button
                onClick={() => {
                  onSource(detail.source_event_id);
                  setSelected(null);
                }}
              >
                Inspect original
              </Button>
            )}
            <small className="n-workflow-id">{'Workflow ' + detail.id}</small>
            <small className="n-workflow-id">{'Job ' + detail.job_id}</small>
            <p>{`Version ${detail.version} · generation ${detail.generation} · revision ${detail.revision}`}</p>
            {detail.control_reason && <p className="n-muted">{readable(detail.control_reason)}</p>}
            <div className="n-actions">
              <button
                type="button"
                disabled={busy || !!detailError || !detail.can_retry}
                onClick={() => control('retry')}
              >
                Retry now
              </button>
              <button
                type="button"
                disabled={busy || !!detailError || !detail.can_cancel}
                onClick={() => control('cancel')}
              >
                Cancel workflow
              </button>
            </div>
            <h3 className="n-afterword">Execution receipts</h3>
            {!detail.receipts.length && <p className="n-muted">No external effect receipt has been recorded.</p>}
            {detail.receipts.map((r: any) => (
              <div className="n-row" key={r.step + ':' + r.attempt}>
                <b>{readable(r.step) + ' · attempt ' + r.attempt}</b>
                <div>
                  <StatusBadge state={r.state} label={readable(r.state)} />
                  <small>{time(r.updated_at)}</small>
                </div>
              </div>
            ))}
            <h3 className="n-afterword">Inngest runs</h3>
            {!detail.runs.length && <p className="n-muted">No Inngest run has been observed.</p>}
            {detail.runs.map((r: any) => (
              <div className="n-row" key={r.run_id}>
                <a href={'/inngest/run?runID=' + encodeURIComponent(r.run_id)}>{'Inspect run ' + r.run_id}</a>
                <span>{'Dispatch ' + r.dispatch + ' · ' + time(r.seen_at)}</span>
              </div>
            ))}
            <h3 className="n-afterword">Publication and controls</h3>
            {detail.outbox.map((r: any) => (
              <div className="n-row" key={r.dispatch}>
                <b>{'Dispatch ' + r.dispatch}</b>
                <span>
                  {r.published_at
                    ? 'Published ' + time(r.published_at)
                    : r.dispatch !== detail.dispatch
                      ? 'Superseded'
                      : ['completed', 'failed', 'skipped', 'cancelled', 'ambiguous', 'denied'].includes(detail.state)
                        ? 'Closed without publication'
                        : 'Awaiting publication · next ' + time(r.next_attempt)}
                </span>
              </div>
            ))}
            {detail.controls.map((r: any) => (
              <div className="n-row" key={r.revision + ':' + r.action}>
                <b>{readable(r.action) + ' · revision ' + r.revision}</b>
                <span>{time(r.created_at)}</span>
              </div>
            ))}
          </>
        )}
      </Sheet>
      <section className="n-panel">
        <h2>Workflow delivery and workers</h2>
        {!health || health.unavailable ? (
          <p role="alert">Workflow health is unavailable. Worker observations may be stale.</p>
        ) : (
          <>
            <p>{`${health.outbox.pending} unpublished requests · ${health.outbox.admitted} eligible for delivery`}</p>
            <small>{'Oldest unpublished: ' + time(health.outbox.oldest)}</small>
            <small>{'Oldest waiting work: ' + time(health.oldest_waiting)}</small>
            {health.workers.map((worker: any) => (
              <div className="n-row" key={worker.family}>
                <b>{families[worker.family]}</b>
                <StatusBadge
                  state={worker.owner === 'legacy' ? 'unknown' : worker.connected ? 'ready' : 'stale'}
                  label={
                    worker.owner === 'legacy'
                      ? 'Existing runner'
                      : worker.connected
                        ? 'Connected'
                        : 'Stale or disconnected'
                  }
                />
                <small>
                  {(worker.admission ? 'Admission open' : 'Admission paused') + ' · last seen ' + time(worker.seen_at)}
                </small>
              </div>
            ))}
            {health.services.map((service: any) => (
              <div className="n-row" key={service.service}>
                <b>{service.service}</b>
                <StatusBadge
                  state={service.fresh ? 'ready' : 'stale'}
                  label={service.fresh ? 'Current heartbeat' : 'Stale heartbeat'}
                />
                <small>{time(service.seen_at)}</small>
              </div>
            ))}
            <small>{'Observed ' + time(health.observed_at)}</small>
          </>
        )}
      </section>
      <p className="n-muted">
        Backup, restore and shutdown progress remain in <a href="#system?view=maintenance">Backups &amp; maintenance</a>
        .
      </p>
    </>
  );
}

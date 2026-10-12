import {useState, type ReactNode} from 'react';
import {Workflows, WorkflowSummary} from '../components/workflows';
import {useResource} from '../lib/resource';
import {Analytics} from '../components/analytics';
import {StatusBadge} from '../components/status';
import {ReplyTimings} from '../components/timings';
import {StorageUsage} from '../components/storage';

type Call = (path: string, body?: unknown) => Promise<any>;

const time = (value: string | null | undefined) => (value ? new Date(value).toLocaleString() : 'Not observed');
const names: Record<string, string> = {
  pending: 'Queued',
  running: 'Running',
  failed: 'Failed · will retry',
  done: 'Completed',
  ambiguous: 'Delivery uncertain',
  suppressed: 'Skipped',
  ready: 'Ready',
  connected: 'Receiving',
  recovering: 'Recovering',
  disabled: 'Disabled',
  starting: 'Starting',
  credentials_missing: 'Login missing',
  connection_failed: 'Connection failed',
  runtime_failed: 'Runtime failed',
};
const reasons: Record<string, string> = {
  telegram_network_error: 'Telegram polling stopped after network recovery failed.',
  telegram_polling_conflict: 'Another process may be using this bot token.',
  telegram_adapter_failed: 'The Telegram adapter stopped.',
  telegram_poll_or_capture_failed: 'The last Telegram poll or durable capture failed.',
  telegram_unauthorized: 'Telegram rejected the bot token.',
  telegram_rate_limited: 'Telegram requested a pause.',
  conversation_not_selected: 'This chat is outside the selected Telegram conversations.',
  unsupported_message: 'This update did not contain a supported message.',
  not_addressed: 'A group message that did not address Nocheh; it was archived without a reply.',
  waiting_for_attachments: 'Waiting for original files to download.',
  waiting_for_transcription: 'Waiting for voice transcription.',
  guard_preparation_pending: 'Waiting for a guarded copy before calling the model.',
  awaiting_dispatch_receipt: 'Checking the existing run receipt before retrying.',
  model_unavailable: 'The model did not return a successful result.',
  quota_paused: 'Subscription quota is paused.',
  subscription_unavailable: 'The subscription is unavailable. Check its login and quota.',
  runtime_restart_during_dispatch:
    'The runtime restarted before the outcome was confirmed. Review before sending again.',
  delivery_unconfirmed: 'Telegram delivery was not confirmed. It will not be resent automatically.',
};
const reason = (value: string | null | undefined) =>
  reasons[value as string] || String(value || '').replaceAll('_', ' ');
function useMonitor(): [any, string] {
  const {data, error} = useResource<any>('/monitoring', 10000);
  return [data, error ? 'Monitoring is unavailable. The last successful observation may be stale.' : ''];
}
function Disclosure({title, note, children}: {title: string; note: string; children?: ReactNode}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="n-panel n-monitor-details" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <span>{title}</span>
        <small>{note}</small>
      </summary>
      {open && <div className="n-monitor-detail-body">{children}</div>}
    </details>
  );
}
export function Monitoring({
  call,
  compact = false,
  renderSource,
}: {
  call: Call;
  compact?: boolean;
  renderSource?: (record: any) => ReactNode;
}) {
  const [data, error] = useMonitor(),
    [filter, setFilter] = useState('all'),
    [sourceId, setSourceId] = useState<string | null>(null);
  const {data: record, error: sourceError} = useResource<any>(sourceId ? '/events/' + sourceId : null);
  const status = data?.runtime?.status || {},
    archive = data?.archive?.archive || {},
    provider = data?.provider || {};
  const telegram = status.telegram || 'unavailable';
  const needsAttention = !!data && data.telegram_enabled && telegram !== 'connected';
  const rows: any[] = archive.workflows || [];
  const open = (id: string) => setSourceId(id);
  if (!data)
    return (
      <section className="n-panel">
        <h2>System monitoring</h2>
        <p role={error ? 'alert' : 'status'}>{error || 'Checking Telegram, the runtime and queued work…'}</p>
        {!compact && (
          <a href="/inngest/runs" className="n-primary n-inngest-link">
            Open Inngest ↗
          </a>
        )}
      </section>
    );
  const banner = (
    <section
      className={'n-panel n-monitor-banner' + (needsAttention || error ? ' n-monitor-warning' : '')}
      role={needsAttention || error ? 'alert' : undefined}
    >
      <div>
        <h2>
          {needsAttention
            ? 'Telegram needs attention'
            : data.telegram_enabled
              ? 'Telegram · ' + (names[telegram] || telegram)
              : 'Telegram is disabled'}
        </h2>
        <p>
          {reason(status.telegram_details?.error_code) ||
            (needsAttention
              ? 'The receive path is not confirmed. Check the incident and services below.'
              : 'Last successful poll: ' + time(status.telegram_details?.last_poll_at))}
        </p>
        <small>{'Checked ' + time(data.checked_at) + ' · refreshes every 10 seconds'}</small>
      </div>
      {compact ? (
        <a href="#monitoring" className="n-text-link">
          Open system monitoring →
        </a>
      ) : (
        <a href="#operations" className="n-text-link">
          Open Maintenance →
        </a>
      )}
    </section>
  );
  if (compact)
    return (
      <div>
        {banner}
        {error && <p role="alert">{error}</p>}
      </div>
    );
  const workflowAvailable = Array.isArray(archive.telegram) && Array.isArray(archive.workflows);
  const counts: Record<string, number> = (archive.telegram || []).reduce(
    (all: Record<string, number>, row: any) => ({...all, [row.state]: row.count}),
    {},
  );
  const visible = rows.filter(
    row =>
      filter === 'all' ||
      (filter === 'attention' && ['pending', 'running', 'failed', 'ambiguous'].includes(row.state)) ||
      row.state === filter,
  );
  const application = data.application;
  return (
    <div className="n-monitor">
      {error && <p role="alert">{error}</p>}
      <WorkflowSummary health={data.workflows} stale={!!error} />
      {banner}
      <div className="health-strip">
        <StatusBadge
          state={application?.ok ? 'ready' : 'unknown'}
          label={'API · ' + (application?.ok ? 'ready' : 'unavailable')}
        />
        <StatusBadge
          state={application?.workers?.capture || 'unknown'}
          label={'Capture · ' + (application?.workers?.capture || 'unavailable')}
        />
        <StatusBadge
          state={application?.workers?.workflows || 'unknown'}
          label={'Inngest · ' + (application?.workers?.workflows || 'unavailable')}
        />
      </div>
      {Array.isArray(data.services) && data.services.some((service: any) => service.state === 'unhealthy') && (
        <p className="n-monitor-attention" role="status">
          {data.services.filter((service: any) => service.state === 'unhealthy').length +
            ' services need attention. Expand Services for details.'}
        </p>
      )}
      {archive.spool_failures?.length > 0 && (
        <p role="alert">{archive.spool_failures.length + ' archive spool failures require attention.'}</p>
      )}
      <Analytics counts={data.workflows?.unavailable ? null : data.workflows?.counts} />
      <Disclosure
        title="Reply timing"
        note="Where reply time goes, per stage: internal, workflow wait, third-party and LLM."
      >
        <ReplyTimings />
      </Disclosure>
      <Disclosure title="Storage" note="Database, table and local folder sizes, so growth is visible.">
        <StorageUsage />
      </Disclosure>
      <Disclosure
        title="Workflow details"
        note="Filter history, inspect receipts, retry or cancel; check delivery and workers."
      >
        <Workflows call={call} health={data.workflows} onSource={open} />
      </Disclosure>
      {sourceError && <p role="alert">{sourceError}</p>}
      {record && (
        <section>
          <button type="button" onClick={() => setSourceId(null)}>
            Close original
          </button>
          {renderSource?.(record)}
        </section>
      )}
      <Disclosure title="Telegram details" note="Captured updates, processing stages and the last polling incident.">
        <div className="n-metrics">
          {(
            [
              ['Completed', counts.done || 0, 'Completed Telegram turns; some may intentionally be silent.'],
              [
                'Waiting or running',
                (counts.pending || 0) + (counts.running || 0),
                'Captured work waiting for its next stage.',
              ],
              [
                'Failed or uncertain',
                (counts.failed || 0) + (counts.ambiguous || 0),
                'Failures retry; uncertain delivery requires review.',
              ],
            ] as [string, number, string][]
          ).map(([title, count, note]) => (
            <section className="n-panel" key={title}>
              <h2>{title}</h2>
              <strong>{workflowAvailable ? count : '—'}</strong>
              <p>{note}</p>
            </section>
          ))}
        </div>
        {!workflowAvailable && (
          <p role="alert">Archive status is unavailable. Queue counts and workflow history cannot be checked.</p>
        )}
        {data.telegram_incident && (
          <section className="n-panel">
            <h2>Last Telegram incident</h2>
            <p>{reason(data.telegram_incident.error_code)}</p>
            <small>{time(data.telegram_incident.at)}</small>
            {telegram === 'connected' && (
              <p className="n-afterword">Polling is active again. This incident is retained for inspection.</p>
            )}
          </section>
        )}
        <section className="n-panel">
          <h2>Telegram workflows</h2>
          <p className="n-muted">
            The latest 50 captured updates, including successes, failures and intentional skips. Original message text
            stays in Archive.
          </p>
          <label>
            Show
            <select value={filter} onChange={e => setFilter(e.target.value)}>
              {Object.entries({
                all: 'All updates',
                attention: 'Needs attention',
                done: 'Completed',
                suppressed: 'Skipped',
              }).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {!visible.length && (
            <p className="n-empty">
              {!workflowAvailable
                ? 'Workflow history is unavailable.'
                : rows.length
                  ? 'No updates match this filter.'
                  : 'No Telegram updates have been captured yet.'}
            </p>
          )}
          {visible.map(row => (
            <article className="n-workflow" key={row.event_id}>
              <div className="n-result-heading">
                <h3>{time(row.received_at)}</h3>
                <StatusBadge
                  state={row.state === 'failed' ? 'retryable_failed' : row.state}
                  label={names[row.state] || row.state}
                />
              </div>
              <p>
                {reason(row.error_code) ||
                  (
                    {
                      done: 'Processing completed.',
                      suppressed: 'No assistant turn was needed.',
                      pending: 'Waiting to start.',
                      running: 'A turn is in progress.',
                    } as Record<string, string>
                  )[row.state]}
              </p>
              <ol className="n-workflow-stages" aria-label="Workflow stages">
                <li>Captured</li>
                <li>{row.files ? `${row.files - row.files_waiting}/${row.files} files ready` : 'No files'}</li>
                <li>
                  {data.archive?.guard_mode === 'off'
                    ? 'Guard off'
                    : row.guard_waiting
                      ? row.guard_waiting + ' guarded copies waiting'
                      : 'Guarded copies ready'}
                </li>
                <li>{names[row.state] || row.state}</li>
              </ol>
              {(row.guard_error || row.transcription_error) && (
                <p role="status">{reason(row.guard_error || row.transcription_error)}</p>
              )}
              <small>
                {row.attempts + ' attempt' + (row.attempts === 1 ? '' : 's') + ' · Updated ' + time(row.updated_at)}
              </small>
              {['pending', 'running', 'failed'].includes(row.state) && (
                <small>{'Next check: ' + time(row.next_attempt)}</small>
              )}
              <button type="button" onClick={() => open(row.event_id)}>
                Inspect original
              </button>
            </article>
          ))}
        </section>
      </Disclosure>
      <Disclosure
        title="Provider connection"
        note={
          provider.unavailable
            ? 'Provider observations unavailable.'
            : !provider.reasoning_login_present
              ? 'Reasoning login is missing.'
              : status.reasoning_route === 'shared'
                ? 'Shared subscription proxy · login present.'
                : 'Native Hermes subscription route.'
        }
      >
        <p>
          {'Active reasoning route: ' +
            (status.reasoning_route === 'shared'
              ? 'Shared subscription proxy'
              : status.reasoning_route === 'native'
                ? 'Native Hermes subscription'
                : 'Unavailable')}
        </p>
        <p>
          {provider.unavailable
            ? 'Shared provider status unavailable.'
            : provider.reasoning_login_present
              ? 'Login for ' + provider.reasoning_model + ' is present.'
              : 'Login for ' +
                provider.reasoning_model +
                ' is missing. Complete OAuth before switching the active route.'}
        </p>
        {!provider.unavailable && (
          <p>
            {provider.login_present
              ? 'ChatGPT login for voice transcription is present.'
              : 'ChatGPT login for voice transcription is missing. Voice messages are kept but not transcribed.'}
          </p>
        )}
        <a href="/providers/management.html#/oauth" className="n-text-link">
          Open subscription OAuth →
        </a>
        {status.reasoning_route === 'native' && (
          <p className="n-muted">
            Provider monitoring records shared-proxy traffic. Your current native Hermes requests do not pass through
            that proxy.
          </p>
        )}
        <h3 className="n-afterword">Where the three API keys come from</h3>
        <p>
          Nocheh generates three local access credentials: Hermes for chat, Honcho for memory reasoning, and Preparation
          for guarded text. They authenticate these services to your local proxy. They are not OpenAI billing keys and
          do not sign you into ChatGPT.
        </p>
        <p className="n-muted">
          The management key protects the local proxy’s administration API. Nocheh manages these credentials
          automatically.
        </p>
        <a href="/providers/management.html" className="n-text-link">
          Open provider requests and usage →
        </a>
      </Disclosure>
      <Disclosure title="Background work" note="Guarded copies, files, transcriptions and approved actions.">
        {['preparation', 'artifacts', 'transcriptions', 'actions'].map(kind => (
          <div className="n-row" key={kind}>
            <b>
              {
                (
                  {
                    preparation: 'Guarded copies',
                    artifacts: 'Files',
                    transcriptions: 'Transcriptions',
                    actions: 'Approved actions',
                  } as Record<string, string>
                )[kind]
              }
            </b>
            <span>
              {archive[kind]?.map((row: any) => row.count + ' ' + (names[row.state] || row.state)).join(' · ') ||
                'None recorded'}
            </span>
          </div>
        ))}
        <a href="#activity">Open browser runs and approvals →</a>
      </Disclosure>
      <Disclosure
        title="Services"
        note={
          Array.isArray(data.services)
            ? data.services.length + ' services · availability, purpose and expected state.'
            : 'Service status unavailable.'
        }
      >
        <p className="n-muted">
          Container health reports availability. Telegram polling and workflow outcomes above show whether useful work
          is progressing.
        </p>
        {Array.isArray(data.services) ? (
          data.services.map((row: any) => (
            <div className="n-row" key={row.service}>
              <div>
                <b>{row.service}</b>
                <p className="n-muted">{row.tool + ' · ' + row.location + ' · ' + row.purpose}</p>
              </div>
              <div>
                <StatusBadge state={row.state} label={row.state.replaceAll('_', ' ')} />
                <small>{'Expected ' + row.expected_state}</small>
              </div>
            </div>
          ))
        ) : (
          <p role="alert">Service status is unavailable.</p>
        )}
      </Disclosure>
    </div>
  );
}

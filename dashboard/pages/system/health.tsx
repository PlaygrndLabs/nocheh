/** System › Health: is everything running, and if not, what needs a look. */
import {useState, type ReactNode} from 'react';
import {AlertTriangle, ArrowRight, ArrowUpRight, CheckCircle2, XCircle} from 'lucide-react';
import {useResource} from '../../lib/resource';
import {href} from '../../lib/routes';
import {issues, workCounts, workers} from '../../lib/system-health';
import {
  ago,
  bytes,
  count,
  dateTime,
  expectedState,
  readable,
  routeName,
  serviceName,
  servicePurpose,
  serviceState,
  storeName,
  telegramReason,
  telegramStates,
  waitingReason,
} from '../../lib/system-format';
import {cn} from '../../lib/utils';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Details,
  Dot,
  LoadError,
  LoadingRows,
  Skeleton,
  Technical,
  type Tone,
} from '../../ui/core';
import {LinkButton} from '../../ui/link-button';

export function HealthView() {
  const monitoring = useResource<any>('/monitoring', 10000);
  const m = monitoring.data;
  return (
    <>
      <StatusCard m={m} error={!!monitoring.error} />
      {monitoring.error && m && <LoadError what="the latest status" />}
      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        {/* Two columns on wide screens; on phones the cards stack in order of importance. */}
        <div className="contents lg:block lg:space-y-5">
          <div className="order-1">
            <Services m={m} error={!!monitoring.error} />
          </div>
          <div className="order-4">
            <Storage />
          </div>
        </div>
        <div className="contents lg:block lg:space-y-5">
          <div className="order-2">
            <WorkSummary m={m} />
          </div>
          <div className="order-3">
            <Connections m={m} />
          </div>
        </div>
      </div>
      {m && <Diagnostics m={m} />}
    </>
  );
}

function StatusCard({m, error}: {m: any; error: boolean}) {
  const list = issues(m);
  const tone: Tone = !m
    ? error
      ? 'warn'
      : 'neutral'
    : list.some(i => i.tone === 'bad')
      ? 'bad'
      : list.length
        ? 'warn'
        : 'good';
  const Icon = tone === 'good' ? CheckCircle2 : tone === 'bad' ? XCircle : AlertTriangle;
  const headline = !m
    ? error
      ? 'Status couldn’t be checked'
      : null
    : list.length
      ? `${list.length} ${list.length === 1 ? 'thing needs' : 'things need'} a look`
      : 'Everything is running';
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-4 px-5 py-5">
        {headline === null ? (
          <div className="flex-1 space-y-2">
            <Skeleton className="h-6 w-56" />
            <Skeleton className="h-4 w-40" />
          </div>
        ) : (
          <>
            <span
              className={cn(
                'grid size-10 shrink-0 place-items-center rounded-full',
                tone === 'good' && 'bg-good-soft text-good',
                tone === 'warn' && 'bg-warn-soft text-warn',
                tone === 'bad' && 'bg-bad-soft text-bad',
              )}
            >
              <Icon className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-lg font-semibold">{headline}</p>
              <p className="text-[13px] text-muted">
                {m
                  ? `Checked ${ago(m.checked_at)} · updates every 10 seconds`
                  : 'Nocheh may be restarting. This page keeps trying.'}
              </p>
            </div>
          </>
        )}
      </div>
      {list.length > 0 && (
        <ul className="border-t border-line">
          {list.map(item => (
            <li
              key={item.text}
              className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3 first:border-t-0"
            >
              <Dot tone={item.tone} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{item.text}</p>
                {item.detail && <p className="text-[13px] text-muted">{item.detail}</p>}
              </div>
              {item.link && <LinkButton href={item.link}>{item.action}</LinkButton>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Services({m, error}: {m: any; error: boolean}) {
  const services: any[] | null = Array.isArray(m?.services) ? m.services : null;
  const rank = (s: any) => (s.state === 'unhealthy' ? 0 : s.state === 'running' ? 1 : 2);
  const active = (services ?? []).filter(s => s.state !== 'optional-stopped').sort((a, b) => rank(a) - rank(b));
  const off = (services ?? []).filter(s => s.state === 'optional-stopped');
  return (
    <Card>
      <CardHeader title="Services" description="The programs that make up Nocheh on this machine." />
      <div className="mt-3">
        {!m && !error ? (
          <LoadingRows rows={5} />
        ) : !services ? (
          <div className="px-5 pb-5">
            <LoadError what="services" />
          </div>
        ) : (
          <>
            <ul>
              {active.map(row => (
                <ServiceRow key={row.service} row={row} />
              ))}
            </ul>
            {off.length > 0 && (
              <Details
                summary={`${off.length} optional ${off.length === 1 ? 'service is' : 'services are'} off`}
                className="px-5 py-3"
              >
                <ul className="-mx-5">
                  {off.map(row => (
                    <ServiceRow key={row.service} row={row} />
                  ))}
                </ul>
              </Details>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function ServiceRow({row}: {row: any}) {
  const state = serviceState(row.state);
  return (
    <li className="flex items-start gap-3 border-t border-line px-5 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{serviceName(row)}</p>
        <p className="text-[13px] text-muted">{servicePurpose(row)}</p>
        <p className="text-xs text-muted">
          {[
            row.location === 'docker' ? 'In a container' : row.location === 'host' ? 'On this computer' : row.location,
            expectedState(row.expected_state),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Badge tone={state.tone} dot>
          {state.label}
        </Badge>
      </div>
    </li>
  );
}

function WorkSummary({m}: {m: any}) {
  const health = m?.workflows;
  const counts = workCounts(health);
  const team = workers(health);
  const reasons: any[] = Array.isArray(health?.waiting_reasons) ? health.waiting_reasons : [];
  const figure = (label: string, value: number, tone?: Tone) => (
    <div className="rounded-lg bg-subtle px-3 py-2.5">
      <p className="text-xs text-muted">{label}</p>
      <p
        className={cn(
          'tabular text-xl font-semibold',
          tone === 'bad' && value > 0 && 'text-bad',
          tone === 'info' && value > 0 && 'text-info',
        )}
      >
        {counts.available ? count(value) : '—'}
      </p>
    </div>
  );
  return (
    <Card>
      <CardHeader
        title="Background work"
        description="Replies, imports, memory updates and other tasks Nocheh runs in the background."
        action={
          <LinkButton href={href('system', {view: 'work'})} variant="ghost" size="sm">
            Open <ArrowRight aria-hidden />
          </LinkButton>
        }
      />
      <div className="space-y-3 px-5 py-4">
        {!m ? (
          <Skeleton className="h-16 w-full" />
        ) : !counts.available ? (
          <p className="text-sm text-muted">Background work couldn’t be checked right now.</p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              {figure('Running', counts.running, 'info')}
              {figure('Waiting', counts.queued + counts.waiting)}
              {figure('Failed', counts.failed + counts.retrying, 'bad')}
            </div>
            <p className="text-[13px] text-muted">
              {team.total ? `${team.connected} of ${team.total} workers connected` : 'No workers registered'}
              {' · '}
              {health.last_success_at ? `last finished ${ago(health.last_success_at)}` : 'nothing finished yet'}
            </p>
            {counts.queued + counts.waiting > 0 && reasons.length > 0 && (
              <ul className="space-y-1 text-[13px]">
                {reasons.slice(0, 3).map((row, index) => (
                  <li key={index} className="flex justify-between gap-3">
                    <span className="text-muted">{waitingReason(row)}</span>
                    <span className="tabular font-medium">{count(row.count)}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function ConnectionRow({name, tone, state, detail}: {name: string; tone: Tone; state: string; detail?: ReactNode}) {
  return (
    <li className="flex items-start gap-3 border-t border-line px-5 py-3 first:border-t-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{name}</p>
        {detail && <p className="text-[13px] break-words text-muted">{detail}</p>}
      </div>
      <Badge tone={tone} dot className="shrink-0">
        {state}
      </Badge>
    </li>
  );
}

function Connections({m}: {m: any}) {
  const runtime = useResource<any>('/runtime', 30000);
  const routes: any[] | null = Array.isArray(m?.routes) ? m.routes : null;
  const status = m?.runtime?.status ?? {};
  const telegram = m?.telegram_enabled
    ? (telegramStates[status.telegram] ?? {label: readable(status.telegram) || 'Unknown', tone: 'neutral' as Tone})
    : {label: 'Turned off', tone: 'neutral' as Tone};
  const capabilities = Object.entries(runtime.data?.capabilities ?? {}).filter(([, v]) => typeof v === 'boolean');
  const worker = (value: string | undefined) =>
    ['ready', 'connected', 'running'].includes(String(value))
      ? {tone: 'good' as Tone, label: 'Working'}
      : value
        ? {tone: 'warn' as Tone, label: readable(value)}
        : {tone: 'neutral' as Tone, label: 'Unknown'};
  const capture = worker(m?.application?.workers?.capture);
  const scheduler = worker(m?.application?.workers?.workflows);
  return (
    <Card>
      <CardHeader
        title="Connections"
        description="Telegram, the assistant and the model each part uses."
        action={
          <LinkButton href="/hermes/nocheh" variant="ghost" size="sm" external>
            Assistant console <ArrowUpRight aria-hidden />
          </LinkButton>
        }
      />
      <div className="mt-3">
        {!m ? (
          <LoadingRows rows={4} />
        ) : (
          <ul>
            <ConnectionRow
              name="Telegram"
              tone={telegram.tone}
              state={telegram.label}
              detail={
                !m.telegram_enabled
                  ? 'Nocheh doesn’t receive or answer Telegram messages.'
                  : telegramReason(status.telegram_details?.error_code) ||
                    (status.telegram_details?.last_poll_at
                      ? `Last checked for messages ${ago(status.telegram_details.last_poll_at)}`
                      : undefined)
              }
            />
            <ConnectionRow
              name="Assistant"
              tone={runtime.data ? (runtime.data.status?.ok ? 'good' : 'bad') : runtime.error ? 'warn' : 'neutral'}
              state={
                runtime.data
                  ? runtime.data.status?.ok
                    ? 'Connected'
                    : 'Not answering'
                  : runtime.error
                    ? 'Unknown'
                    : 'Checking…'
              }
              detail={runtime.data?.status?.model ? `Model: ${runtime.data.status.model}` : undefined}
            />
            <ConnectionRow name="Message capture" tone={capture.tone} state={capture.label} />
            <ConnectionRow name="Background work scheduler" tone={scheduler.tone} state={scheduler.label} />
          </ul>
        )}
        <div className="border-t border-line px-5 py-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-[13px] font-medium text-muted">Models</h3>
            <LinkButton href={href('settings', {view: 'models'})} variant="link" size="sm">
              Settings › Models
            </LinkButton>
          </div>
          {!m ? (
            <Skeleton className="h-16 w-full" />
          ) : !routes ? (
            <p className="text-[13px] text-muted">Model settings couldn’t be read.</p>
          ) : (
            <ul className="space-y-1.5">
              {routes.map(route => (
                <li key={route.part} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                  <span>{routeName(route.part, route.label)}</span>
                  {route.configured ? (
                    <span className="min-w-0 truncate text-muted">
                      {route.provider_name || route.provider} · {route.model || 'default model'}
                    </span>
                  ) : (
                    <Badge tone="warn">Not set up</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
          {capabilities.length > 0 && (
            <Details summary="What the assistant can do" className="mt-3">
              <ul className="grid gap-1 sm:grid-cols-2">
                {capabilities.map(([name, on]) => (
                  <li key={name} className="flex items-center gap-2 text-[13px]">
                    <Dot tone={on ? 'good' : 'neutral'} />
                    <span className={cn(!on && 'text-muted')}>{readable(name.replaceAll('.', ' '))}</span>
                  </li>
                ))}
              </ul>
            </Details>
          )}
        </div>
      </div>
    </Card>
  );
}

function Storage() {
  const {data, error} = useResource<any>('/storage');
  const databases: any[] = data?.databases ?? [];
  const measured = databases.filter(d => d.state === 'measured');
  const total = measured.reduce((n, d) => n + d.bytes, 0);
  const folders: any[] = data?.state_folders ?? [];
  const folderTotal = folders.reduce((n, f) => n + (f.bytes ?? 0), 0);
  const partial = folders.some(f => f.complete === false);
  const max = Math.max(1, ...measured.map(d => d.bytes));
  return (
    <Card>
      <CardHeader
        title="Storage"
        description="Disk used by databases and local files. Your original messages are kept forever."
      />
      <div className="px-5 py-4">
        {error && !data ? (
          <LoadError what="storage" />
        ) : !data ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            <dl className="flex flex-wrap gap-x-8 gap-y-2">
              <div>
                <dt className="text-xs text-muted">Databases</dt>
                <dd className="tabular text-xl font-semibold">{bytes(total)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Local files</dt>
                <dd className="tabular text-xl font-semibold">
                  {partial && <span className="text-sm font-normal text-muted">at least </span>}
                  {bytes(folderTotal)}
                </dd>
              </div>
            </dl>
            <ul className="space-y-2.5">
              {databases.map(row => (
                <li key={row.database}>
                  <div className="flex justify-between gap-3 text-sm">
                    <span>{storeName(row)}</span>
                    <span className="tabular text-muted">
                      {row.state === 'measured' ? bytes(row.bytes) : 'Not running'}
                    </span>
                  </div>
                  {row.state === 'measured' && (
                    <div className="mt-1 h-1.5 rounded-full bg-subtle">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{width: `${Math.max(1, (100 * row.bytes) / max)}%`}}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <Details summary="More about storage">
              <div className="space-y-4 text-[13px]">
                {measured
                  .filter(row => row.largest_tables?.length)
                  .map(row => (
                    <div key={row.database}>
                      <p className="mb-1 font-medium">Largest tables in {storeName(row)}</p>
                      <ul className="space-y-0.5">
                        {row.largest_tables.map((table: any) => (
                          <li key={table.table} className="flex justify-between gap-3">
                            <span className="min-w-0 truncate font-mono text-xs">{table.table}</span>
                            <span className="tabular shrink-0 text-muted">
                              {bytes(table.bytes)} · ~{count(table.estimated_rows)} rows
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                {folders.length > 0 && (
                  <div>
                    <p className="mb-1 font-medium">Local folders</p>
                    <ul className="space-y-0.5">
                      {folders.map(row => (
                        <li key={row.path} className="flex justify-between gap-3">
                          <span className="font-mono text-xs">{row.path}</span>
                          <span className="tabular text-muted">
                            {row.complete === false ? 'at least ' : ''}
                            {bytes(row.bytes)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="text-muted">
                  Logs keep at most {data.docker_logs?.max_files_per_container ?? '—'} files of{' '}
                  {data.docker_logs?.max_size_per_file ?? '—'} per service. Background work history is kept for{' '}
                  {data.retention_days ? `${data.retention_days} days` : 'ever'}.
                </p>
              </div>
            </Details>
          </div>
        )}
      </div>
    </Card>
  );
}

const updateStates: Record<string, {label: string; tone: Tone}> = {
  pending: {label: 'Queued', tone: 'neutral'},
  running: {label: 'Running', tone: 'info'},
  failed: {label: 'Failed · will retry', tone: 'warn'},
  done: {label: 'Done', tone: 'good'},
  ambiguous: {label: 'Delivery uncertain', tone: 'warn'},
  suppressed: {label: 'No reply needed', tone: 'neutral'},
};

function Diagnostics({m}: {m: any}) {
  const archive = m.archive?.archive ?? {};
  const updates: any[] = Array.isArray(archive.workflows) ? archive.workflows : [];
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const shown = updates.filter(
    row => filter === 'all' || ['pending', 'running', 'failed', 'ambiguous'].includes(row.state),
  );
  return (
    <Card>
      <CardBodyDetails>
        <Details summary="Diagnostics">
          <div className="space-y-5">
            {m.telegram_incident && (
              <div className="rounded-lg border border-line p-3 text-sm">
                <p className="font-medium">Last Telegram problem · {dateTime(m.telegram_incident.at)}</p>
                <p className="text-[13px] text-muted">
                  {telegramReason(m.telegram_incident.error_code) || 'Reason not recorded.'}
                  {m.runtime?.status?.telegram === 'connected' && ' Telegram is working again.'}
                </p>
              </div>
            )}
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Latest Telegram messages</h3>
                <div className="flex gap-1">
                  {(['all', 'attention'] as const).map(value => (
                    <Button
                      key={value}
                      size="sm"
                      variant={filter === value ? 'secondary' : 'ghost'}
                      onClick={() => setFilter(value)}
                    >
                      {value === 'all' ? 'All' : 'Needs attention'}
                    </Button>
                  ))}
                </div>
              </div>
              {!Array.isArray(archive.workflows) ? (
                <p className="text-[13px] text-muted">Telegram history couldn’t be read.</p>
              ) : !shown.length ? (
                <p className="text-[13px] text-muted">
                  {updates.length ? 'Nothing needs attention.' : 'No Telegram messages have arrived yet.'}
                </p>
              ) : (
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {shown.slice(0, 20).map(row => {
                    const state = updateStates[row.state] ?? {label: readable(row.state), tone: 'neutral' as Tone};
                    return (
                      <li
                        key={row.event_id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]"
                      >
                        <span className="min-w-0 flex-1">{dateTime(row.received_at)}</span>
                        <span className="text-muted">
                          {row.attempts} {row.attempts === 1 ? 'try' : 'tries'}
                        </span>
                        <Badge tone={state.tone}>{state.label}</Badge>
                        <a className="text-accent-text hover:underline" href={href('messages', {source: row.event_id})}>
                          Open
                        </a>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <Technical value={m} summary="Full status data" />
          </div>
        </Details>
      </CardBodyDetails>
    </Card>
  );
}

const CardBodyDetails = ({children}: {children: ReactNode}) => <div className="px-5 py-4">{children}</div>;

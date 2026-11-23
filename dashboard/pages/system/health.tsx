/** System › Health: is everything running, and if not, what needs a look. */
import {useState, type ReactNode} from 'react';
import {AlertTriangle, ArrowRight, ArrowUpRight, CheckCircle2, XCircle} from 'lucide-react';
import {useSubTab} from '../../lib/navigation';
import {useResource} from '../../lib/resource';
import {href} from '../../lib/routes';
import {issues, workCounts, workers} from '../../lib/system-health';
import {
  ago,
  bytes,
  count,
  dateTime,
  expectedState,
  capabilityName,
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
  Card,
  CardHeader,
  Details,
  Dot,
  LoadError,
  LoadingRows,
  Notice,
  Pager,
  Segmented,
  Skeleton,
  Table,
  Td,
  Technical,
  Th,
  type Tone,
} from '../../ui/core';
import {LinkButton} from '../../ui/link-button';
import {SubPanel, SubTabs} from '../../ui/page';

const subTabs = ['status', 'services', 'storage', 'diagnostics'] as const;

export function HealthView() {
  const monitoring = useResource<any>('/monitoring', 10000);
  const m = monitoring.data;
  const [tab, setTab] = useSubTab(subTabs);
  return (
    <>
      <SubTabs
        label="Health"
        value={tab}
        onChange={setTab}
        tabs={[
          {id: 'status', label: 'Status', count: issues(m).length || null},
          {id: 'services', label: 'Services and connections'},
          {id: 'storage', label: 'Storage'},
          {id: 'diagnostics', label: 'Diagnostics'},
        ]}
      />
      {monitoring.error && m && <LoadError what="the latest status" />}
      {tab === 'status' && (
        <SubPanel id="status" current={tab}>
          <StatusCard m={m} error={!!monitoring.error} />
          <WorkSummary m={m} />
        </SubPanel>
      )}
      {tab === 'services' && (
        <SubPanel id="services" current={tab}>
          <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
            <Services m={m} error={!!monitoring.error} />
            <div className="space-y-5">
              <Connections m={m} />
              <Models m={m} />
            </div>
          </div>
        </SubPanel>
      )}
      {tab === 'storage' && (
        <SubPanel id="storage" current={tab}>
          <Storage />
        </SubPanel>
      )}
      {tab === 'diagnostics' && (
        <SubPanel id="diagnostics" current={tab}>
          {m ? (
            <Diagnostics m={m} />
          ) : (
            <Card>
              {monitoring.error ? <LoadError what="diagnostics" className="m-5" /> : <LoadingRows rows={4} />}
            </Card>
          )}
        </SubPanel>
      )}
    </>
  );
}

/** A state as a dot and its words: lighter than a pill in a table. */
function State({tone, children}: {tone: Tone; children: ReactNode}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap">
      <Dot tone={tone} />
      {children}
    </span>
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
        <div className="border-t border-line">
          <Table aria-label="Things that need a look" className="max-sm:block">
            <thead className="sr-only">
              <tr>
                <Th scope="col">What</Th>
                <Th scope="col">More</Th>
                <Th scope="col">Action</Th>
              </tr>
            </thead>
            <tbody className="max-sm:block">
              {list.map(item => (
                <tr
                  key={item.text}
                  className="last:[&>td]:border-b-0 max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:border-b max-sm:border-line max-sm:px-4 max-sm:py-2"
                >
                  <Td className="font-medium max-sm:w-full max-sm:border-0 max-sm:p-0">
                    <span className="flex items-baseline gap-2.5">
                      <Dot tone={item.tone} className="translate-y-[-1px]" />
                      {item.text}
                    </span>
                  </Td>
                  <Td className="text-[13px] text-muted max-sm:flex-1 max-sm:border-0 max-sm:p-0 max-sm:pl-[18px]">
                    {item.detail}
                  </Td>
                  <Td className="py-1.5 text-right whitespace-nowrap max-sm:border-0 max-sm:p-0">
                    {item.link && (
                      <LinkButton href={item.link} size="sm">
                        {item.action}
                      </LinkButton>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </Card>
  );
}

function Services({m, error}: {m: any; error: boolean}) {
  const services: any[] | null = Array.isArray(m?.services) ? m.services : null;
  // What needs a look first, then what runs, then the optional services that are off.
  const rank = (s: any) =>
    s.state === 'unhealthy' ? 0 : s.state === 'running' ? 1 : s.state === 'optional-stopped' ? 3 : 2;
  const rows = [...(services ?? [])].sort((a, b) => rank(a) - rank(b));
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
          <Table aria-label="Services">
            <thead>
              <tr>
                <Th scope="col">Service</Th>
                <Th scope="col" className="max-sm:hidden">
                  Runs
                </Th>
                <Th scope="col">State</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const state = serviceState(row.state);
                const runs = [
                  row.location === 'docker'
                    ? 'In a container'
                    : row.location === 'host'
                      ? 'On this computer'
                      : row.location,
                  expectedState(row.expected_state),
                ]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <tr key={row.service} className="last:[&>td]:border-b-0">
                    <Td>
                      <p className="font-medium">{serviceName(row)}</p>
                      <p className="text-[13px] text-muted">{servicePurpose(row)}</p>
                      <p className="text-xs text-muted sm:hidden">{runs}</p>
                    </Td>
                    <Td className="text-[13px] text-muted max-sm:hidden">{runs}</Td>
                    <Td>
                      <State tone={state.tone}>{state.label}</State>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </div>
    </Card>
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
          <LinkButton href={href('system', {view: 'work', tab: 'tasks'})} variant="ghost" size="sm">
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
    <tr className="last:[&>*]:border-b-0">
      <Th scope="row" className="bg-transparent text-sm font-medium whitespace-normal text-fg">
        {name}
        {detail && <span className="block text-[13px] font-normal break-words text-muted">{detail}</span>}
      </Th>
      <Td className="text-right">
        <State tone={tone}>{state}</State>
      </Td>
    </tr>
  );
}

function Connections({m}: {m: any}) {
  const runtime = useResource<any>('/runtime', 30000);
  const status = m?.runtime?.status ?? {};
  const telegram = m?.telegram_enabled
    ? (telegramStates[status.telegram] ?? {label: readable(status.telegram) || 'Unknown', tone: 'neutral' as Tone})
    : {label: 'Turned off', tone: 'neutral' as Tone};
  // What the connected agent offers; Nocheh's own helper services are not listed.
  const agent = runtime.data?.agent;
  const capabilities = Object.entries(agent?.capabilities ?? {}).filter(([, v]) => typeof v === 'boolean');
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
        description="Telegram, the assistant and the workers behind them."
        action={
          <LinkButton href="/hermes/nocheh" variant="ghost" size="sm" external>
            Assistant console <ArrowUpRight aria-hidden />
          </LinkButton>
        }
      />
      <div className="mt-3 border-t border-line">
        {!m ? (
          <LoadingRows rows={4} />
        ) : (
          <Table aria-label="Connections">
            <tbody>
              <ConnectionRow
                name="Telegram"
                tone={telegram.tone}
                state={telegram.label}
                detail={
                  !m.telegram_enabled
                    ? 'Nocheh doesn’t receive or answer Telegram messages.'
                    : [
                        status.telegram_details?.bot_username ? '@' + status.telegram_details.bot_username : '',
                        telegramReason(status.telegram_details?.error_code) ||
                          (status.telegram_details?.last_poll_at
                            ? `Last checked for messages ${ago(status.telegram_details.last_poll_at)}`
                            : ''),
                      ]
                        .filter(Boolean)
                        .join(' · ') || undefined
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
                detail={
                  [
                    agent?.name && `Agent: ${agent.name}`,
                    runtime.data?.status?.model && `Model: ${runtime.data.status.model}`,
                  ]
                    .filter(Boolean)
                    .join(' · ') || undefined
                }
              />
              <ConnectionRow name="Message capture" tone={capture.tone} state={capture.label} />
              <ConnectionRow name="Background work scheduler" tone={scheduler.tone} state={scheduler.label} />
            </tbody>
          </Table>
        )}
        {capabilities.length > 0 && (
          <Details summary="What the assistant can do" className="border-t border-line px-5 py-3">
            <ul className="grid gap-1 sm:grid-cols-2">
              {capabilities.map(([name, on]) => (
                <li key={name} className="flex items-center gap-2 text-[13px]">
                  <Dot tone={on ? 'good' : 'neutral'} />
                  <span className={cn(!on && 'text-muted')}>{capabilityName(name)}</span>
                </li>
              ))}
            </ul>
          </Details>
        )}
      </div>
    </Card>
  );
}

function Models({m}: {m: any}) {
  const routes: any[] | null = Array.isArray(m?.routes) ? m.routes : null;
  return (
    <Card>
      <CardHeader
        title="Models"
        description="The model each part uses."
        action={
          <LinkButton href={href('settings', {view: 'models'})} variant="ghost" size="sm">
            Settings › Models <ArrowRight aria-hidden />
          </LinkButton>
        }
      />
      <div className="mt-3 border-t border-line">
        {!m ? (
          <LoadingRows rows={4} />
        ) : !routes ? (
          <p className="px-5 py-4 text-[13px] text-muted">Model settings couldn’t be read.</p>
        ) : (
          <Table aria-label="Models">
            <tbody>
              {routes.map(route => (
                <tr key={route.part} className="last:[&>*]:border-b-0">
                  <Th scope="row" className="bg-transparent py-2 text-[13px] font-normal text-fg">
                    {routeName(route.part, route.label)}
                  </Th>
                  <Td className="py-2 text-right text-[13px] text-muted">
                    {route.configured ? (
                      `${route.provider_name || route.provider} · ${route.model || 'default model'}`
                    ) : (
                      <State tone="warn">Not set up</State>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {Array.isArray(m?.keys) && m.keys.length > 0 && (
          <Details summary="Internal keys" className="border-t border-line px-5 py-3">
            <p className="mb-2 text-[13px] text-muted">
              Nocheh makes these for its own services. Their values never leave the installation.
            </p>
            <ul className="space-y-2">
              {m.keys.map((key: {name: string; service: string; usage: string; present: boolean}) => (
                <li key={key.name} className="flex items-start justify-between gap-3 text-[13px]">
                  <span className="min-w-0">
                    <span className="block font-medium">{key.service}</span>
                    <span className="block text-muted">{key.usage}</span>
                    <code className="text-xs break-all text-muted">{key.name}</code>
                  </span>
                  <Badge tone={key.present ? 'good' : 'bad'}>{key.present ? 'Set' : 'Missing'}</Badge>
                </li>
              ))}
            </ul>
          </Details>
        )}
      </div>
    </Card>
  );
}

const TABLES = 10;

function Storage() {
  const {data, error} = useResource<any>('/storage');
  const [page, setPage] = useState(0);
  const databases: any[] = data?.databases ?? [];
  const measured = databases.filter(d => d.state === 'measured');
  const total = measured.reduce((n, d) => n + d.bytes, 0);
  const folders: any[] = data?.state_folders ?? [];
  const folderTotal = folders.reduce((n, f) => n + (f.bytes ?? 0), 0);
  const partial = folders.some(f => f.complete === false);
  const max = Math.max(1, ...measured.map(d => d.bytes));
  const largest: {database: string; table: string; bytes: number; estimated_rows: number}[] = measured
    .flatMap(row => (row.largest_tables ?? []).map((table: any) => ({...table, database: storeName(row)})))
    .sort((a, b) => b.bytes - a.bytes);
  if (error && !data) return <LoadError what="storage" />;
  if (!data)
    return (
      <Card>
        <LoadingRows rows={4} />
      </Card>
    );
  return (
    <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
      <div className="space-y-5">
        <Card>
          <CardHeader
            title="Databases"
            description="Disk used by each database. Your original messages are kept forever."
            action={<span className="tabular text-xl font-semibold">{bytes(total)}</span>}
          />
          <div className="mt-3 border-t border-line">
            <Table aria-label="Databases">
              <tbody>
                {databases.map(row => (
                  <tr key={row.database} className="last:[&>*]:border-b-0">
                    <Th scope="row" className="bg-transparent text-sm font-normal text-fg">
                      {storeName(row)}
                    </Th>
                    <Td className="w-2/5 align-middle max-sm:hidden">
                      {row.state === 'measured' && (
                        <div className="h-1.5 rounded-full bg-subtle">
                          <div
                            className="h-full rounded-full bg-accent"
                            style={{width: `${Math.max(1, (100 * row.bytes) / max)}%`}}
                          />
                        </div>
                      )}
                    </Td>
                    <Td className="tabular text-right whitespace-nowrap text-muted">
                      {row.state === 'measured' ? bytes(row.bytes) : 'Not running'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Card>
        <Card>
          <CardHeader
            title="Local files"
            description={`Logs keep at most ${data.docker_logs?.max_files_per_container ?? '—'} files of ${
              data.docker_logs?.max_size_per_file ?? '—'
            } per service. Background work history is kept for ${
              data.retention_days ? `${data.retention_days} days` : 'ever'
            }.`}
            action={
              <span className="tabular text-xl font-semibold">
                {partial && <span className="text-sm font-normal text-muted">at least </span>}
                {bytes(folderTotal)}
              </span>
            }
          />
          <div className="mt-3 border-t border-line">
            {!folders.length ? (
              <p className="px-5 py-4 text-[13px] text-muted">No local folders were measured.</p>
            ) : (
              <Table aria-label="Local folders">
                <tbody>
                  {folders.map(row => (
                    <tr key={row.path} className="last:[&>*]:border-b-0">
                      <Th
                        scope="row"
                        className="bg-transparent py-2 font-mono text-xs font-normal break-all whitespace-normal text-fg"
                      >
                        {row.path}
                      </Th>
                      <Td className="tabular py-2 text-right text-[13px] whitespace-nowrap text-muted">
                        {row.complete === false ? 'at least ' : ''}
                        {bytes(row.bytes)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        </Card>
      </div>
      <Card>
        <CardHeader title="Largest tables" description="The biggest tables across the databases, largest first." />
        <div className="mt-3 border-t border-line">
          {!largest.length ? (
            <p className="px-5 py-4 text-[13px] text-muted">No table sizes were measured.</p>
          ) : (
            <>
              <Table aria-label="Largest tables">
                <thead>
                  <tr>
                    <Th scope="col">Table</Th>
                    <Th scope="col">Database</Th>
                    <Th scope="col" className="text-right">
                      Size
                    </Th>
                    <Th scope="col" className="text-right">
                      Rows
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {largest.slice(page * TABLES, page * TABLES + TABLES).map(row => (
                    <tr key={row.database + ':' + row.table}>
                      <Td className="py-2 font-mono text-xs break-all">{row.table}</Td>
                      <Td className="py-2 text-[13px] text-muted">{row.database}</Td>
                      <Td className="tabular py-2 text-right text-[13px] whitespace-nowrap">{bytes(row.bytes)}</Td>
                      <Td className="tabular py-2 text-right text-[13px] whitespace-nowrap text-muted">
                        ~{count(row.estimated_rows)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pager
                page={page}
                hasNext={(page + 1) * TABLES < largest.length}
                onPage={setPage}
                summary={`${count(largest.length)} tables`}
              />
            </>
          )}
        </div>
      </Card>
    </div>
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

const UPDATES = 10;

function Diagnostics({m}: {m: any}) {
  const archive = m.archive?.archive ?? {};
  const updates: any[] = Array.isArray(archive.workflows) ? archive.workflows : [];
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const [page, setPage] = useState(0);
  const shown = updates.filter(
    row => filter === 'all' || ['pending', 'running', 'failed', 'ambiguous'].includes(row.state),
  );
  const at = Math.min(page, Math.max(0, Math.ceil(shown.length / UPDATES) - 1));
  return (
    <>
      {m.telegram_incident && (
        <Notice
          tone={m.runtime?.status?.telegram === 'connected' ? 'info' : 'warn'}
          title={`Last Telegram problem · ${dateTime(m.telegram_incident.at)}`}
        >
          {telegramReason(m.telegram_incident.error_code) || 'Reason not recorded.'}
          {m.runtime?.status?.telegram === 'connected' && ' Telegram is working again.'}
        </Notice>
      )}
      <Card>
        <CardHeader
          title="Latest Telegram messages"
          description="How the newest messages from Telegram were handled."
          action={
            <Segmented
              size="sm"
              label="Which messages"
              value={filter}
              onChange={next => {
                setFilter(next);
                setPage(0);
              }}
              options={[
                {value: 'all', label: 'All'},
                {value: 'attention', label: 'Needs attention'},
              ]}
            />
          }
        />
        <div className="mt-3 border-t border-line">
          {!Array.isArray(archive.workflows) ? (
            <p className="px-5 py-4 text-[13px] text-muted">Telegram history couldn’t be read.</p>
          ) : !shown.length ? (
            <p className="px-5 py-4 text-[13px] text-muted">
              {updates.length ? 'Nothing needs attention.' : 'No Telegram messages have arrived yet.'}
            </p>
          ) : (
            <>
              <Table aria-label="Latest Telegram messages">
                <thead>
                  <tr>
                    <Th scope="col">Received</Th>
                    <Th scope="col" className="text-right">
                      Tries
                    </Th>
                    <Th scope="col">Status</Th>
                    <Th scope="col">
                      <span className="sr-only">Open</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(at * UPDATES, at * UPDATES + UPDATES).map(row => {
                    const state = updateStates[row.state] ?? {label: readable(row.state), tone: 'neutral' as Tone};
                    return (
                      <tr key={row.event_id}>
                        <Td className="py-2 text-[13px]">{dateTime(row.received_at)}</Td>
                        <Td className="tabular py-2 text-right text-[13px] text-muted">{row.attempts}</Td>
                        <Td className="py-2">
                          <State tone={state.tone}>{state.label}</State>
                        </Td>
                        <Td className="py-2 text-right text-[13px]">
                          <a
                            className="text-accent-text hover:underline"
                            href={href('messages', {source: row.event_id})}
                          >
                            Open
                          </a>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              <Pager
                page={at}
                hasNext={(at + 1) * UPDATES < shown.length}
                onPage={setPage}
                summary={`${count(shown.length)} ${shown.length === 1 ? 'message' : 'messages'}`}
              />
            </>
          )}
        </div>
        <div className="border-t border-line px-5 py-3">
          <Technical value={m} summary="Full status data" />
        </div>
      </Card>
    </>
  );
}

/**
 * Memory › Long-term: whether long-term memory is connected, up to date and
 * usable; connecting it; its monthly spending limit; re-running or replacing
 * it; and a look at what it holds.
 */
import {useEffect, useRef, useState, type ReactNode} from 'react';
import {apiPost} from '../../lib/api';
import {refreshResources, useResource} from '../../lib/resource';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  LoadError,
  LoadingRows,
  Notice,
  Select,
  SettingRow,
  Skeleton,
  Technical,
  type Tone,
} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {Rebuild} from './rebuild';
import {CONFLICT_TEXT, Meter, errorWords, useCommand} from './shared';

type MemoryStatus = {
  connection: {attached: boolean; verified: boolean; revision?: number; include_history?: boolean};
  limited_memory?: boolean;
  syncing?: boolean;
  receipts?: {state: string; count: number}[];
  workspace?: {id: string; state: string; last_ready_at: string | null; error_code: string | null} | null;
};
type ServiceStatus = {running: boolean; reasoning_provider_configured: boolean; embedding_credential: boolean};
type Budget = {
  limit_cents: number;
  max_limit_cents: number;
  revision: number;
  mode: 'monthly' | 'pilot';
  limit_usd: number;
  counted_toward_cap_usd: number;
  remaining_usd: number;
  estimated_embedding_cost_usd: number;
  embedding_tokens: number;
  embedding_requests: number;
  embedding_unreported_requests?: number;
  released_error_holds_usd?: number;
  legacy_error_exposure_unverified_usd?: number;
  reasoning_requests: number;
  reasoning_request_limit: number;
  reasoning_remaining_requests: number;
  window_started_at?: string;
};

const usd = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  }).format(value);

export function LongTerm() {
  const memory = useResource<MemoryStatus>('/memory/honcho', 10000);
  const service = useResource<ServiceStatus>('/honcho/status', 30000);
  const ready = !!memory.data?.connection.attached && !!memory.data.connection.verified;
  return (
    <>
      <StatusCard memory={memory} service={service} />
      <BudgetCard editable={ready} />
      {memory.data && <Rebuild revision={memory.data.connection.revision ?? 0} attached={ready} />}
      <Browse running={!!service.data?.running} workspace={memory.data?.workspace?.id ?? ''} />
    </>
  );
}

function StatusRow({label, tone, value, detail}: {label: string; tone: Tone; value: string; detail?: ReactNode}) {
  return (
    <div className="rounded-xl border border-line px-4 py-3 sm:p-4">
      <div className="flex items-center justify-between gap-3 sm:block">
        <p className="text-[13px] text-muted">{label}</p>
        <Badge tone={tone} dot className="text-[13px] sm:mt-1.5">
          {value}
        </Badge>
      </div>
      {detail && <div className="mt-2 text-xs text-muted">{detail}</div>}
    </div>
  );
}

function StatusCard({
  memory,
  service,
}: {
  memory: {data: MemoryStatus | null; error: string};
  service: {data: ServiceStatus | null; error: string};
}) {
  const feedback = useFeedback();
  const command = useCommand();
  const data = memory.data;
  const [history, setHistory] = useState(false);
  const [catchUp, setCatchUp] = useState(false);
  const seeded = useRef(false);
  useEffect(() => {
    if (data && !seeded.current) {
      seeded.current = true;
      setHistory(!!data.connection.include_history);
    }
  }, [data]);

  if (!data)
    return (
      <Card>
        <CardHeader title="Long-term memory" />
        <CardBody>
          {memory.error ? (
            <LoadError what="long-term memory" onRetry={() => void refreshResources()} />
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          )}
        </CardBody>
      </Card>
    );

  const {attached, verified} = data.connection;
  const receipts = data.receipts ?? [];
  const total = receipts.reduce((sum, row) => sum + row.count, 0);
  const done = receipts.filter(row => row.state === 'done').reduce((sum, row) => sum + row.count, 0);
  const failed = receipts.filter(row => /fail|error/.test(row.state)).reduce((sum, row) => sum + row.count, 0);
  const catching = !!data.syncing || (attached && total > done + failed);

  const connected: [Tone, string, string] = !attached
    ? ['neutral', 'Not connected', 'Nocheh uses its notes and message search instead.']
    : verified
      ? ['good', 'Connected', 'Learns from chats you allowed.']
      : ['warn', 'Waiting for checks', 'It hasn’t passed its live checks yet.'];
  const fresh: [Tone, string, ReactNode] = !attached
    ? ['neutral', 'Paused', 'Nothing is sent while disconnected.']
    : failed > 0 || data.workspace?.error_code
      ? ['bad', 'Some items failed', failed ? `${failed} couldn’t be saved.` : 'The last update failed.']
      : catching
        ? [
            'info',
            'Catching up',
            total ? (
              <div className="space-y-1.5">
                <Meter value={(100 * done) / total} label="Saved to long-term memory" />
                <span>
                  {done.toLocaleString()} of {total.toLocaleString()} saved
                </span>
              </div>
            ) : (
              'Preparing what it learned.'
            ),
          ]
        : ['good', 'Up to date', total ? `${done.toLocaleString()} items saved.` : 'Nothing waiting.'];
  const usable: [Tone, string, string] =
    data.limited_memory === false
      ? ['good', 'Ready', 'The assistant can recall from it now.']
      : ['warn', 'Limited', 'Until it’s ready, replies use notes and message search.'];

  const change = async (attach: boolean) => {
    if (
      !attach &&
      !(await feedback.confirm({
        title: 'Disconnect long-term memory?',
        body: 'Nocheh stops sending new things to it and stops recalling from it. Your messages and notes are kept.',
        confirm: 'Disconnect',
        danger: true,
      }))
    )
      return;
    const result = await command.run('/memory/honcho', {
      attached: attach,
      include_history: history,
      catch_up: catchUp,
      expected_revision: data.connection.revision ?? 0,
    });
    if (result)
      feedback.toast(attach ? 'Long-term memory connected. It is catching up now.' : 'Long-term memory disconnected.');
  };

  return (
    <Card>
      <CardHeader
        title="Long-term memory"
        description="Remembers across chats and months, beyond the assistant’s short notes."
      />
      <CardBody className="space-y-5">
        {memory.error && <LoadError what="the latest status" onRetry={() => void refreshResources()} />}
        <div className="grid gap-3 sm:grid-cols-3">
          <StatusRow label="Connected" tone={connected[0]} value={connected[1]} detail={connected[2]} />
          <StatusRow label="Up to date" tone={fresh[0]} value={fresh[1]} detail={fresh[2]} />
          <StatusRow label="Usable" tone={usable[0]} value={usable[1]} detail={usable[2]} />
        </div>

        <div className="space-y-3 rounded-xl bg-subtle/60 p-4">
          {!attached && (
            <fieldset className="space-y-0.5">
              <legend className="mb-1 text-[13px] font-medium">When connecting</legend>
              <label className="-mx-2 flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-subtle">
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-accent"
                  checked={history}
                  onChange={event => setHistory(event.target.checked)}
                />
                <span>Include older history you already agreed to share</span>
              </label>
              <label className="-mx-2 flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-subtle">
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-accent"
                  checked={catchUp}
                  onChange={event => setCatchUp(event.target.checked)}
                />
                <span>Catch up on messages that arrived while it was disconnected</span>
              </label>
              <p className="text-xs text-muted">
                This doesn’t allow learning from anything you haven’t already allowed.
              </p>
            </fieldset>
          )}
          {command.error && (
            <Notice
              tone={command.error === CONFLICT_TEXT ? 'warn' : 'bad'}
              action={
                command.error === CONFLICT_TEXT && (
                  <Button size="sm" onClick={() => void refreshResources().then(command.clear)}>
                    Reload
                  </Button>
                )
              }
            >
              {command.error}
            </Notice>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {attached ? (
              <Button variant="danger" busy={command.busy} onClick={() => void change(false)}>
                Disconnect
              </Button>
            ) : (
              <Button variant="primary" busy={command.busy} disabled={!verified} onClick={() => void change(true)}>
                Connect long-term memory
              </Button>
            )}
            {!attached && !verified && (
              <p className="text-[13px] text-muted">It can be connected once its live checks have passed.</p>
            )}
          </div>
        </div>

        <ServiceChecks service={service} />
        <Technical value={data} />
      </CardBody>
    </Card>
  );
}

function ServiceChecks({service}: {service: {data: ServiceStatus | null; error: string}}) {
  if (service.error && !service.data)
    return <p className="text-[13px] text-muted">Couldn’t check the memory service.</p>;
  if (!service.data) return <LoadingRows rows={1} />;
  const rows: [string, boolean, string, string?][] = [
    ['Memory service', service.data.running, service.data.running ? 'Running' : 'Stopped'],
    [
      'Model for memory',
      service.data.reasoning_provider_configured,
      service.data.reasoning_provider_configured ? 'Chosen' : 'Not chosen',
      '#settings?view=models',
    ],
    [
      'Key for memory search',
      service.data.embedding_credential,
      service.data.embedding_credential ? 'Added' : 'Missing',
    ],
  ];
  return (
    <ul className="flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
      {rows.map(([label, ok, value, link]) => (
        <li key={label} className="flex items-center gap-2">
          <span className="text-muted">{label}</span>
          <Badge tone={ok ? 'good' : 'warn'}>{value}</Badge>
          {!ok && link && (
            <a className="text-accent-text hover:underline" href={link}>
              Choose
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

function BudgetCard({editable}: {editable: boolean}) {
  const budget = useResource<Budget>('/honcho/budget', 15000);
  const data = budget.data;
  return (
    <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
      <Card>
        <CardHeader
          title="Spending limit for memory search"
          description="Memory search is billed per use. Nocheh stops searching for the month at this limit."
        />
        <CardBody className="space-y-4">
          {budget.error && <LoadError what="the spending limit" onRetry={() => void refreshResources()} />}
          {!data && !budget.error && <LoadingRows rows={2} />}
          {data && (
            <>
              <div className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="tabular text-2xl font-semibold tracking-tight">
                    {usd(data.counted_toward_cap_usd)}
                    <span className="text-sm font-normal text-muted"> of {usd(data.limit_usd)} this month</span>
                  </p>
                  <p className="text-[13px] text-muted">{usd(data.remaining_usd)} left</p>
                </div>
                {data.limit_usd > 0 && (
                  <Meter
                    value={(100 * data.counted_toward_cap_usd) / data.limit_usd}
                    tone={
                      data.remaining_usd <= 0
                        ? 'bad'
                        : data.counted_toward_cap_usd / data.limit_usd > 0.8
                          ? 'warn'
                          : 'accent'
                    }
                    label="Spending limit used"
                  />
                )}
                <p className="text-xs text-muted">
                  Estimated cost so far: {usd(data.estimated_embedding_cost_usd)} for{' '}
                  {data.embedding_requests.toLocaleString()} searches ({data.embedding_tokens.toLocaleString()} tokens
                  reported). This is an estimate, not your provider’s bill.
                </p>
                {!!data.embedding_unreported_requests && (
                  <p className="text-xs text-warn">
                    {data.embedding_unreported_requests.toLocaleString()}{' '}
                    {data.embedding_unreported_requests === 1 ? 'search came' : 'searches came'} back without a usage
                    report, so each still counts its full reserved amount.
                  </p>
                )}
                {(!!data.released_error_holds_usd || !!data.legacy_error_exposure_unverified_usd) && (
                  <p className="text-xs text-muted">
                    {usd(data.released_error_holds_usd ?? 0)} reserved for failed searches was given back this month
                    {data.legacy_error_exposure_unverified_usd
                      ? `; ${usd(data.legacy_error_exposure_unverified_usd)} of older failures can’t be checked and isn’t counted as spending`
                      : ''}
                    .
                  </p>
                )}
              </div>
              {data.mode === 'monthly' && editable ? (
                <LimitForm budget={data} />
              ) : (
                <p className="text-[13px] text-muted">
                  {data.mode === 'monthly'
                    ? 'Connect long-term memory to change the limit.'
                    : `A fixed trial limit of ${usd(data.limit_usd)} applies until long-term memory is accepted.`}
                </p>
              )}
            </>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Memory thinking"
          description="How often long-term memory may ask the memory model this month. A count, not money."
        />
        <CardBody className="space-y-2">
          {!data && !budget.error && <LoadingRows rows={1} />}
          {data && (
            <>
              <p className="tabular text-2xl font-semibold tracking-tight">
                {data.reasoning_requests.toLocaleString()}
                <span className="text-sm font-normal text-muted">
                  {' '}
                  of {data.reasoning_request_limit.toLocaleString()} requests
                </span>
              </p>
              <Meter
                value={
                  data.reasoning_request_limit ? (100 * data.reasoning_requests) / data.reasoning_request_limit : 0
                }
                tone={data.reasoning_remaining_requests <= 0 ? 'bad' : 'accent'}
                label="Thinking requests used"
              />
              <p className="text-xs text-muted">
                {data.reasoning_remaining_requests.toLocaleString()} left. Resets each month.
              </p>
            </>
          )}
          {budget.error && !data && <p className="text-[13px] text-muted">Couldn’t load the request count.</p>}
        </CardBody>
      </Card>
    </div>
  );
}

function LimitForm({budget}: {budget: Budget}) {
  const feedback = useFeedback();
  const command = useCommand();
  const [draft, setDraft] = useState<string | null>(null);
  const [base, setBase] = useState(budget.revision);
  const [problem, setProblem] = useState('');
  const [adopt, setAdopt] = useState(false);
  useEffect(() => {
    if (draft === null || adopt) setBase(budget.revision);
    setAdopt(false);
  }, [budget.revision, draft, adopt]);
  const value = draft ?? (budget.limit_cents / 100).toFixed(2);
  const max = budget.max_limit_cents / 100;
  const conflict = base !== budget.revision || command.error === CONFLICT_TEXT;
  const save = async () => {
    setProblem('');
    if (!/^\d{1,5}(\.\d{1,2})?$/.test(value.trim())) return setProblem('Enter an amount like 5 or 7.50.');
    const cents = Math.round(Number(value) * 100);
    if (cents > budget.max_limit_cents) return setProblem(`The highest limit is ${usd(max)}.`);
    const result = await command.run<Budget>('/honcho/budget', {limit_cents: cents, expected_revision: base});
    if (result) {
      setDraft(null);
      setBase(result.revision);
      feedback.toast(`Monthly limit set to ${usd(result.limit_cents / 100)}.`);
    }
  };
  return (
    <form
      className="space-y-3 border-t border-line pt-4"
      onSubmit={event => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <Field
          label="Monthly limit (US dollars)"
          htmlFor="memory-limit"
          error={problem}
          hint={`From $0 (pause) to ${usd(max)}.`}
        >
          <div className="relative w-40">
            <span className="pointer-events-none absolute top-2 left-3 text-sm text-muted">$</span>
            <Input
              id="memory-limit"
              inputMode="decimal"
              className="pl-6"
              value={value}
              onChange={event => {
                setDraft(event.target.value);
                setProblem('');
                command.clear();
              }}
            />
          </div>
        </Field>
        <Button
          type="submit"
          variant="primary"
          className="mb-[22px]"
          busy={command.busy}
          disabled={draft === null || conflict || value.trim() === (budget.limit_cents / 100).toFixed(2)}
        >
          Save limit
        </Button>
      </div>
      {conflict ? (
        <Notice
          tone="warn"
          action={
            <Button
              size="sm"
              onClick={async () => {
                command.clear();
                await refreshResources();
                setAdopt(true);
              }}
            >
              Reload
            </Button>
          }
        >
          {CONFLICT_TEXT}
        </Notice>
      ) : (
        command.error && <Notice tone="bad">{command.error}</Notice>
      )}
    </form>
  );
}

type Kind = 'workspace' | 'peer' | 'session';
const kindText: Record<Kind, string> = {
  workspace: 'Memory spaces',
  peer: 'People and assistants',
  session: 'Conversations',
};

function Browse({running, workspace}: {running: boolean; workspace: string}) {
  const [kind, setKind] = useState<Kind>('peer');
  const [space, setSpace] = useState('');
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const chosenSpace = space || workspace;
  const look = async () => {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(
        await apiPost('/honcho/read', {
          args: kind === 'workspace' ? ['workspace', 'list'] : [kind, 'list', '-w', chosenSpace.trim()],
        }),
      );
    } catch (failure) {
      setError(errorWords(failure));
    } finally {
      setBusy(false);
    }
  };
  const items = listItems(result);
  return (
    <Card>
      <CardHeader
        title="What it remembers"
        description="Look at what long-term memory has stored. Looking doesn’t change anything."
      />
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Show" htmlFor="browse-kind" className="w-56">
            <Select
              id="browse-kind"
              value={kind}
              onChange={event => {
                setKind(event.target.value as Kind);
                setResult(null);
              }}
            >
              {(Object.keys(kindText) as Kind[]).map(value => (
                <option key={value} value={value}>
                  {kindText[value]}
                </option>
              ))}
            </Select>
          </Field>
          {kind !== 'workspace' && (
            <Field label="Memory space" htmlFor="browse-space" className="min-w-48 flex-1">
              <Input
                id="browse-space"
                value={space}
                placeholder={workspace || 'Memory space ID'}
                onChange={event => {
                  setSpace(event.target.value);
                  setResult(null);
                }}
              />
            </Field>
          )}
          <Button
            busy={busy}
            disabled={!running || (kind !== 'workspace' && !chosenSpace.trim())}
            onClick={() => void look()}
          >
            Look
          </Button>
        </div>
        {!running && <p className="text-[13px] text-muted">Available while the memory service is running.</p>}
        {error && <Notice tone="bad">{error}</Notice>}
        {result?.error && <Notice tone="warn">{errorWords(result.error)}</Notice>}
        {result && !result.error && (
          <>
            {items.length ? (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {items.slice(0, 50).map((item, index) => (
                  <li key={index} className="px-4 py-2 text-sm break-all">
                    {item}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">Nothing stored here yet.</p>
            )}
            {result.complete === false && <p className="text-xs text-muted">Only the first page is shown.</p>}
            <Technical value={result} summary="Full answer" />
          </>
        )}
      </CardBody>
    </Card>
  );
}

/** The names or ids in the first list found in a read answer. */
function listItems(value: any): string[] {
  if (!value || typeof value !== 'object') return [];
  const list = Array.isArray(value) ? value : Object.values(value).find(Array.isArray);
  if (!Array.isArray(list)) return [];
  return list.map(item =>
    typeof item === 'string' ? item : String(item?.name ?? item?.title ?? item?.id ?? JSON.stringify(item)),
  );
}

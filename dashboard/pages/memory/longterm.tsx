/**
 * Memory › Long-term: whether long-term memory is connected, up to date and
 * usable; connecting it; its monthly spending limit; re-running or replacing
 * it; the facts it learned with where each came from; and a look at what it holds.
 */
import {useEffect, useRef, useState, type ReactNode} from 'react';
import {apiPost} from '../../lib/api';
import {useParam} from '../../lib/navigation';
import {refreshResources, useResource} from '../../lib/resource';
import {setParams} from '../../lib/routes';
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
  Switch,
  Table,
  Td,
  Technical,
  Th,
  type Tone,
} from '../../ui/core';
import {Dialog, useFeedback} from '../../ui/overlay';
import {SubPanel, SubTabs} from '../../ui/page';
import {LongTermFacts} from './longterm-facts';
import {Rebuild} from './rebuild';
import {CONFLICT_TEXT, Meter, errorWords, useCommand} from './shared';

type MemoryStatus = {
  connection: {attached: boolean; verified: boolean; revision?: number; include_history?: boolean};
  limited_memory?: boolean;
  syncing?: boolean;
  receipts?: {state: string; count: number}[];
  workspace?: {id: string; state: string; last_ready_at: string | null; error_code: string | null} | null;
  /** The memory engine plugged in behind long-term memory. Another engine can replace it later. */
  engine?: {
    id: string;
    name: string;
    capabilities?: {inspect?: boolean; evidence?: boolean; retry_failed_learning?: boolean};
  };
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
  /** Null while no thinking limit is turned on. */
  reasoning_request_limit: number | null;
  reasoning_remaining_requests: number | null;
  suggested_reasoning_limit: number;
  max_reasoning_limit: number;
  window_started_at?: string;
};

const usd = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  }).format(value);

const subTabs = ['status', 'actions', 'facts'] as const;

export function LongTerm() {
  const memory = useResource<MemoryStatus>('/memory/longterm', 10000);
  const service = useResource<ServiceStatus>('/honcho/status', 30000);
  const attached = !!memory.data?.connection.attached;
  // Spending limit changes still follow the server's accepted-memory rule.
  const budgetEditable = attached && !!memory.data?.connection.verified;
  // A link to one chat's or one person's facts opens on the facts.
  const chosen = useParam('tab');
  const chat = useParam('chat'),
    about = useParam('about');
  const filtered = !!chat || !!about;
  const tab = subTabs.find(id => id === chosen) ?? (filtered ? 'facts' : 'status');
  return (
    <>
      <SubTabs
        label="Long-term memory"
        value={tab}
        onChange={next => setParams({tab: next})}
        tabs={[
          {id: 'status', label: 'Status and limits'},
          {id: 'actions', label: 'Re-run and look'},
          {id: 'facts', label: 'Facts it learned'},
        ]}
      />
      <SubPanel id="status" current={tab}>
        <div className="grid items-start gap-5 lg:grid-cols-[3fr_2fr]">
          <StatusCard memory={memory} service={service} />
          <BudgetCard editable={budgetEditable} />
        </div>
      </SubPanel>
      <SubPanel id="actions" current={tab}>
        <div className="grid items-start gap-5 lg:grid-cols-[3fr_2fr]">
          {memory.data && <Rebuild revision={memory.data.connection.revision ?? 0} attached={attached} />}
          {memory.data?.engine?.capabilities?.inspect && (
            <Browse running={!!service.data?.running} workspace={memory.data.workspace?.id ?? ''} />
          )}
        </div>
      </SubPanel>
      <SubPanel id="facts" current={tab}>
        {memory.data && <LongTermFacts />}
      </SubPanel>
    </>
  );
}

/** One line of the status table: what is checked, how it stands, and what that means. */
function StatusRow({label, tone, value, detail}: {label: string; tone: Tone; value: string; detail?: ReactNode}) {
  return (
    // On a phone the check and its status share a line and what it means sits under them.
    <tr className="max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:border-b max-sm:border-line max-sm:py-1.5">
      <Th
        scope="row"
        className="bg-transparent text-[13px] font-normal text-fg max-sm:flex-1 max-sm:border-0 max-sm:py-1"
      >
        {label}
      </Th>
      <Td className="whitespace-nowrap max-sm:border-0 max-sm:py-1">
        <Badge tone={tone} dot>
          {value}
        </Badge>
      </Td>
      <Td className="text-xs text-muted max-sm:w-full max-sm:border-0 max-sm:pt-0 max-sm:pb-1">{detail}</Td>
    </tr>
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
            <Skeleton className="h-48" />
          )}
        </CardBody>
      </Card>
    );

  const {attached} = data.connection;
  const receipts = data.receipts ?? [];
  const total = receipts.reduce((sum, row) => sum + row.count, 0);
  const done = receipts.filter(row => row.state === 'done').reduce((sum, row) => sum + row.count, 0);
  const failed = receipts.filter(row => /fail|error/.test(row.state)).reduce((sum, row) => sum + row.count, 0);
  const catching = !!data.syncing || (attached && total > done + failed);

  const connected: [Tone, string, string] = !attached
    ? ['neutral', 'Not connected', 'Nocheh uses its notes and message search instead.']
    : ['good', 'Connected', 'Learns from chats you allowed.'];
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
    const result = await command.run('/memory/longterm', {
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
        action={
          data.engine && (
            <Badge tone="neutral" title="The memory engine Nocheh uses. Another engine can replace it later.">
              Engine: {data.engine.name}
            </Badge>
          )
        }
      />
      {memory.error && (
        <div className="px-5 pb-3">
          <LoadError what="the latest status" onRetry={() => void refreshResources()} />
        </div>
      )}
      <Table aria-label="Long-term memory status" className="table-fixed max-sm:block">
        <thead className="max-sm:sr-only">
          <tr>
            <Th scope="col" className="w-2/5 sm:w-1/4">
              Check
            </Th>
            <Th scope="col" className="sm:w-1/4">
              Status
            </Th>
            <Th scope="col">What it means</Th>
          </tr>
        </thead>
        <tbody className="max-sm:block">
          <StatusRow label="Connected" tone={connected[0]} value={connected[1]} detail={connected[2]} />
          <StatusRow label="Up to date" tone={fresh[0]} value={fresh[1]} detail={fresh[2]} />
          <StatusRow label="Usable" tone={usable[0]} value={usable[1]} detail={usable[2]} />
          <ServiceChecks service={service} />
        </tbody>
      </Table>
      <CardBody className="space-y-3">
        {!attached && (
          <fieldset className="space-y-0.5">
            <legend className="mb-1 text-[13px] font-medium">When connecting</legend>
            <label className="-mx-2 flex min-h-9 cursor-pointer items-center gap-3 rounded-md px-2 py-1 text-sm hover:bg-subtle">
              <input
                type="checkbox"
                className="size-4 shrink-0 accent-accent"
                checked={history}
                onChange={event => setHistory(event.target.checked)}
              />
              <span>Include older history you already agreed to share</span>
            </label>
            <label className="-mx-2 flex min-h-9 cursor-pointer items-center gap-3 rounded-md px-2 py-1 text-sm hover:bg-subtle">
              <input
                type="checkbox"
                className="size-4 shrink-0 accent-accent"
                checked={catchUp}
                onChange={event => setCatchUp(event.target.checked)}
              />
              <span>Catch up on messages that arrived while it was disconnected</span>
            </label>
            <p className="text-xs text-muted">This doesn’t allow learning from anything you haven’t already allowed.</p>
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Technical value={data} />
          {attached ? (
            <Button variant="danger" size="sm" busy={command.busy} onClick={() => void change(false)}>
              Disconnect
            </Button>
          ) : (
            <Button variant="primary" busy={command.busy} onClick={() => void change(true)}>
              Connect long-term memory
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

/** The memory service's own checks, as rows of the status table. */
function ServiceChecks({service}: {service: {data: ServiceStatus | null; error: string}}) {
  if (!service.data)
    return (
      <tr>
        <Td colSpan={3} className="text-[13px] text-muted">
          {service.error ? 'Couldn’t check the memory service.' : 'Checking the memory service…'}
        </Td>
      </tr>
    );
  const rows: [string, boolean, string, ReactNode][] = [
    [
      'Memory service',
      service.data.running,
      service.data.running ? 'Running' : 'Stopped',
      'The program that stores and learns.',
    ],
    [
      'Model for memory',
      service.data.reasoning_provider_configured,
      service.data.reasoning_provider_configured ? 'Chosen' : 'Not chosen',
      service.data.reasoning_provider_configured ? (
        'The model that learns facts from messages.'
      ) : (
        <a className="text-accent-text hover:underline" href="#settings?view=models">
          Choose
        </a>
      ),
    ],
    [
      'Key for memory search',
      service.data.embedding_credential,
      service.data.embedding_credential ? 'Added' : 'Missing',
      'Lets memory find facts by meaning.',
    ],
  ];
  return (
    <>
      {rows.map(([label, ok, value, detail]) => (
        <StatusRow key={label} label={label} tone={ok ? 'good' : 'warn'} value={value} detail={detail} />
      ))}
    </>
  );
}

/** This month's two limits as one small table; each limit is changed in its own dialog. */
function BudgetCard({editable}: {editable: boolean}) {
  const budget = useResource<Budget>('/honcho/budget', 15000);
  const data = budget.data;
  const [editing, setEditing] = useState<'search' | 'thinking' | null>(null);
  const monthly = data?.mode === 'monthly';
  return (
    <Card>
      <CardHeader
        title="Limits this month"
        description="Memory search is billed per use and stops at its limit. Memory thinking is a count of requests, not money."
      />
      {budget.error && (
        <div className="px-5 pb-3">
          <LoadError what="the limits" onRetry={() => void refreshResources()} />
        </div>
      )}
      {!data && !budget.error && <LoadingRows rows={2} />}
      {data && (
        <>
          <Table aria-label="Limits this month" className="table-fixed">
            <thead>
              <tr>
                <Th scope="col">Limit</Th>
                <Th scope="col">Used</Th>
                <Th scope="col" className="w-24">
                  <span className="sr-only">Change</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <Th scope="row" className="bg-transparent align-top text-[13px] font-normal whitespace-normal text-fg">
                  Memory search spending
                </Th>
                <Td className="space-y-1.5">
                  <p className="tabular text-sm">
                    <span className="font-semibold">{usd(data.counted_toward_cap_usd)}</span>
                    <span className="text-muted"> of {usd(data.limit_usd)}</span>
                  </p>
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
                  <p className="text-xs text-muted">{usd(data.remaining_usd)} left</p>
                </Td>
                <Td className="text-right">
                  {monthly && editable && (
                    <Button size="sm" onClick={() => setEditing('search')}>
                      Change
                    </Button>
                  )}
                </Td>
              </tr>
              <tr>
                <Th scope="row" className="bg-transparent align-top text-[13px] font-normal whitespace-normal text-fg">
                  Memory thinking requests
                </Th>
                <Td className="space-y-1.5">
                  <p className="tabular text-sm">
                    <span className="font-semibold">{data.reasoning_requests.toLocaleString()}</span>
                    <span className="text-muted">
                      {data.reasoning_request_limit === null
                        ? ' requests, no limit'
                        : ` of ${data.reasoning_request_limit.toLocaleString()}`}
                    </span>
                  </p>
                  {data.reasoning_request_limit !== null && data.reasoning_remaining_requests !== null && (
                    <>
                      <Meter
                        value={(100 * data.reasoning_requests) / data.reasoning_request_limit}
                        tone={data.reasoning_remaining_requests <= 0 ? 'bad' : 'accent'}
                        label="Thinking requests used"
                      />
                      <p className="text-xs text-muted">{data.reasoning_remaining_requests.toLocaleString()} left</p>
                    </>
                  )}
                </Td>
                <Td className="text-right">
                  {editable && (
                    <Button size="sm" onClick={() => setEditing('thinking')}>
                      Change
                    </Button>
                  )}
                </Td>
              </tr>
            </tbody>
          </Table>
          <CardBody className="space-y-1.5 text-xs text-muted">
            <p>
              Estimated search cost so far: {usd(data.estimated_embedding_cost_usd)} for{' '}
              {data.embedding_requests.toLocaleString()} searches ({data.embedding_tokens.toLocaleString()} tokens
              reported). This is an estimate, not your provider’s bill.
            </p>
            {!!data.embedding_unreported_requests && (
              <p className="text-warn">
                {data.embedding_unreported_requests.toLocaleString()}{' '}
                {data.embedding_unreported_requests === 1 ? 'search came' : 'searches came'} back without a usage
                report, so each still counts its full reserved amount.
              </p>
            )}
            {(!!data.released_error_holds_usd || !!data.legacy_error_exposure_unverified_usd) && (
              <p>
                {usd(data.released_error_holds_usd ?? 0)} reserved for failed searches was given back this month
                {data.legacy_error_exposure_unverified_usd
                  ? `; ${usd(data.legacy_error_exposure_unverified_usd)} of older failures can’t be checked and isn’t counted as spending`
                  : ''}
                .
              </p>
            )}
            {!monthly ? (
              <p>A fixed trial limit of {usd(data.limit_usd)} applies until long-term memory is accepted.</p>
            ) : (
              !editable && <p>Connect long-term memory to change the limits.</p>
            )}
            {monthly && <p>Both reset each month.</p>}
          </CardBody>
          <Dialog
            open={editing === 'search'}
            onOpenChange={open => !open && setEditing(null)}
            title="Spending limit for memory search"
            description="Nocheh stops searching memory for the month at this limit."
          >
            <LimitForm budget={data} />
          </Dialog>
          <Dialog
            open={editing === 'thinking'}
            onOpenChange={open => !open && setEditing(null)}
            title="Memory thinking limit"
            description="How often long-term memory may ask the memory model each month."
          >
            <ThinkingLimitForm budget={data} />
          </Dialog>
        </>
      )}
    </Card>
  );
}

function ThinkingLimitForm({budget}: {budget: Budget}) {
  const feedback = useFeedback();
  const command = useCommand();
  const saved = budget.reasoning_request_limit;
  const [on, setOn] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const enabled = on ?? saved !== null;
  const value = draft ?? String(saved ?? budget.suggested_reasoning_limit);
  const changed = enabled !== (saved !== null) || (enabled && value.trim() !== String(saved));
  const save = async () => {
    setProblem('');
    const limit = enabled ? Number(value.trim()) : null;
    if (limit !== null && (!/^\d{1,7}$/.test(value.trim()) || limit < 1 || limit > budget.max_reasoning_limit))
      return setProblem(`Enter a whole number from 1 to ${budget.max_reasoning_limit.toLocaleString()}.`);
    const result = await command.run<Budget>('/honcho/budget', {
      reasoning_limit: limit,
      expected_revision: budget.revision,
    });
    if (result) {
      setOn(null);
      setDraft(null);
      feedback.toast(
        result.reasoning_request_limit === null
          ? 'Memory thinking has no limit now.'
          : `Memory thinking is limited to ${result.reasoning_request_limit.toLocaleString()} requests a month.`,
      );
    }
  };
  return (
    <form
      className="space-y-3"
      onSubmit={event => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-3">
        <Switch
          id="thinking-limit-on"
          checked={enabled}
          label="Limit thinking requests each month"
          onChange={checked => {
            setOn(checked);
            setProblem('');
            command.clear();
          }}
        />
        <label htmlFor="thinking-limit-on" className="text-sm">
          Limit thinking requests each month
        </label>
      </div>
      {enabled && (
        <Field label="Requests a month" htmlFor="thinking-limit" error={problem}>
          <Input
            id="thinking-limit"
            inputMode="numeric"
            className="w-40"
            value={value}
            onChange={event => {
              setDraft(event.target.value);
              setProblem('');
              command.clear();
            }}
          />
        </Field>
      )}
      <Button type="submit" variant="primary" busy={command.busy} disabled={!changed}>
        Save
      </Button>
      {command.error && <Notice tone="bad">{command.error}</Notice>}
    </form>
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
      className="space-y-3"
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

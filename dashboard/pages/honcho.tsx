import {useEffect, useState, type FormEvent} from 'react';
import {
  call,
  button,
  errorText,
  Panel,
  Data,
  friendlyState,
  Details,
  useResource,
  StatusBadge,
  Button,
  Alert,
  Progress,
} from '../lib/page-helpers';
import {useOwnerCommand} from '../lib/owner-controls';

type Notify = (message: string, error?: boolean) => void;

const dollars = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value > 0 && value < 0.1 ? 6 : 2,
    maximumFractionDigits: value > 0 && value < 0.1 ? 6 : 2,
  }).format(value);
const percentLabel = (value: number) => (value > 0 && value < 1 ? 'Less than 1%' : Math.round(value) + '%');

function HonchoBudget({notify, editable}: {notify: Notify; editable: boolean}) {
  const {data: budget, error} = useResource('/honcho/budget', 10000),
    command = useOwnerCommand();
  const [draft, setDraft] = useState(''),
    [draftRevision, setDraftRevision] = useState<any>(null),
    [dirty, setDirty] = useState(false),
    [inputError, setInputError] = useState('');
  useEffect(() => {
    if (budget && !dirty) {
      setDraft((budget.limit_cents / 100).toFixed(2));
      setDraftRevision(budget.revision);
    }
  }, [budget?.limit_cents, budget?.revision, dirty]);
  const changed = dirty && budget && draftRevision !== budget.revision;
  const reload = () => {
    setDraft((budget.limit_cents / 100).toFixed(2));
    setDraftRevision(budget.revision);
    setDirty(false);
    setInputError('');
    command.clear();
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setInputError('');
    if (!/^\d{1,5}(?:\.\d{1,2})?$/.test(draft.trim())) {
      setInputError('Enter a dollar amount with no more than two decimal places.');
      return;
    }
    const cents = Math.round(Number(draft) * 100);
    if (cents > budget.max_limit_cents) {
      setInputError('The maximum monthly cap is ' + dollars(budget.max_limit_cents / 100) + '.');
      return;
    }
    const result = await command.run('/honcho/budget', {limit_cents: cents, expected_revision: draftRevision});
    if (result) {
      setDraft((result.limit_cents / 100).toFixed(2));
      setDraftRevision(result.revision);
      setDirty(false);
      notify('Monthly embedding cap updated.');
    }
  };
  return (
    <>
      <Panel
        title="API embedding budget"
        note="Paid OpenAI embeddings use the dedicated API key and this monthly dollar cap."
      >
        {error && <p role="alert">{error}</p>}
        {!budget && !error && <p role="status">Loading embedding budget…</p>}
        {budget && (
          <div>
            <div className="honcho-budget-summary">
              <div className="honcho-budget-stat">
                <small>Counted toward cap</small>
                <strong>{dollars(budget.counted_toward_cap_usd)}</strong>
                <span>{'of ' + dollars(budget.limit_usd) + ' cap'}</span>
              </div>
              <div className="honcho-budget-stat">
                <small>Remaining admission headroom</small>
                <strong>{dollars(budget.remaining_usd)}</strong>
                <span>{budget.mode === 'monthly' ? 'UTC monthly window' : 'Pilot budget'}</span>
              </div>
              <div className="honcho-budget-stat">
                <small>Estimated API cost</small>
                <strong>{dollars(budget.estimated_embedding_cost_usd)}</strong>
                <span>{budget.embedding_tokens.toLocaleString() + ' reported tokens'}</span>
              </div>
              <div className="honcho-budget-stat">
                <small>Embedding requests</small>
                <strong>{budget.embedding_requests.toLocaleString()}</strong>
                <span>{budget.embedding_unreported_requests.toLocaleString() + ' without a usage report'}</span>
              </div>
            </div>
            {budget.limit_usd > 0 && (
              <Progress
                value={Math.min(100, (100 * budget.counted_toward_cap_usd) / budget.limit_usd)}
                label={
                  percentLabel((100 * budget.counted_toward_cap_usd) / budget.limit_usd) + ' of embedding cap counted'
                }
              />
            )}
            <p className="n-muted honcho-budget-note">
              {'Each attempt holds $' +
                budget.embedding_hold_usd.toFixed(2) +
                ' before the API call. Reported successes settle by tokens; confirmed HTTP errors release their holds. Transport failures and calls without a usable response retain their holds. ' +
                dollars(budget.released_error_holds_usd || 0) +
                ' in error holds was released this window; ' +
                dollars(budget.legacy_error_exposure_unverified_usd || 0) +
                ' of that came from historical errors whose response type cannot be verified. The estimate covers reported Honcho tokens, not your provider invoice. '}
              <a href="https://platform.openai.com/usage" target="_blank" rel="noopener noreferrer">
                Check OpenAI API usage
              </a>
            </p>
            {budget.mode === 'monthly' && editable ? (
              <form className="honcho-budget-form" onSubmit={save}>
                <label htmlFor="honcho-budget-limit">Monthly embedding cap (USD)</label>
                <input
                  id="honcho-budget-limit"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={budget.max_limit_cents / 100}
                  step=".01"
                  value={draft}
                  aria-describedby={'honcho-budget-help' + (inputError ? ' honcho-budget-error' : '')}
                  aria-invalid={!!inputError}
                  onChange={event => {
                    setDraft(event.target.value);
                    setDirty(true);
                    setInputError('');
                  }}
                />
                <p id="honcho-budget-help" className="n-muted">
                  Set $0 to pause paid embeddings. Lowering the cap preserves all existing accounting.
                </p>
                {changed && <Alert>The cap changed elsewhere. Load the latest value before saving.</Alert>}
                {inputError && (
                  <p id="honcho-budget-error" role="alert" className="honcho-budget-error">
                    {inputError}
                  </p>
                )}
                {command.error && <Alert>{command.error}</Alert>}
                <div className="n-actions">
                  <Button type="submit" disabled={command.busy || changed || !dirty}>
                    {command.busy ? 'Saving…' : 'Save monthly cap'}
                  </Button>
                  {changed && button('Load latest cap', reload)}
                </div>
              </form>
            ) : (
              <p className="n-muted">
                {budget.mode === 'monthly'
                  ? 'Changing the monthly cap requires verified, attached Honcho memory.'
                  : 'The $5 pilot cap is fixed. Monthly editing becomes available after the pilot cutover and accepted attachment.'}
              </p>
            )}
          </div>
        )}
      </Panel>
      <Panel
        title="Reasoning request limit"
        note="Honcho LLM calls use the memory provider from Settings › Models, separate from the paid embedding key."
      >
        {error && <p role="alert">{error}</p>}
        {!budget && !error && <p role="status">Loading reasoning usage…</p>}
        {budget && (
          <div>
            <div className="honcho-budget-summary">
              <div className="honcho-budget-stat">
                <small>Reasoning requests this window</small>
                <strong>{budget.reasoning_requests.toLocaleString()}</strong>
                <span>{'of ' + budget.reasoning_request_limit.toLocaleString() + ' safety limit'}</span>
              </div>
              <div className="honcho-budget-stat">
                <small>Requests remaining</small>
                <strong>{budget.reasoning_remaining_requests.toLocaleString()}</strong>
                <span>{budget.mode === 'monthly' ? 'Resets with the UTC month' : 'Pilot window'}</span>
              </div>
            </div>
            <Progress
              value={Math.min(100, (100 * budget.reasoning_requests) / budget.reasoning_request_limit)}
              label={
                Math.round((100 * budget.reasoning_requests) / budget.reasoning_request_limit) +
                '% of reasoning request limit used'
              }
            />
            <p className="n-muted honcho-budget-note">
              This is a request safety limit, not a dollar budget. Reasoning calls do not consume the embedding cap.
            </p>
          </div>
        )}
      </Panel>
    </>
  );
}

const browseLabels: Record<string, string> = {
  workspace: 'Workspaces',
  peer: 'Peers · people and agents',
  session: 'Sessions · conversations',
};

export function Honcho({notify}: {notify: Notify}) {
  const [tick, setTick] = useState(0),
    {data: memory, error: memoryError} = useResource('/memory/honcho', 10000, tick),
    [history, setHistory] = useState(false),
    [catchUp, setCatchUp] = useState(false);
  const connectionCommand = useOwnerCommand();
  const connect = async (attached: boolean) => {
    const result = await connectionCommand.run('/memory/honcho', {
      attached,
      include_history: history,
      catch_up: catchUp,
      expected_revision: memory.connection.revision,
    });
    if (result) {
      setTick(v => v + 1);
      notify(
        attached
          ? 'Memory attached. Current authorized sources are being prepared.'
          : 'Memory detached. Originals and guarded edits are preserved.',
      );
    }
  };
  const {data: status, error} = useResource('/honcho/status', 10000),
    [workspace, setWorkspace] = useState(''),
    [kind, setKind] = useState('workspace'),
    [data, setData] = useState<any>(null),
    [busy, setBusy] = useState(false);
  const query = async () => {
    setBusy(true);
    setData(null);
    try {
      setData(
        await call('/honcho/read', {
          args: kind === 'workspace' ? ['workspace', 'list'] : [kind, 'list', '-w', workspace],
        }),
      );
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      setBusy(false);
    }
  };
  const total = ((memory?.receipts || []) as any[]).reduce((n: number, r) => n + r.count, 0),
    done = ((memory?.receipts || []) as any[]).filter(r => r.state === 'done').reduce((n: number, r) => n + r.count, 0);
  return (
    <div>
      <Panel
        title="Primary long-term memory"
        note="Honcho recalls learned sources. Hermes keeps compact native working notes. Originals and saved guarded copies remain in Nocheh."
      >
        {memoryError && <p role="alert">{memoryError}</p>}
        {memory && (
          <div>
            <div className="connection-grid">
              <div>
                <small>Connection</small>
                <StatusBadge
                  state={memory.connection.attached ? 'connected' : 'disabled'}
                  label={memory.connection.attached ? 'Attached' : 'Detached'}
                />
              </div>
              <div>
                <small>Memory availability</small>
                <StatusBadge
                  state={memory.limited_memory ? 'limited' : 'ready'}
                  label={memory.limited_memory ? 'Limited memory' : 'Current memory ready'}
                />
              </div>
              <div>
                <small>Synchronization</small>
                <StatusBadge
                  state={memory.syncing ? 'syncing' : 'unknown'}
                  label={memory.syncing ? 'Preparing current sources' : 'No build in progress'}
                />
              </div>
              <div>
                <small>Live compatibility</small>
                <StatusBadge state={memory.connection.verified ? 'verified' : 'unverified'} />
              </div>
            </div>
            {total > 0 && (
              <Progress
                value={(100 * done) / total}
                label={done + ' / ' + total + ' stored ingestion receipts complete'}
              />
            )}
            <p className="n-muted">
              Receipt counts describe recorded ingestion, not an estimate of all future sources. Native notes and
              archive search remain available.
            </p>
            <div className="health-strip">
              {(memory.receipts || []).map((r: any) => (
                <StatusBadge key={r.state} state={r.state} label={r.count + ' ' + friendlyState(r.state)} />
              ))}
            </div>

            {!memory.connection.verified && (
              <p className="n-muted">
                Live Honcho ingestion, recall, reasoning, restart and provider-failure checks are still pending.
                Attachment is disabled.
              </p>
            )}
            <fieldset className="honcho-attachment-options">
              <legend>When attaching memory</legend>
              <label className="honcho-attachment-option">
                <input type="checkbox" checked={history} onChange={e => setHistory(e.target.checked)} />
                <span>Include previously consented history when attaching</span>
              </label>
              <label className="honcho-attachment-option">
                <input type="checkbox" checked={catchUp} onChange={e => setCatchUp(e.target.checked)} />
                <span>Catch up on consented sources received while detached</span>
              </label>
            </fieldset>
            <p className="n-muted honcho-attachment-note">
              Previously learned sources rebuild in the current mode. These options do not approve learning from any new
              import.
            </p>
            {connectionCommand.error && <Alert>{connectionCommand.error}</Alert>}
            {button(
              memory.connection.attached ? 'Detach memory' : 'Attach memory',
              () => connect(!memory.connection.attached),
              connectionCommand.busy || !!memoryError || (!memory.connection.attached && !memory.connection.verified),
            )}
            <Details
              value={{
                workspace: memory.workspace,
                sessions: memory.sessions,
                receipts: memory.receipts,
                deletions: memory.deletions,
              }}
              label="Workspace, sessions and ingestion receipts"
            />
          </div>
        )}
      </Panel>
      <HonchoBudget notify={notify} editable={!!memory?.connection?.attached && !!memory?.connection?.verified} />
      <Panel
        title="Connection checks"
        note="Pinned local Honcho services use the memory provider for reasoning and a dedicated, capped embeddings route."
      >
        {error && <p role="alert">{error}</p>}
        {!status && !error && <p role="status">Checking Honcho…</p>}
        {status && (
          <div>
            <StatusBadge
              state={status.running ? 'running' : 'disabled'}
              label={status.running ? 'Honcho services running' : 'Honcho stopped'}
            />
            <div className="n-row">
              <b>Live compatibility</b>
              <StatusBadge state={memory?.connection?.verified ? 'verified' : 'unverified'} />
            </div>
            <div className="n-row">
              <b>Memory provider configured</b>
              <StatusBadge
                state={status.reasoning_provider_configured ? 'ready' : 'unverified'}
                label={status.reasoning_provider_configured ? 'Configured' : 'Not configured'}
              />
            </div>
            <div className="n-row">
              <b>Embedding credential</b>
              <span>{status.embedding_credential ? 'Configured' : 'Not configured'}</span>
            </div>
            {!status.running && (
              <p className="n-empty">
                Stored-data browsing is available while Honcho is running. Use the Honcho CLI for setup and lifecycle
                controls.
              </p>
            )}
            <Details value={status} label="Honcho version and technical status" />
          </div>
        )}
      </Panel>
      <Panel
        title="Browse stored Honcho data"
        note="Workspaces contain peers (people or agents) and sessions (conversations). These reads do not ask a model to generate new memory."
      >
        <div className="n-form">
          <label>
            What to browse
            <select
              value={kind}
              onChange={e => {
                setKind(e.target.value);
                setData(null);
              }}
            >
              {['workspace', 'peer', 'session'].map(v => (
                <option key={v} value={v}>
                  {browseLabels[v]}
                </option>
              ))}
            </select>
          </label>
          {kind !== 'workspace' && (
            <label>
              Workspace ID
              <input
                value={workspace}
                onChange={e => {
                  setWorkspace(e.target.value);
                  setData(null);
                }}
              />
            </label>
          )}
        </div>
        {button(
          busy ? 'Loading…' : 'Load stored data',
          query,
          busy || !status?.running || (kind !== 'workspace' && !workspace.trim()),
        )}
        {data && (
          <div>
            {data.error ? (
              <p role="alert">{data.error}</p>
            ) : (
              <p className="n-afterword">
                {data.complete
                  ? 'Stored data loaded.'
                  : 'Showing the returned page. More data may be available through the CLI.'}
              </p>
            )}
            <Details value={data} label="Stored data response" />
          </div>
        )}
        <details className="n-afterword">
          <summary>CLI commands and setup</summary>
          <p className="n-muted">Use the existing terminal workflow to configure Honcho or retrieve structured data.</p>
          <Data
            value={
              './bin/nocheh honcho doctor\n./bin/nocheh honcho workspace list --json\n./bin/nocheh honcho peer list -w WORKSPACE_ID --json'
            }
          />
        </details>
      </Panel>
    </div>
  );
}

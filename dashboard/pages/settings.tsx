import {useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode} from 'react';
import {useRevisionDraft} from '../lib/draft';
import {Bot, Cpu, Gauge, RotateCcw, Send, ShieldCheck, Wrench} from 'lucide-react';
import {WorkspaceTabs} from '../components/workspace-tabs';
import {
  call,
  button,
  errorText,
  labels,
  Panel,
  profileName,
  RouteLink,
  useLoad,
  StatusBadge,
  Button,
  Alert,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '../lib/page-helpers';

type Notify = (message: string, error?: boolean) => void;

type SettingsField = {
  key: string;
  value?: string;
  secret?: boolean;
  configured?: boolean;
  editable?: boolean;
};

type FieldChangeEvent = ChangeEvent<HTMLInputElement | HTMLSelectElement>;

/** Installation settings in short sections, saved and applied from one bar. */
export function Settings({notify}: {notify: Notify}) {
  return (
    <div className="settings-page">
      <NochehSettings notify={notify} />
    </div>
  );
}

function OwnerFreedom({notify}: {notify: Notify}) {
  const [tick, setTick] = useState(0);
  const [data, error] = useLoad('/owner-autonomy', tick);
  const [choice, setChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const selected: string = choice ?? data?.mode ?? 'approval_required';
  const changed = !!data && selected !== data.mode;
  const options: [string, string, string][] = [
    [
      'approval_required',
      'Ask me first (default)',
      'Every Telegram message Nocheh sends for you and every shell, browser and MCP tool waits for your approval in Activity or your private chat.',
    ],
    [
      'owner_requests_execute',
      'Do what I ask',
      'When you ask in your own private chat, Nocheh sends messages and runs tools without a separate approval. Requests from groups, schedules and background work still wait for approval, and explicit deny rules still block.',
    ],
  ];

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!changed || busy) return;
    setBusy(true);
    setProblem('');
    try {
      const result = await call('/owner-autonomy', {
        mode: selected,
        expected_revision: data.revision,
        operation_id: crypto.randomUUID(),
      });
      setChoice(null);
      setTick(v => v + 1);
      notify(
        result.mode === 'owner_requests_execute'
          ? 'Your private requests now run without a separate approval.'
          : 'Every external action now waits for your approval.',
      );
    } catch (error) {
      setProblem(errorText(error));
      setTick(v => v + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Owner freedom"
      note="How much Nocheh may do on your behalf without asking. Applies immediately; no restart is needed."
    >
      {error && !data && <Alert>The owner freedom setting is unavailable. Refresh and try again.</Alert>}
      {!data && !error && <p role="status">Loading owner freedom…</p>}
      {data && (
        <form onSubmit={save} className="owner-freedom">
          <fieldset>
            <legend className="sr-only">Owner freedom level</legend>
            {options.map(([value, label, text]) => (
              <label key={value} className="owner-freedom-option">
                <input
                  type="radio"
                  name="owner-freedom"
                  value={value}
                  checked={selected === value}
                  disabled={busy}
                  onChange={() => setChoice(value)}
                />
                <span>
                  <strong>{label}</strong>
                  <span className="n-muted">{text}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {problem && (
            <p role="alert" className="source-retirement-error">
              {`Not saved: ${problem}. Check the current setting and try again.`}
            </p>
          )}
          <p role="status" className="n-muted">
            {'Current: ' +
              (data.mode === 'owner_requests_execute' ? 'Do what I ask' : 'Ask me first') +
              (data.updated_at && data.revision ? ' · changed ' + new Date(data.updated_at).toLocaleString() : '')}
          </p>
          <div className="n-actions">
            <button className="n-primary" disabled={busy || !changed}>
              {busy ? 'Saving…' : 'Save owner freedom'}
            </button>
            {changed && button('Discard', () => setChoice(null), busy)}
          </div>
        </form>
      )}
    </Panel>
  );
}

const policyNames: Record<string, string> = {
  'nocheh_tools.shell': 'Controlled shell',
  'nocheh_tools.browser': 'Controlled browser',
  'nocheh_tools.mcp': 'Controlled MCP',
  'agent.reasoning_effort': 'Reasoning effort',
  'agent.max_iterations': 'Maximum agent steps',
  'agent.run_budget_seconds': 'Time per turn (seconds)',
  'memory.memory_char_limit': 'General memory limit (characters)',
  'memory.user_char_limit': 'User profile limit (characters)',
};

function PolicySettings({notify, onSaved}: {notify: Notify; onSaved: () => void}) {
  const [tick, setTick] = useState(0);
  const [data, error] = useLoad('/policy', tick);
  const [changes, setChanges, editRevision] = useRevisionDraft<Record<string, any>>(data?.revision);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    try {
      await call('/policy', {changes, revision: editRevision});
      setChanges({});
      setTick(v => v + 1);
      onSaved();
      notify('Global preferences saved. Profiles that inherit them use them on the next turn.');
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Global Hermes defaults"
      note="These values apply to Hermes profiles without their own override. Saving a default does not replace a profile override."
    >
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">Loading policy…</p>}
      {data && (
        <form onSubmit={save}>
          <div className="n-form n-settings-preferences">
            {Object.entries(data.schema).map(([key, spec]: [string, any]) => {
              const input = {
                id: 'policy-' + key,
                value: changes[key] ?? data.values[key],
                disabled: busy,
                onChange: (e: FieldChangeEvent) =>
                  setChanges({...changes, [key]: spec.choices ? e.target.value : Number(e.target.value)}),
              };
              const name = policyNames[key] || key;
              return (
                <div className="n-field n-settings-preference" key={key}>
                  <label htmlFor={input.id}>{name}</label>
                  <div className="n-preference-control">
                    {spec.choices ? (
                      <select {...input}>
                        {spec.choices.map((v: string) => (
                          <option value={v} key={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input {...input} type="number" min={spec.min} max={spec.max} required />
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      title={'Reset ' + name + ' to the built-in default'}
                      aria-label={'Reset ' + name + ' to the built-in default'}
                      disabled={
                        busy || changes[key] === null || (changes[key] === undefined && data.origins[key] === 'default')
                      }
                      onClick={() => setChanges({...changes, [key]: null})}
                    >
                      <RotateCcw size={16} aria-hidden={true} />
                    </Button>
                  </div>
                  <small>
                    {changes[key] === null
                      ? 'Built-in default will apply after saving.'
                      : 'Source: ' + data.origins[key]}
                  </small>
                </div>
              );
            })}
          </div>
          <div className="n-actions">
            <button className="n-primary" disabled={busy || !Object.keys(changes).length}>
              {busy ? 'Saving…' : 'Save global preferences'}
            </button>
            {button('Discard edits', () => setChanges({}), busy)}
          </div>
        </form>
      )}
      <p className="n-muted">
        Whether external actions wait for your review is set under Owner freedom above. Job overrides are stored for the
        scheduling phase.
      </p>
    </Panel>
  );
}

const settingHints: Record<string, string> = {
  TELEGRAM_ENABLED: 'Start or stop Telegram message handling when settings are applied.',
  TELEGRAM_OWNER_ID: 'Your numeric Telegram user ID. Only the owner can administer Nocheh.',
  TELEGRAM_BOT_TOKEN: 'The token from BotFather for the bot used by the native Hermes Telegram adapter.',
  TELEGRAM_GROUP_REPLIES:
    'Only when addressed: in groups Nocheh answers a reply to its own message, its @username, or its name at the start of a message, and stays silent otherwise. Every message: it may answer any message from a permitted person. All group messages are archived either way.',
  TELEGRAM_BOT_NAMES:
    'Names, separated by commas, that address Nocheh when they start a group message. Change, add or remove any of them; its Telegram display name and @username always work.',
  NOCHEH_MODEL:
    'One model for Hermes replies, Honcho memory and secret detection, grouped by the provider login that serves it.',
  NOCHEH_EMBEDDING_MODEL: 'The OpenAI model that turns memory into searchable vectors, paid from the embedding budget.',
  NOCHEH_GUARD_MODE:
    'On uses saved guarded copies for agents and memory. Off uses originals with the same access rules.',
  NOCHEH_GUARD_TRUSTED_ENDPOINTS:
    'Explicit destinations for trusted preparation services. This does not bypass guarding for agents.',
  NOCHEH_PORT: 'Local port used by the archive service.',
  NOCHEH_PARALLEL_GUARD_CHECKS:
    'How many messages the secret guard checks at the same time, 1–4. Every message is checked before it is answered, and each check is one model call.',
  NOCHEH_HERMES_JOURNAL_RETENTION_DAYS:
    'Days Hermes keeps finished delivery logs before deleting them. 0, the default, keeps them forever. Unfinished deliveries are never deleted.',
  NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS:
    'Days to keep workflow run history, reply timings and related operational records before deleting them. 0, the default, keeps them forever. Receipts are never deleted.',
  NOCHEH_PARALLEL_RUNS:
    'Isolated agent containers that may run at once, shared by replies, memory reviews, browser turns and schedules. Each uses up to 2 GB of memory and 2 CPUs.',
  NOCHEH_PARALLEL_REPLIES:
    'Different chats answered at the same time. Messages in one chat, including every topic of a group, are always answered in order. Keep this below parallel agent runs so memory reviews and schedules still have room.',
};

const applyStateLabels: Record<string, string> = {
  current: 'Saved settings match the last successful apply',
  pending: 'Saved changes are waiting to be applied',
  unverified: 'Running settings have not been verified by this dashboard',
};

function NochehSettings({notify}: {notify: Notify}) {
  const [refresh, setRefresh] = useState(0);
  const [data, error] = useLoad('/settings', refresh);
  const [identityDirectory] = useLoad('/telegram/identities');
  const [changes, setChanges, editRevision] = useRevisionDraft<Record<string, string>>(data?.revision);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false);
  const [defaultsRevision, setDefaultsRevision] = useState(0);

  const save = async () => {
    setBusy(true);
    try {
      await call('/settings', {revision: editRevision, changes});
      setChanges({});
      setReview(false);
      setRefresh(v => v + 1);
      notify('Settings saved. Apply saved settings when you are ready to update running services.');
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    try {
      await call('/settings/apply', {});
      notify('Applying saved settings. Follow the result in System › Backups & maintenance.');
      setRefresh(v => v + 1);
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) return <Alert>Settings are unavailable.</Alert>;
  if (!data) return <p role="status">Loading settings…</p>;
  const fields: SettingsField[] = data.fields;

  const field = (f: SettingsField) => {
    const value = changes[f.key] ?? f.value ?? '';
    const attrs = {
      id: f.key,
      disabled: busy || !f.editable,
      value,
      type: f.secret ? 'password' : 'text',
      placeholder: f.secret && f.configured ? '****' : undefined,
      autoComplete: 'off',
      'aria-describedby': f.key + '-help',
      onChange: (e: FieldChangeEvent) => {
        const next = {...changes};
        if (f.secret && !e.target.value) delete next[f.key];
        else next[f.key] = e.target.value;
        setChanges(next);
        setReview(false);
      },
    };
    const served: string[] = data.models?.reasoning || [];
    const locked = data.models?.embedding_locked;
    if (f.key === 'NOCHEH_MODEL') {
      // One group per provider login; providers without a login offer no models.
      const providers: any[] = data.models?.providers || [];
      const signedIn = providers.filter(p => p.signed_in);
      const missing = providers.filter(p => !p.signed_in);
      const running = data.models?.provider_running !== false;
      const offered = signedIn.some(p => p.models.length);
      const cpa = <a href="/providers/management.html">CPA dashboard</a>;
      const hint: ReactNode = !signedIn.length ? (
        <>No model provider is signed in. Sign in to Claude or ChatGPT in the {cpa}, then reload this page.</>
      ) : !running ? (
        'The provider service is not running, so its models cannot be listed. Start Nocheh, then reload this page.'
      ) : !offered ? (
        'Signed in to ' +
        signedIn.map(p => p.label).join(' and ') +
        ', but the provider lists no models yet. Reload in a moment.'
      ) : (
        <>
          {settingHints[f.key]}
          {missing.length
            ? ' Not signed in: ' +
              missing.map(p => p.label + (p.id === 'codex' ? ' (needed for voice transcription)' : '')).join(', ') +
              '. Sign in from the '
            : ''}
          {missing.length ? cpa : ''}
          {missing.length ? '.' : ''}
        </>
      );
      const providerGroups = signedIn
        .filter(p => p.models.length)
        .map(p => (
          <optgroup key={p.id} label={p.label}>
            {p.models.map((model: string) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </optgroup>
        ));
      const stale =
        value && !served.includes(value)
          ? [
              <option key="saved" value={value}>
                {value + ' · not served by a signed-in provider'}
              </option>,
            ]
          : [];
      return (
        <div className="n-field" key={f.key}>
          <label htmlFor={f.key}>{labels[f.key]}</label>
          {offered ? (
            <select {...attrs}>
              {stale}
              {providerGroups}
            </select>
          ) : (
            <input {...attrs} disabled />
          )}
          <small id={f.key + '-help'} role={offered ? undefined : 'status'}>
            {hint}
          </small>
        </div>
      );
    }
    if (f.key === 'NOCHEH_EMBEDDING_MODEL')
      return (
        <div className="n-field" key={f.key}>
          <label htmlFor={f.key}>{labels[f.key]}</label>
          <select {...attrs}>
            {(data.models?.embedding || [value]).map((model: string) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
          <small id={f.key + '-help'}>
            {settingHints[f.key]}
            {locked
              ? ' Memory already holds vectors from ' + locked + '; another model needs a Honcho memory rebuild first.'
              : ' It can be changed until memory stores its first vectors.'}
          </small>
        </div>
      );
    if (
      f.key === 'NOCHEH_PARALLEL_RUNS' ||
      f.key === 'NOCHEH_PARALLEL_REPLIES' ||
      f.key === 'NOCHEH_PARALLEL_GUARD_CHECKS'
    ) {
      // Replies can never exceed the agent runs that carry them.
      const runs = Number(changes.NOCHEH_PARALLEL_RUNS ?? saved('NOCHEH_PARALLEL_RUNS')) || 4;
      const limit = f.key === 'NOCHEH_PARALLEL_RUNS' ? 8 : f.key === 'NOCHEH_PARALLEL_GUARD_CHECKS' ? 4 : runs;
      return (
        <div className="n-field" key={f.key}>
          <label htmlFor={f.key}>{labels[f.key]}</label>
          <select {...attrs}>
            {Array.from({length: limit}, (_, i) => String(i + 1)).map(n => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <small id={f.key + '-help'}>
            {settingHints[f.key]}
            {f.key === 'NOCHEH_PARALLEL_REPLIES' && Number(value) > runs
              ? ' This is more than parallel agent runs; lower it before saving.'
              : ''}
          </small>
        </div>
      );
    }
    const options =
      f.key === 'NOCHEH_GUARD_MODE'
        ? [
            ['on', 'On · use guarded copies'],
            ['off', 'Off · use originals'],
          ]
        : f.key === 'TELEGRAM_GROUP_REPLIES'
          ? [
              ['addressed', 'Only when addressed'],
              ['all', 'Every message'],
            ]
          : [
              ['false', 'Disabled'],
              ['true', 'Enabled'],
            ];
    return (
      <div className="n-field" key={f.key}>
        <label htmlFor={f.key}>
          {labels[f.key] || f.key}
          {f.secret && <span className="n-secret-status">{f.configured ? 'Configured' : 'Missing'}</span>}
        </label>
        {['NOCHEH_GUARD_MODE', 'TELEGRAM_ENABLED', 'TELEGRAM_GROUP_REPLIES'].includes(f.key) ? (
          <select {...attrs}>
            {options.map(([option, label]) => (
              <option key={option} value={option}>
                {label}
              </option>
            ))}
          </select>
        ) : (
          <input {...attrs} />
        )}
        <small id={f.key + '-help'}>
          {settingHints[f.key]}
          {f.secret
            ? ' ' +
              (f.configured
                ? f.editable
                  ? '**** is a placeholder, not the saved value. Leave blank to keep it; enter a replacement to change it.'
                  : 'Configured and managed internally.'
                : 'Not configured.')
            : !f.editable
              ? ' Managed automatically.'
              : ''}
        </small>
        {f.key === 'TELEGRAM_OWNER_ID' && observedUsers.has(value) && <small>{participantLabel(value)}</small>}
      </div>
    );
  };

  const fieldGroup = (title: string, note: string, keys: string[], extra: ReactNode = null) => {
    const id = 'settings-' + title.toLowerCase().replace(/\W+/g, '-');
    return (
      <section className="n-settings-group" aria-labelledby={id}>
        <h3 id={id}>{title}</h3>
        <p className="n-muted">{note}</p>
        {keys.length ? (
          <div className="n-form">{fields.filter(f => keys.includes(f.key)).map(field)}</div>
        ) : (
          <p>Nothing else to set here.</p>
        )}
        {extra}
      </section>
    );
  };

  const saved = (key: string): string => fields.find(f => f.key === key)?.value || '';
  const observed: any[] = identityDirectory?.groups || [];
  const observedUsers = new Map<string, any>(observed.flatMap(group => group.users || []).map(user => [user.id, user]));
  const participantLabel = (id: string) => {
    const found = observedUsers.get(id);
    if (!found) return 'User ID ' + id;
    const name = [found.name, found.username && found.username !== found.name ? '(' + found.username + ')' : null]
      .filter(Boolean)
      .join(' ');
    return name ? name + ' · ID ' + id : 'User ID ' + id;
  };
  const accessLink = (
    <p className="n-settings-moved">
      Which groups Nocheh works in, who may talk to it there, topics and topic memory are chosen per chat in{' '}
      <a href="#access">Chats &amp; access</a>.
    </p>
  );

  const reviewValue = (key: string, value: string) => {
    if (key === 'TELEGRAM_OWNER_ID') return participantLabel(value);
    if (key === 'TELEGRAM_GROUP_REPLIES') return value === 'all' ? 'Every message' : 'Only when addressed';
    return value || '(empty)';
  };

  const managedElsewhere = ['TELEGRAM_GROUP_IDS', 'TELEGRAM_GROUP_ACCESS', 'TELEGRAM_TOPIC_MEMORY'];
  const sectionKeys = {
    telegram: [
      'TELEGRAM_ENABLED',
      'TELEGRAM_OWNER_ID',
      'TELEGRAM_GROUP_REPLIES',
      'TELEGRAM_BOT_NAMES',
      'TELEGRAM_BOT_TOKEN',
    ],
    models: ['NOCHEH_MODEL', 'NOCHEH_EMBEDDING_MODEL'],
    speed: ['NOCHEH_PARALLEL_RUNS', 'NOCHEH_PARALLEL_REPLIES', 'NOCHEH_PARALLEL_GUARD_CHECKS'],
    privacy: ['NOCHEH_GUARD_MODE', 'NOCHEH_GUARD_TRUSTED_ENDPOINTS'],
  };
  const placed = [...managedElsewhere, ...Object.values(sectionKeys).flat()];
  const advanced = fields.filter(f => !placed.includes(f.key)).map(f => f.key);
  const count = Object.keys(changes).length;
  const changedIn = (keys: string[]) => keys.filter(key => key in changes).length;
  const tab = (label: string, keys: string[]) => (changedIn(keys) ? label + ' •' : label);

  return (
    <>
      {error && <Alert>Saved settings may be stale. Edits are retained.</Alert>}
      {editRevision !== data.revision && (
        <Alert>
          These settings changed elsewhere. Your edits are retained against the original revision. Discard edits to load
          the new values, or attempt Save to see the conflict.
        </Alert>
      )}
      <WorkspaceTabs
        page="settings"
        label="Settings sections"
        views={[
          {
            id: 'telegram',
            label: tab('Telegram', sectionKeys.telegram),
            Icon: Send,
            render: () =>
              fieldGroup(
                'Telegram access',
                'Your Telegram account, the bot, and how Nocheh answers in groups.',
                sectionKeys.telegram,
                accessLink,
              ),
          },
          {
            id: 'models',
            label: tab('Models', sectionKeys.models),
            Icon: Cpu,
            render: () =>
              fieldGroup(
                'Models',
                'The model behind replies, memory and secret detection, and the model that makes memory searchable. Applying a model change also restarts Honcho.',
                sectionKeys.models,
              ),
          },
          {
            id: 'speed',
            label: tab('Speed', sectionKeys.speed),
            Icon: Gauge,
            render: () =>
              fieldGroup(
                'Speed',
                'How much work runs at the same time. More is faster for several chats but uses more memory and more of your model subscription at once. Apply restarts Hermes and its launcher.',
                sectionKeys.speed,
              ),
          },
          {
            id: 'privacy',
            label: tab('Privacy', sectionKeys.privacy),
            Icon: ShieldCheck,
            render: () =>
              fieldGroup(
                'Privacy',
                'Whether agents and memory see guarded copies with secrets hidden. These rules apply to outgoing model requests.',
                sectionKeys.privacy,
              ),
          },
          {
            id: 'assistant',
            label: 'Assistant',
            Icon: Bot,
            render: () => (
              <>
                <OwnerFreedom notify={notify} />
                <HermesPreferences notify={notify} defaultsRevision={defaultsRevision} />
                <PolicySettings notify={notify} onSaved={() => setDefaultsRevision(v => v + 1)} />
              </>
            ),
          },
          {
            id: 'advanced',
            label: tab('Advanced', advanced),
            Icon: Wrench,
            render: () => fieldGroup('Advanced', 'Destinations, connections and internal credentials.', advanced),
          },
        ]}
      />
      <section
        className={count ? 'settings-bar settings-bar-dirty' : 'settings-bar'}
        aria-label="Save and apply settings"
      >
        {review && count > 0 && (
          <div className="n-review">
            <h3>Review before saving</h3>
            <p>Saving changes the configuration file. Running services update only after Apply.</p>
            <ul>
              {Object.entries(changes).map(([k, v]) => (
                <li key={k}>
                  {(labels[k] || k) +
                    ': ' +
                    (fields.find(f => f.key === k)?.secret ? 'Replace stored credential' : reviewValue(k, v))}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="settings-bar-row">
          <StatusBadge
            state={count ? 'waiting' : data.apply_state}
            label={
              count
                ? `${count} unsaved ${count === 1 ? 'change' : 'changes'}`
                : applyStateLabels[data.apply_state] || data.apply_state
            }
          />
          <div className="n-actions">
            {count > 0 &&
              button(
                'Discard edits',
                () => {
                  setChanges({});
                  setReview(false);
                },
                busy,
              )}
            {count > 0 &&
              (review
                ? button('Save changes', save, busy, 'n-primary')
                : button('Review changes', () => setReview(true), busy))}
            {count === 0 &&
              button('Apply saved settings', apply, busy, data.apply_state === 'pending' ? 'n-primary' : '')}
            <a href="#system?view=maintenance">Apply results →</a>
          </div>
        </div>
        <small className="n-muted">
          {count
            ? 'Save or discard your edits before applying.'
            : 'Apply updates the running services and may briefly interrupt Telegram replies.'}
        </small>
      </section>
    </>
  );
}

const preferenceNames: Record<string, [string, string]> = {
  'nocheh_tools.shell': [
    'Controlled shell',
    'Propose commands in an isolated workspace. Each execution requires approval or an exact bounded permission.',
  ],
  'nocheh_tools.browser': [
    'Controlled browser',
    'Inspect an approved public page offline. No logins or interactive actions.',
  ],
  'nocheh_tools.mcp': ['Controlled MCP', 'Propose an exact call to a public HTTPS MCP server. No ambient credentials.'],
  'agent.reasoning_effort': ['Reasoning effort', 'Higher effort allows more reasoning and can take longer.'],
  'agent.max_iterations': ['Maximum agent steps', 'Maximum tool and reasoning iterations in one turn.'],
  'agent.run_budget_seconds': ['Time per turn (seconds)', 'Upper time budget for one assistant turn.'],
  'memory.memory_char_limit': [
    'General memory limit (characters)',
    'Space available for Hermes’s general memory note.',
  ],
  'memory.user_char_limit': ['User profile limit (characters)', 'Space available for Hermes’s user profile note.'],
};

function HermesPreferences({notify, defaultsRevision}: {notify: Notify; defaultsRevision: number}) {
  const [profiles, error] = useLoad('/memory/profiles');
  const [scope, setScope] = useState('');
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!scope && profiles?.profiles?.length) setScope(profiles.profiles[0].scope);
  }, [profiles]);
  const [prefs, problem] = useLoad(
    scope ? '/memory/preferences?scope=' + encodeURIComponent(scope) : null,
    tick + defaultsRevision,
  );
  const [changes, setChanges, editRevision] = useRevisionDraft<Record<string, any>>(prefs?.revision);

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (prefs?.scope !== scope) return;
    setBusy(true);
    try {
      await call('/memory/preferences', {scope, revision: editRevision, changes});
      setChanges({});
      setTick(v => v + 1);
      notify('Hermes preferences saved for this profile. They take effect on the next turn.');
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Hermes profile preferences"
      note="These values apply to one chat profile. The global Hermes defaults below apply wherever this profile has no override. Saves take effect on the next turn; no service restart is needed."
    >
      {error && <p role="alert">{error}</p>}
      <label>
        Profile to configure
        <select
          value={scope}
          disabled={busy}
          onChange={e => {
            setScope(e.target.value);
            setChanges({});
          }}
        >
          {(profiles?.profiles || []).map((p: any) => (
            <option value={p.scope} key={p.scope}>
              {profileName(p)}
            </option>
          ))}
        </select>
      </label>
      {!profiles && !error && <p role="status">Loading profiles…</p>}
      {profiles && !profiles.profiles.length && (
        <p>
          Set the Telegram owner in Settings › Telegram, and turn Nocheh on in groups in Chats & access, to make
          profiles available.
        </p>
      )}
      {problem && <p role="alert">{problem}</p>}
      {scope && !problem && prefs?.scope !== scope && <p role="status">Loading this profile’s preferences…</p>}
      {scope && prefs?.scope === scope && (
        <form onSubmit={save}>
          <div className="n-form n-preferences n-settings-preferences">
            {Object.entries(prefs.schema).map(([key, spec]: [string, any]) => {
              const input = {
                id: key,
                value: changes[key] ?? prefs.values[key],
                disabled: busy,
                'aria-describedby': key + '-help',
                onChange: (e: FieldChangeEvent) =>
                  setChanges({...changes, [key]: spec.choices ? e.target.value : Number(e.target.value)}),
              };
              const name = preferenceNames[key]?.[0] || key;
              return (
                <div className="n-field n-settings-preference" key={key}>
                  <label htmlFor={key}>{name}</label>
                  <div className="n-preference-control">
                    {spec.choices ? (
                      <select {...input}>
                        {spec.choices.map((v: string) => (
                          <option key={v} value={v}>
                            {v[0].toUpperCase() + v.slice(1)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input {...input} type="number" min={spec.min} max={spec.max} required step={1} />
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      title={'Reset ' + name + ' to the global default'}
                      aria-label={'Reset ' + name + ' to the global default'}
                      disabled={
                        busy ||
                        changes[key] === null ||
                        (changes[key] === undefined && prefs.origins?.[key] !== 'profile')
                      }
                      onClick={() => setChanges({...changes, [key]: null})}
                    >
                      <RotateCcw size={16} aria-hidden={true} />
                    </Button>
                  </div>
                  <small id={key + '-help'}>
                    {changes[key] === null
                      ? 'Global default will apply after saving.'
                      : (preferenceNames[key]?.[1] || '') + ' Source: ' + (prefs.origins?.[key] || 'profile')}
                  </small>
                </div>
              );
            })}
          </div>
          <div className="n-actions">
            <button disabled={busy || !Object.keys(changes).length} className="n-primary">
              {busy ? 'Saving…' : 'Save Hermes preferences'}
            </button>
            {button('Discard edits', () => setChanges({}), busy || !Object.keys(changes).length)}
          </div>
        </form>
      )}
      <p className="n-muted n-afterword">
        Model routing, enabled tools and access policy are managed by Nocheh. These are the supported native
        preferences, not the full Hermes configuration.
      </p>
      <RouteLink page="memory">Read this installation’s Hermes memory →</RouteLink>
    </Panel>
  );
}

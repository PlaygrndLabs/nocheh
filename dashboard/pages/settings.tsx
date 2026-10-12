import {useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode} from 'react';
import {useRevisionDraft} from '../lib/draft';
import {participantAllowed, switchDecision} from '../lib/group-access';
import {RotateCcw} from 'lucide-react';
import {
  call,
  button,
  errorText,
  labels,
  Panel,
  profileName,
  RouteLink,
  useLoad,
  refreshResources,
  StatusBadge,
  Button,
  Alert,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '../lib/page-helpers';

type Notify = (message: string, error?: boolean) => void;

type Conversation = {
  space_id: string;
  kind: string;
  name?: string;
  configured?: boolean;
  parent_space?: string;
  closed?: boolean;
  registered?: boolean;
  observed_at?: string | null;
  telegram?: {state?: string; migrate_to_chat_id?: string | number};
};

type SettingsField = {
  key: string;
  value?: string;
  secret?: boolean;
  configured?: boolean;
  editable?: boolean;
};

type AccessRule = {granted: string[]; denied: string[]};

type FieldChangeEvent = ChangeEvent<HTMLInputElement | HTMLSelectElement>;

export function Settings({notify}: {notify: Notify}) {
  const [defaultsRevision, setDefaultsRevision] = useState(0);
  return (
    <Tabs defaultValue="nocheh" className="settings-page">
      <TabsList aria-label="Settings category">
        <TabsTrigger value="nocheh">Nocheh settings</TabsTrigger>
        <TabsTrigger value="hermes">Hermes preferences</TabsTrigger>
      </TabsList>
      <TabsContent value="nocheh" forceMount>
        <NochehSettings notify={notify} />
        <TelegramGroups notify={notify} />
        <OwnerFreedom notify={notify} />
      </TabsContent>
      <TabsContent value="hermes" forceMount>
        <HermesPreferences notify={notify} defaultsRevision={defaultsRevision} />
        <PolicySettings notify={notify} onSaved={() => setDefaultsRevision(v => v + 1)} />
      </TabsContent>
    </Tabs>
  );
}

function TelegramGroups({notify}: {notify: Notify}) {
  const [tick, setTick] = useState(0);
  const [data, error] = useLoad('/conversations?limit=100', tick);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const items: Conversation[] = data?.items || [];
  const groups = items.filter(item => item.kind === 'group' && item.configured);
  const topicsOf = (group: Conversation) =>
    items.filter(item => item.kind === 'topic' && item.parent_space === group.space_id);
  const forums = groups.filter(group => /^-100/.test(group.space_id));
  const [topicGroup, setTopicGroup] = useState('');
  const [topicRef, setTopicRef] = useState('');
  const [topicName, setTopicName] = useState('');

  const changeTopic = async (body: Record<string, unknown>, message: string) => {
    setBusy(true);
    setProblem('');
    try {
      await call('/telegram/topics', body);
      setTick(v => v + 1);
      notify(message);
      return true;
    } catch (error) {
      setProblem(errorText(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addTopic = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const ref = topicRef.trim();
    const group = topicGroup || forums[0]?.space_id;
    const target = /^\d+$/.test(ref) ? {chat_id: group, topic_id: Number(ref)} : {link: ref};
    if (await changeTopic({action: 'add', name: topicName, ...target}, 'Topic added to the directory.')) {
      setTopicRef('');
      setTopicName('');
    }
  };

  const topicLine = (topic: Conversation) => (
    <li key={topic.space_id}>
      <span dir="auto">{topic.name || 'Name unknown'}</span>
      <code>{topic.space_id.split('/topic/')[1]}</code>
      <small className="n-muted">
        {[
          topic.closed && 'closed',
          topic.registered && 'added by you',
          !topic.observed_at && !topic.registered && 'no message yet',
        ]
          .filter(Boolean)
          .join(' · ')}
      </small>
      {topic.registered &&
        button(
          'Remove',
          () =>
            changeTopic(
              {action: 'remove', chat_id: topic.parent_space, topic_id: Number(topic.space_id.split('/topic/')[1])},
              'Topic removed from the directory.',
            ),
          busy,
          '',
        )}
    </li>
  );

  const status = (item: Conversation) =>
    item.telegram?.state === 'migrated'
      ? 'Upgraded to a supergroup. Its new ID is ' + item.telegram.migrate_to_chat_id + '; update Selected groups.'
      : item.telegram?.state === 'not_member'
        ? 'The bot is not a member of this group.'
        : item.telegram?.state === 'not_found'
          ? 'Telegram did not find this group.'
          : item.observed_at
            ? 'Messages received.'
            : 'No message received from this group yet.';

  const refresh = async () => {
    setBusy(true);
    setProblem('');
    try {
      const result = await call('/telegram/chats/refresh', {});
      setTick(v => v + 1);
      notify(`Checked ${result.chats.length} ${result.chats.length === 1 ? 'group' : 'groups'} with Telegram.`);
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Telegram groups"
      note="Names come from messages Nocheh received. Refresh asks Telegram for the selected groups’ current names; it sends nothing."
    >
      {error && !data && <Alert>The group list is unavailable. Refresh and try again.</Alert>}
      {!data && !error && <p role="status">Loading groups…</p>}
      {data &&
        (groups.length ? (
          <ul className="telegram-groups">
            {groups.map(item => (
              <li key={item.space_id}>
                <strong dir="auto">{item.name || 'Name unknown'}</strong>
                <code>{item.space_id}</code>
                <span className="n-muted">{status(item)}</span>
                {topicsOf(item).length > 0 && (
                  <ul className="telegram-topics" aria-label={'Topics in ' + (item.name || item.space_id)}>
                    {topicsOf(item).map(topicLine)}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="n-muted">No groups are selected. Owner private messages still work.</p>
        ))}
      {forums.length > 0 && (
        <form className="telegram-topic-form" onSubmit={addTopic}>
          <p className="n-muted">
            Telegram does not let bots list topics. New topics appear automatically when they are created or renamed;
            add an older topic with no messages here. In Telegram, open the topic and use Copy link.
          </p>
          {forums.length > 1 && (
            <label>
              Group
              <select
                value={topicGroup || forums[0].space_id}
                disabled={busy}
                onChange={e => setTopicGroup(e.target.value)}
              >
                {forums.map(group => (
                  <option key={group.space_id} value={group.space_id}>
                    {group.name || group.space_id}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Topic link or number
            <input
              value={topicRef}
              disabled={busy}
              placeholder="https://t.me/c/…/12"
              onChange={e => setTopicRef(e.target.value)}
            />
          </label>
          <label>
            Topic name
            <input
              value={topicName}
              disabled={busy}
              dir="auto"
              maxLength={128}
              onChange={e => setTopicName(e.target.value)}
            />
          </label>
          <div className="n-actions">
            <button className="n-primary" disabled={busy || !topicRef.trim() || !topicName.trim()}>
              Add topic
            </button>
          </div>
        </form>
      )}
      {problem && (
        <p role="alert" className="source-retirement-error">
          {`Refresh failed: ${problem}. Telegram may be unavailable; try again.`}
        </p>
      )}
      <div className="n-actions">
        {button(busy ? 'Checking with Telegram…' : 'Refresh from Telegram', refresh, busy || !groups.length, '')}
      </div>
    </Panel>
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
        Whether external actions wait for your review is set under Owner freedom in Nocheh settings. Job overrides are
        stored for the scheduling phase.
      </p>
    </Panel>
  );
}

const settingHints: Record<string, string> = {
  TELEGRAM_ENABLED: 'Start or stop Telegram message handling when settings are applied.',
  TELEGRAM_OWNER_ID: 'Your numeric Telegram user ID. Only the owner can administer Nocheh.',
  TELEGRAM_GROUP_IDS: 'Comma-separated numeric chat IDs. Each selected group uses its own memory and sources.',
  TELEGRAM_BOT_TOKEN: 'The token from BotFather for the bot used by the native Hermes Telegram adapter.',
  TELEGRAM_GROUP_REPLIES:
    'Only when addressed: in groups Nocheh answers a reply to its own message, its @username, or its name at the start of a message, and stays silent otherwise. Every message: it may answer any message from a permitted person. All group messages are archived either way.',
  TELEGRAM_BOT_NAMES:
    'Names, separated by commas, that address Nocheh when they start a group message. Change, add or remove any of them; its Telegram display name and @username always work.',
  TELEGRAM_TOPIC_MEMORY:
    'Whole group: in a group with topics, Nocheh remembers what was said in its General chat and every topic, wherever you ask. Each topic: a topic remembers only its own messages. Either way a group never sees your private chat or other groups.',
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
  const [identityTick, setIdentityTick] = useState(0);
  const [identityDirectory, identityError] = useLoad('/telegram/identities', identityTick);
  const [chatRefresh, setChatRefresh] = useState<any[] | null>(null);
  const [refreshingChats, setRefreshingChats] = useState(false);
  // Reads Telegram only when the owner asks; saved names then serve every directory view.
  const refreshChats = async () => {
    setRefreshingChats(true);
    try {
      const result = await call('/telegram/chats/refresh', {});
      setChatRefresh(result.chats || []);
      setIdentityTick(v => v + 1);
      void refreshResources();
      notify('Group information refreshed from Telegram.');
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      setRefreshingChats(false);
    }
  };
  const chatState = (chat: any) =>
    chat.state === 'available'
      ? (chat.title || 'No title') + (chat.is_forum ? ' · forum' : '')
      : chat.state === 'migrated'
        ? 'Upgraded to a supergroup with ID ' + chat.migrate_to_chat_id + '. Replace the old ID in Selected groups.'
        : chat.state === 'not_member'
          ? 'Nocheh’s bot is not a member of this group.'
          : 'Telegram does not know this ID.';
  const [changes, setChanges, editRevision] = useRevisionDraft<Record<string, string>>(data?.revision);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false);
  const [accessGroup, setAccessGroup] = useState('');
  const [accessUser, setAccessUser] = useState('');
  const [manualDecision, setManualDecision] = useState('deny');

  const save = async () => {
    setBusy(true);
    try {
      await call('/settings', {revision: editRevision, changes});
      setChanges({});
      setReview(false);
      setRefresh(v => v + 1);
      notify('Nocheh settings saved. Apply saved settings when you are ready to update running services.');
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
      notify('Applying saved settings. Follow the result in Maintenance.');
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
          : f.key === 'TELEGRAM_TOPIC_MEMORY'
            ? [
                ['group', 'Whole group'],
                ['topic', 'Each topic'],
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
        {['NOCHEH_GUARD_MODE', 'TELEGRAM_ENABLED', 'TELEGRAM_GROUP_REPLIES', 'TELEGRAM_TOPIC_MEMORY'].includes(
          f.key,
        ) ? (
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
          {f.key === 'TELEGRAM_GROUP_IDS' && !value
            ? ' No groups selected; owner private messages can still work.'
            : ''}
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
        {f.key === 'TELEGRAM_GROUP_IDS' && groups.length && (
          <small>{'Selected: ' + groups.map(groupLabel).join('; ')}</small>
        )}
        {f.key === 'TELEGRAM_OWNER_ID' && observedUsers.has(value) && <small>{participantLabel(value)}</small>}
      </div>
    );
  };

  const fieldGroup = (title: string, note: string, keys: string[], extra: ReactNode = null) => {
    const id = 'settings-' + keys[0].toLowerCase();
    return (
      <section className="n-settings-group" aria-labelledby={id}>
        <h3 id={id}>{title}</h3>
        <p className="n-muted">{note}</p>
        <div className="n-form">{fields.filter(f => keys.includes(f.key)).map(field)}</div>
        {extra}
      </section>
    );
  };

  const saved = (key: string): string => fields.find(f => f.key === key)?.value || '';
  const groups = (changes.TELEGRAM_GROUP_IDS ?? saved('TELEGRAM_GROUP_IDS'))
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const owner = changes.TELEGRAM_OWNER_ID ?? saved('TELEGRAM_OWNER_ID');
  const observed: any[] = identityDirectory?.groups || [];
  const observedById = new Map<string, any>(observed.map(group => [group.id, group]));
  const observedUsers = new Map<string, any>(observed.flatMap(group => group.users || []).map(user => [user.id, user]));
  const groupLabel = (id: string) => {
    const name = observedById.get(id)?.name;
    return name ? name + ' · ID ' + id : 'Group ID ' + id;
  };
  const participantLabel = (id: string) => {
    const found = observedUsers.get(id);
    if (!found) return 'User ID ' + id;
    const name = [found.name, found.username && found.username !== found.name ? '(' + found.username + ')' : null]
      .filter(Boolean)
      .join(' ');
    return name ? name + ' · ID ' + id : 'User ID ' + id;
  };
  const participantName = (id: string): string =>
    observedUsers.get(id)?.name || observedUsers.get(id)?.username || 'Unknown person';
  const participantMeta = (id: string) => {
    const found = observedUsers.get(id);
    return [found?.name && found.username !== found.name ? found.username : null, 'ID ' + id]
      .filter(Boolean)
      .join(' · ');
  };
  const addObservedGroup = (id: string) => {
    if (!id || groups.includes(id)) return;
    setChanges({...changes, TELEGRAM_GROUP_IDS: [...groups, id].join(',')});
    setAccessGroup(id);
    setReview(false);
  };
  const chosen = groups.includes(accessGroup) ? accessGroup : groups[0];
  let access: Record<string, AccessRule> = {};
  try {
    access = JSON.parse(changes.TELEGRAM_GROUP_ACCESS ?? saved('TELEGRAM_GROUP_ACCESS') ?? '{}');
  } catch {
    access = {};
  }
  const rule = access[chosen] || {granted: [], denied: []};
  let savedAccess: Record<string, AccessRule> = {};
  try {
    savedAccess = JSON.parse(saved('TELEGRAM_GROUP_ACCESS') || '{}');
  } catch {}
  const savedRule = savedAccess[chosen] || {granted: [], denied: []};
  const participantIds = [
    ...new Set<string>([
      ...(observedById.get(chosen)?.users || []).map((user: any) => user.id),
      ...rule.granted,
      ...rule.denied,
    ]),
  ]
    .filter(id => id !== owner)
    .sort((a, b) => participantName(a).localeCompare(participantName(b)) || a.localeCompare(b));
  const accessState = (id: string) =>
    rule.denied.includes(id) ? 'deny' : rule.granted.includes(id) ? 'grant' : 'default';
  const changeAccess = (decision: string, user: string) => {
    if (!/^[1-9]\d{0,18}$/.test(user) || user === owner) {
      notify('Enter a valid participant user ID other than the owner.', true);
      return;
    }
    if (accessState(user) === decision) return;
    const next = {...access};
    const current = next[chosen] || {granted: [], denied: []};
    const granted = current.granted.filter(id => id !== user);
    const denied = current.denied.filter(id => id !== user);
    if (decision === 'grant') granted.push(user);
    if (decision === 'deny') denied.push(user);
    if (granted.length || denied.length) next[chosen] = {granted: granted.sort(), denied: denied.sort()};
    else delete next[chosen];
    const updated = {...changes};
    const value = JSON.stringify(next);
    let original = saved('TELEGRAM_GROUP_ACCESS') || '{}';
    try {
      original = JSON.stringify(JSON.parse(original));
    } catch {}
    if (value === original) delete updated.TELEGRAM_GROUP_ACCESS;
    else updated.TELEGRAM_GROUP_ACCESS = value;
    setChanges(updated);
    setReview(false);
  };
  const accessChoices = [
    ['deny', 'Denied'],
    ['grant', 'Allowed'],
  ];
  const setParticipantAccess = (allow: boolean, id: string) => {
    const decision = switchDecision(savedRule, rule, id, allow);
    if (decision) changeAccess(decision, id);
  };
  const personRow = (id: string) => (
    <li className="n-access-person" key={id}>
      <div className="n-access-person-name">
        <strong>{participantName(id)}</strong>
        <small>{participantMeta(id)}</small>
      </div>
      <div className="n-access-choice" role="group" aria-label={'Group access for ' + participantLabel(id)}>
        {accessChoices.map(([state, label]) => (
          <button
            type="button"
            key={state}
            disabled={busy}
            aria-pressed={participantAllowed(rule, id) === (state === 'grant')}
            onClick={() => setParticipantAccess(state === 'grant', id)}
          >
            {label}
          </button>
        ))}
      </div>
    </li>
  );
  const addManualRule = () => {
    changeAccess(manualDecision, accessUser.trim());
    setAccessUser('');
    setManualDecision('deny');
  };

  const accessEditor = (
    <div className="n-settings-access" aria-labelledby="group-access-title">
      <h4 id="group-access-title">Who may address Nocheh in groups</h4>
      <p className="n-muted">
        Everyone except you is denied by default. Switch a person to Allowed to let them address Nocheh; Denied blocks
        them. Telegram supplies group administrators; other people appear after Nocheh observes them. Save and Apply for
        changes to take effect.
      </p>
      {!identityDirectory && !identityError && <p role="status">Looking up Telegram group names and visible people…</p>}
      {identityError && <p role="status">Observed Telegram names are unavailable. You can still enter numeric IDs.</p>}
      <div className="n-actions">
        {button(
          refreshingChats ? 'Refreshing…' : 'Refresh group names from Telegram',
          refreshChats,
          refreshingChats || busy,
        )}
      </div>
      {chatRefresh && (
        <ul className="n-telegram-refresh" aria-label="Telegram group information">
          {chatRefresh.length ? (
            chatRefresh.map(chat => (
              <li key={chat.chat_id}>
                <code>{chat.chat_id}</code>{' '}
                {chat.state === 'available' ? (
                  <span dir="auto">{chatState(chat)}</span>
                ) : (
                  <strong>{chatState(chat)}</strong>
                )}
              </li>
            ))
          ) : (
            <li>No groups are selected.</li>
          )}
        </ul>
      )}
      {observed.some(group => !groups.includes(group.id)) && (
        <div className="n-field">
          <label htmlFor="observed-group">Add an observed group</label>
          <select id="observed-group" value="" disabled={busy} onChange={e => addObservedGroup(e.target.value)}>
            <option value="">Choose a group…</option>
            {observed
              .filter(group => !groups.includes(group.id))
              .map(group => (
                <option value={group.id} key={group.id}>
                  {groupLabel(group.id)}
                </option>
              ))}
          </select>
        </div>
      )}
      {groups.length ? (
        <div className="n-form">
          <div className="n-field">
            <label htmlFor="access-group">Selected group</label>
            <select id="access-group" value={chosen} disabled={busy} onChange={e => setAccessGroup(e.target.value)}>
              {groups.map(id => (
                <option value={id} key={id}>
                  {groupLabel(id)}
                </option>
              ))}
            </select>
          </div>
          <div className="n-access-directory">
            <div className="n-access-directory-head">
              <b>Known people in this group</b>
              <small>
                {participantIds.filter(id => participantAllowed(rule, id)).length +
                  ' allowed · ' +
                  participantIds.filter(id => !participantAllowed(rule, id)).length +
                  ' denied'}
              </small>
            </div>
            <ul className="n-access-people">
              {owner && (
                <li className="n-access-person n-access-owner" key="owner">
                  <div className="n-access-person-name">
                    <strong>{participantName(owner)}</strong>
                    <small>{participantMeta(owner)}</small>
                  </div>
                  <span className="n-access-owner-badge">Owner · always allowed</span>
                </li>
              )}
              {participantIds.map(personRow)}
            </ul>
            {!participantIds.length && (
              <p className="n-muted n-access-empty">No other people are known yet. You can add someone by ID below.</p>
            )}
          </div>
          <details className="n-access-manual">
            <summary>Add someone by user ID</summary>
            <div className="n-access-manual-fields">
              <div className="n-field">
                <label htmlFor="access-user">Telegram user ID</label>
                <input
                  id="access-user"
                  inputMode="numeric"
                  value={accessUser}
                  disabled={busy}
                  placeholder="Numeric user ID"
                  onChange={e => setAccessUser(e.target.value)}
                />
              </div>
              <div className="n-field">
                <label htmlFor="manual-decision">Access</label>
                <select
                  id="manual-decision"
                  value={manualDecision}
                  disabled={busy}
                  onChange={e => setManualDecision(e.target.value)}
                >
                  <option value="deny">Denied</option>
                  <option value="grant">Allowed</option>
                </select>
              </div>
              {button(
                'Add person',
                addManualRule,
                busy || !/^[1-9]\d{0,18}$/.test(accessUser.trim()) || accessUser.trim() === owner,
              )}
            </div>
          </details>
          {Object.keys(access).some(id => !groups.includes(id)) && (
            <p role="alert">
              A removed group still has access decisions. Restore its group ID or revoke its decisions before saving.
            </p>
          )}
        </div>
      ) : (
        <p className="n-muted">Add a selected group above to manage participant access.</p>
      )}
    </div>
  );

  const reviewValue = (key: string, value: string) => {
    if (key === 'TELEGRAM_GROUP_IDS') return value.split(',').filter(Boolean).map(groupLabel).join(', ') || '(empty)';
    if (key === 'TELEGRAM_OWNER_ID') return participantLabel(value);
    if (key === 'TELEGRAM_GROUP_REPLIES') return value === 'all' ? 'Every message' : 'Only when addressed';
    if (key === 'TELEGRAM_TOPIC_MEMORY') return value === 'topic' ? 'Each topic' : 'Whole group';
    if (key === 'TELEGRAM_GROUP_ACCESS')
      try {
        return (
          Object.entries(JSON.parse(value))
            .map(
              ([id, decision]: [string, any]) =>
                groupLabel(id) +
                ': ' +
                [
                  ...(decision.granted || []).map((user: string) => participantLabel(user) + ' granted'),
                  ...(decision.denied || []).map((user: string) => participantLabel(user) + ' denied'),
                ].join(', '),
            )
            .join('; ') || 'Owner only'
        );
      } catch {
        return 'Invalid group access configuration';
      }
    return value || '(empty)';
  };

  return (
    <Panel
      title="Nocheh settings"
      note="Telegram access, model routing and privacy for the whole installation. Stored in Nocheh’s .env file."
    >
      {error && <Alert>Saved settings may be stale. Edits are retained.</Alert>}
      {editRevision !== data.revision && (
        <Alert>
          These settings changed elsewhere. Your edits are retained against the original revision. Discard edits to load
          the new values, or attempt Save to see the conflict.
        </Alert>
      )}
      <StatusBadge state={data.apply_state} label={applyStateLabels[data.apply_state] || data.apply_state} />
      <form
        onSubmit={e => {
          e.preventDefault();
          setReview(true);
        }}
      >
        {fieldGroup(
          'Telegram access',
          'Choose who can use the assistant and which groups it can participate in.',
          [
            'TELEGRAM_ENABLED',
            'TELEGRAM_OWNER_ID',
            'TELEGRAM_GROUP_IDS',
            'TELEGRAM_GROUP_REPLIES',
            'TELEGRAM_BOT_NAMES',
            'TELEGRAM_TOPIC_MEMORY',
            'TELEGRAM_BOT_TOKEN',
          ],
          accessEditor,
        )}
        {fieldGroup(
          'Model and privacy',
          'These rules apply to outgoing model requests. Applying a model change also restarts Honcho. Hermes profile preferences are in the other settings section.',
          ['NOCHEH_MODEL', 'NOCHEH_EMBEDDING_MODEL', 'NOCHEH_GUARD_MODE'],
        )}
        {fieldGroup(
          'Speed',
          'How much work runs at the same time. More is faster for several chats but uses more memory and more of your model subscription at once. Apply restarts Hermes and its launcher.',
          ['NOCHEH_PARALLEL_RUNS', 'NOCHEH_PARALLEL_REPLIES', 'NOCHEH_PARALLEL_GUARD_CHECKS'],
        )}
        <details className="n-advanced">
          <summary>Advanced · destinations, connections and internal credentials</summary>
          <div className="n-form">
            {fields
              .filter(
                f =>
                  ![
                    'TELEGRAM_ENABLED',
                    'TELEGRAM_OWNER_ID',
                    'TELEGRAM_GROUP_IDS',
                    'TELEGRAM_GROUP_ACCESS',
                    'TELEGRAM_GROUP_REPLIES',
                    'TELEGRAM_BOT_NAMES',
                    'TELEGRAM_TOPIC_MEMORY',
                    'TELEGRAM_BOT_TOKEN',
                    'NOCHEH_MODEL',
                    'NOCHEH_EMBEDDING_MODEL',
                    'NOCHEH_GUARD_MODE',
                    'NOCHEH_PARALLEL_RUNS',
                    'NOCHEH_PARALLEL_REPLIES',
                    'NOCHEH_PARALLEL_GUARD_CHECKS',
                  ].includes(f.key),
              )
              .map(field)}
          </div>
        </details>
        <div className="n-actions">
          <button disabled={busy || !Object.keys(changes).length}>Review changes</button>
          {button(
            'Discard edits',
            () => {
              setChanges({});
              setReview(false);
            },
            busy || !Object.keys(changes).length,
          )}
        </div>
      </form>
      {review && (
        <div className="n-review">
          <h3>Review before saving</h3>
          <p>Saving changes the configuration file. Running services update only after Apply.</p>
          {Object.entries(changes).map(([k, v]) => (
            <p key={k}>
              {(labels[k] || k) +
                ': ' +
                (fields.find(f => f.key === k)?.secret ? 'Replace stored credential' : reviewValue(k, v))}
            </p>
          ))}
          {button('Save changes', save, busy, 'n-primary')}
        </div>
      )}
      <div className="n-apply">
        <h3>Apply saved settings</h3>
        <p className="n-muted">
          Updates the running services and may briefly interrupt Telegram replies. Save or discard your current edits
          first.
        </p>
        {button('Apply saved settings', apply, busy || !!Object.keys(changes).length)}
        <RouteLink page="operations">View apply results →</RouteLink>
      </div>
    </Panel>
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
        <p>Configure the Telegram owner and groups in Nocheh settings to make profiles available.</p>
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

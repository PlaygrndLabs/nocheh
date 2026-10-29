/**
 * Settings › Models: the providers Nocheh may call, and which model each part
 * uses. One provider and one main model is enough; parts can differ if wanted.
 */
import {useEffect, useMemo, useRef, useState} from 'react';
import {CheckCircle2, KeyRound, Loader2, Pencil, Plus, Server, Trash2, XCircle} from 'lucide-react';
import {apiPost} from '../../lib/api';
import {useSettings, type ProviderRow} from '../../lib/settings';
import {cn} from '../../lib/utils';
import {Badge, Button, Card, CardBody, CardHeader, Empty, Field, Input, Notice, Select} from '../../ui/core';
import {Dialog, useFeedback} from '../../ui/overlay';

type Custom = {id: string; name: string; url: string};
type Provider = ProviderRow & {unsaved?: boolean; newKey?: boolean};
type Listing = {models: string[]; error?: string; loading?: boolean; retry?: () => void};

const PRESET_KEY: Record<string, string> = {openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY'};
const PART_TEXT: Record<string, {title: string; hint: string}> = {
  reply: {title: 'Replies', hint: 'Writes every answer in Telegram and the browser chat.'},
  memory: {title: 'Memory', hint: 'Learns from messages and answers questions about what Nocheh remembers.'},
  guard: {
    title: 'Secret check',
    hint: 'Looks for passwords and keys before any model sees a message. A small, fast model is enough.',
  },
  image: {
    title: 'Images',
    hint: 'Reads the text in photos and images and describes them, so they can be searched. Needs a model that sees images.',
  },
};
const httpsAddress = (url: string) => /^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(url.trim());

export function listError(error: string): string {
  if (error === 'missing_key') return 'Enter its API key to check it.';
  if (error === 'invalid_url') return 'The address must start with https:// and have no password or “?” part.';
  if (error === 'invalid_key') return 'This key has characters an API key can’t have.';
  if (error === 'http_401' || error === 'http_403') return 'It refused the key. Check the key.';
  if (error === 'http_404') return 'No model list at this address. Check the address; most end in /v1.';
  if (error.startsWith('http_')) return `It answered with error ${error.slice(5)}.`;
  return 'It couldn’t be reached. Check the address. A gateway that sleeps may need a minute to wake up.';
}

/** Asks the server which models a provider lists, using the typed key or its saved one. */
function useModelList(request: Record<string, string> | null): Listing | null {
  const [state, setState] = useState<{signature: string; listing: Listing} | null>(null);
  const [attempt, setAttempt] = useState(0);
  const signature = request ? JSON.stringify(request) + '#' + attempt : '';
  const latest = useRef(signature);
  latest.current = signature;
  useEffect(() => {
    if (!request) return;
    if (state?.signature === signature && !state.listing.loading) return;
    const timer = setTimeout(() => {
      setState({signature, listing: {models: [], loading: true}});
      const done = (result: {models?: string[]; error?: string}) => {
        if (latest.current === signature)
          setState({signature, listing: {models: result.models ?? [], error: result.error}});
      };
      apiPost<{models?: string[]; error?: string}>('/settings/provider-models', request).then(done, () =>
        done({error: 'unreachable'}),
      );
    }, 500);
    return () => clearTimeout(timer);
  }, [signature]);
  if (!request) return null;
  const retry = () => setAttempt(n => n + 1);
  return state?.signature === signature ? {...state.listing, retry} : {models: [], loading: true, retry};
}

function ListingStatus({listing, className}: {listing: Listing | null; className?: string}) {
  if (!listing) return null;
  if (listing.loading)
    return (
      <p className={cn('flex items-center gap-1.5 text-xs text-muted', className)} role="status">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Checking connection…
      </p>
    );
  if (listing.error)
    return (
      <p className={cn('flex items-start gap-1.5 text-xs text-bad', className)} role="status">
        <XCircle className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          {listError(listing.error)}{' '}
          {listing.retry && (
            <button type="button" className="font-medium underline underline-offset-2" onClick={listing.retry}>
              Try again
            </button>
          )}
        </span>
      </p>
    );
  return (
    <p className={cn('flex items-center gap-1.5 text-xs text-good', className)} role="status">
      <CheckCircle2 className="size-3.5" aria-hidden />
      {listing.models.length
        ? `Connected · ${listing.models.length} models`
        : 'Connected · it lists no models, type a model name'}
    </p>
  );
}

function parse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text || '') ?? fallback;
  } catch {
    return fallback;
  }
}

export function ModelSettings() {
  const settings = useSettings();
  const feedback = useFeedback();
  const data = settings.data!;
  const busy = settings.busy;
  const savedRows: ProviderRow[] = data.providers?.list ?? [];
  const parts = data.providers?.parts ?? [];
  const customs = parse<Custom[]>(settings.value('NOCHEH_PROVIDERS'), []);
  const typedKeys = parse<Record<string, string>>(settings.changes.NOCHEH_PROVIDER_KEYS ?? '', {});

  const providers: Provider[] = [
    ...savedRows
      .filter(row => row.kind !== 'custom')
      .map(row => ({
        ...row,
        has_key: row.has_key || !!settings.changes[PRESET_KEY[row.id]!],
        newKey: !!settings.changes[PRESET_KEY[row.id]!],
      })),
    ...customs.map(custom => {
      const saved = savedRows.find(row => row.id === custom.id);
      return {
        ...custom,
        kind: 'custom',
        has_key: !!typedKeys[custom.id] || !!saved?.has_key,
        newKey: !!typedKeys[custom.id],
        unsaved: !saved || saved.url !== custom.url.replace(/\/$/, '') || saved.name !== custom.name,
      };
    }),
  ];
  const added = providers.filter(p => p.has_key || p.kind === 'custom');
  const name = (id: string) => providers.find(p => p.id === id)?.name || id;

  const writeCustoms = (next: Custom[], keys: Record<string, string>) => {
    const kept = Object.fromEntries(Object.entries(keys).filter(([id, key]) => key && next.some(c => c.id === id)));
    settings.setMany({
      NOCHEH_PROVIDERS: JSON.stringify(next),
      NOCHEH_PROVIDER_KEYS: Object.keys(kept).length ? JSON.stringify(kept) : '',
    });
  };

  const main = settings.value('NOCHEH_PROVIDER');
  const usedBy = (id: string) =>
    [
      main === id && 'Main model',
      ...parts.map(part => settings.value(part.provider_setting) === id && PART_TEXT[part.id]?.title),
      (settings.value('NOCHEH_EMBEDDING_PROVIDER') || 'openai') === id && 'Memory search',
    ].filter(Boolean) as string[];

  const [editing, setEditing] = useState<{mode: 'add'} | {mode: 'edit'; provider: Provider} | null>(null);

  const remove = async (provider: Provider) => {
    const ok = await feedback.confirm({
      title: `Remove ${provider.name}?`,
      body: 'Its address and key are deleted when you save.',
      confirm: 'Remove',
      danger: true,
    });
    if (!ok) return;
    const keys = {...typedKeys};
    delete keys[provider.id];
    writeCustoms(
      customs.filter(c => c.id !== provider.id),
      keys,
    );
  };

  const nothingYet = !main && parts.every(part => !settings.value(part.provider_setting));

  return (
    <div className="space-y-5">
      {nothingYet && (
        <Notice tone="warn" title="Nocheh can’t answer yet">
          {added.length
            ? 'Choose a main model below, then save.'
            : 'Add a provider, choose its model, then save. Until then messages are kept and answered later.'}
        </Notice>
      )}

      <Card>
        <CardHeader
          title="Providers"
          description="Services Nocheh sends model requests to. Keys stay on your server and are never shown again."
          action={
            <Button variant="primary" disabled={busy} onClick={() => setEditing({mode: 'add'})}>
              <Plus aria-hidden /> Add provider
            </Button>
          }
        />
        <CardBody className="pt-3">
          {added.length === 0 ? (
            <Empty icon={Server} title="No providers yet">
              Add OpenAI, Anthropic, or any OpenAI-compatible gateway with its address and key.
            </Empty>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {added.map(provider => (
                <ProviderItem
                  key={provider.id}
                  provider={provider}
                  usedBy={usedBy(provider.id)}
                  typedKey={
                    provider.kind === 'custom' ? typedKeys[provider.id] : settings.changes[PRESET_KEY[provider.id]!]
                  }
                  busy={busy}
                  onEdit={() => setEditing({mode: 'edit', provider})}
                  onRemove={provider.kind === 'custom' ? () => void remove(provider) : undefined}
                />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <ModelChoices providers={added} name={name} />

      {editing && (
        <ProviderDialog
          key={editing.mode === 'edit' ? editing.provider.id : 'add'}
          editing={editing.mode === 'edit' ? editing.provider : null}
          providers={providers}
          onClose={() => setEditing(null)}
          onSubmit={result => {
            if (result.kind === 'custom') {
              const exists = customs.some(c => c.id === result.id);
              const next = exists
                ? customs.map(c => (c.id === result.id ? {id: c.id, name: result.name, url: result.url} : c))
                : [...customs, {id: result.id, name: result.name, url: result.url}];
              writeCustoms(next, result.key ? {...typedKeys, [result.id]: result.key} : typedKeys);
            } else if (result.key) settings.set(PRESET_KEY[result.kind]!, result.key);
            if (result.makeMain)
              settings.setMany({NOCHEH_PROVIDER: result.id, ...(result.model ? {NOCHEH_MODEL: result.model} : {})});
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ProviderItem({
  provider,
  usedBy,
  typedKey,
  busy,
  onEdit,
  onRemove,
}: {
  provider: Provider;
  usedBy: string[];
  typedKey?: string;
  busy: boolean;
  onEdit: () => void;
  onRemove?: () => void;
}) {
  const request = useMemo(
    () =>
      provider.has_key && (provider.kind !== 'custom' || httpsAddress(provider.url ?? ''))
        ? {
            provider: provider.id,
            ...(provider.kind === 'custom' ? {url: provider.url ?? ''} : {}),
            ...(typedKey ? {key: typedKey} : {}),
          }
        : null,
    [provider.id, provider.url, provider.has_key, typedKey],
  );
  const listing = useModelList(request);
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{provider.name}</p>
          {provider.unsaved || provider.newKey ? <Badge tone="warn">Not saved yet</Badge> : null}
          {!provider.has_key && <Badge tone="bad">No key</Badge>}
        </div>
        <p className="truncate text-xs text-muted">{provider.url}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <ListingStatus listing={listing} />
          <span className="text-xs text-muted">{usedBy.length ? 'Used for ' + usedBy.join(', ') : 'Not used yet'}</span>
        </div>
      </div>
      <div className="-ml-2.5 flex gap-1 sm:ml-0">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit} aria-label={`Edit ${provider.name}`}>
          <Pencil aria-hidden /> Edit
        </Button>
        {onRemove && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || usedBy.length > 0}
            title={usedBy.length ? 'Choose another provider where it is used first' : undefined}
            onClick={onRemove}
            aria-label={`Remove ${provider.name}`}
          >
            <Trash2 aria-hidden /> Remove
          </Button>
        )}
      </div>
    </li>
  );
}

type DialogResult = {
  kind: string;
  id: string;
  name: string;
  url: string;
  key: string;
  makeMain: boolean;
  model: string;
};

/** Add a provider or change one: pick the kind, enter the address and key, see that it answers. */
function ProviderDialog({
  editing,
  providers,
  onClose,
  onSubmit,
}: {
  editing: Provider | null;
  providers: Provider[];
  onClose: () => void;
  onSubmit: (result: DialogResult) => void;
}) {
  const settings = useSettings();
  const presetsLeft = ['openai', 'anthropic'].filter(id => !providers.find(p => p.id === id)?.has_key);
  const [kind, setKind] = useState<string>(editing?.kind ?? presetsLeft[0] ?? 'custom');
  const [name, setName] = useState(editing?.kind === 'custom' ? editing.name : '');
  const [url, setUrl] = useState(editing?.kind === 'custom' ? (editing.url ?? '') : '');
  const [key, setKey] = useState('');
  const hasMain = !!settings.value('NOCHEH_PROVIDER');
  const [makeMain, setMakeMain] = useState(!editing && !hasMain);
  const [model, setModel] = useState('');
  const custom = kind === 'custom';
  const id = useMemo(() => {
    if (!custom) return kind;
    if (editing) return editing.id;
    let n = 1;
    while (providers.some(p => p.id === 'custom-' + n)) n += 1;
    return 'custom-' + n;
  }, [kind, editing]);
  const savedKey = !!editing?.has_key && !editing.newKey;
  const addressChanged =
    !!editing && custom && url.trim().replace(/\/$/, '') !== (editing.url ?? '').replace(/\/$/, '');
  // A saved key is only ever sent to the saved address, so a changed address needs the key again.
  const needsKey = !savedKey || addressChanged;
  const request =
    (custom ? httpsAddress(url) : true) && (key.trim() || !needsKey)
      ? {provider: id, ...(custom ? {url: url.trim()} : {}), ...(key.trim() ? {key: key.trim()} : {})}
      : null;
  const listing = useModelList(request);
  useEffect(() => {
    if (makeMain && listing?.models.length && !listing.models.includes(model)) {
      const current = settings.value('NOCHEH_MODEL');
      setModel(listing.models.includes(current) ? current : listing.models[0]!);
    }
  }, [listing?.models.length, makeMain]);

  const nameError = custom && name.trim().length > 40 ? 'Use 40 characters or fewer.' : '';
  const urlError =
    custom && url.trim() && !httpsAddress(url) ? 'Use an https:// address, like https://gateway.example.com/v1.' : '';
  const valid =
    (!custom || (name.trim() && !nameError && httpsAddress(url))) &&
    (!needsKey || key.trim()) &&
    (!makeMain || model.trim());
  const title = editing ? `Edit ${editing.name}` : 'Add a provider';

  return (
    <Dialog
      open
      onOpenChange={open => !open && onClose()}
      title={title}
      description={editing ? undefined : 'Nocheh checks that it answers before you add it.'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!valid}
            onClick={() =>
              onSubmit({
                kind,
                id,
                name: name.trim(),
                url: url.trim().replace(/\/$/, ''),
                key: key.trim(),
                makeMain,
                model: model.trim(),
              })
            }
          >
            {editing ? 'Done' : 'Add provider'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!editing && (
          <div role="radiogroup" aria-label="Kind of provider" className="grid gap-2 sm:grid-cols-3">
            {[
              {id: 'openai', title: 'OpenAI', hint: 'API key'},
              {id: 'anthropic', title: 'Anthropic', hint: 'API key'},
              {id: 'custom', title: 'Custom', hint: 'Any OpenAI-compatible address'},
            ].map(option => {
              const taken = option.id !== 'custom' && !presetsLeft.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={kind === option.id}
                  disabled={taken}
                  onClick={() => setKind(option.id)}
                  className={cn(
                    'rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50',
                    kind === option.id ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong',
                  )}
                >
                  <span className="block text-sm font-medium">{option.title}</span>
                  <span className="block text-xs text-muted">{taken ? 'Already added' : option.hint}</span>
                </button>
              );
            })}
          </div>
        )}
        {custom && (
          <>
            <Field label="Name" htmlFor="provider-name" error={nameError} hint="Any name you’ll recognise.">
              <Input
                id="provider-name"
                value={name}
                placeholder="My gateway"
                onChange={e => setName(e.target.value)}
                autoFocus
              />
            </Field>
            <Field
              label="Address"
              htmlFor="provider-url"
              error={urlError}
              hint="Starts with https:// and usually ends in /v1."
            >
              <Input
                id="provider-url"
                value={url}
                inputMode="url"
                placeholder="https://gateway.example.com/v1"
                onChange={e => setUrl(e.target.value)}
              />
            </Field>
          </>
        )}
        <Field
          label="API key"
          htmlFor="provider-key"
          aside={savedKey && !addressChanged ? 'A key is saved' : undefined}
          hint={
            savedKey && !addressChanged
              ? 'Leave empty to keep the saved key.'
              : addressChanged
                ? 'The address changed, so enter the key for the new address.'
                : 'Stored on your server only.'
          }
        >
          <div className="relative">
            <KeyRound className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" aria-hidden />
            <Input
              id="provider-key"
              type="password"
              autoComplete="off"
              className="pl-9"
              value={key}
              placeholder={savedKey && !addressChanged ? '****' : 'Paste the key'}
              onChange={e => setKey(e.target.value)}
              autoFocus={!custom}
            />
          </div>
        </Field>
        <div className="min-h-5">
          {request ? (
            <ListingStatus listing={listing} />
          ) : (
            <p className="text-xs text-muted">Enter the details to check the connection.</p>
          )}
        </div>
        {!editing && (
          <div className="space-y-3 rounded-lg border border-line bg-subtle/50 p-3">
            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--accent)]"
                checked={makeMain}
                onChange={e => setMakeMain(e.target.checked)}
              />
              <span>
                <span className="font-medium">Use it for everything</span>
                <span className="block text-xs text-muted">
                  Makes it the main provider. You can still pick other models per part.
                </span>
              </span>
            </label>
            {makeMain && (
              <Field label="Model" htmlFor="provider-model">
                <ModelInput id="provider-model" value={model} onChange={setModel} listing={listing} />
              </Field>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

const TYPE_OTHER = '\u0000other';

/** A dropdown of the provider's models, with a way to type any other name. */
function ModelInput({
  id,
  value,
  onChange,
  listing,
  inherit,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  listing: Listing | null;
  /** Label of the empty choice, for a part that can follow the main model. */
  inherit?: string;
  disabled?: boolean;
}) {
  const models = listing?.models ?? [];
  const [typing, setTyping] = useState(false);
  // With no list to pick from, the name is typed.
  if (typing || (!models.length && !listing?.loading)) {
    return (
      <div className="space-y-1">
        <Input
          id={id}
          value={value}
          placeholder={inherit ?? 'Model name'}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          autoFocus={typing}
          onChange={e => onChange(e.target.value.trim())}
        />
        {models.length > 0 && (
          <button
            type="button"
            className="text-xs font-medium text-accent-text hover:underline"
            onClick={() => setTyping(false)}
          >
            Choose from the list
          </button>
        )}
      </div>
    );
  }
  const options = value && !models.includes(value) ? [value, ...models] : models;
  return (
    <Select
      id={id}
      value={value}
      disabled={disabled}
      onChange={e => {
        if (e.target.value === TYPE_OTHER) setTyping(true);
        else onChange(e.target.value);
      }}
    >
      {inherit !== undefined ? (
        <option value="">{inherit}</option>
      ) : (
        !value && <option value="">{listing?.loading ? 'Loading models…' : 'Choose a model'}</option>
      )}
      {options.map(model => (
        <option key={model} value={model}>
          {model}
        </option>
      ))}
      {listing?.loading && !models.length && value && <option disabled>Loading models…</option>}
      <option value={TYPE_OTHER}>Type another name…</option>
    </Select>
  );
}

function useProviderModels(provider: Provider | undefined): Listing | null {
  const settings = useSettings();
  const typed =
    provider?.kind === 'custom'
      ? parse<Record<string, string>>(settings.changes.NOCHEH_PROVIDER_KEYS ?? '', {})[provider.id]
      : provider
        ? settings.changes[PRESET_KEY[provider.id]!]
        : undefined;
  const request = useMemo(
    () =>
      provider && provider.has_key && (provider.kind !== 'custom' || httpsAddress(provider.url ?? ''))
        ? {
            provider: provider.id,
            ...(provider.kind === 'custom' ? {url: provider.url ?? ''} : {}),
            ...(typed ? {key: typed} : {}),
          }
        : null,
    [provider?.id, provider?.url, provider?.has_key, typed],
  );
  return useModelList(request);
}

/** The main model and, if wanted, a different one for each part. */
function ModelChoices({providers, name}: {providers: Provider[]; name: (id: string) => string}) {
  const settings = useSettings();
  const data = settings.data!;
  const busy = settings.busy;
  const parts = data.providers?.parts ?? [];
  const main = settings.value('NOCHEH_PROVIDER');
  const mainModel = settings.value('NOCHEH_MODEL');
  const mainListing = useProviderModels(providers.find(p => p.id === main));
  const embeddingProvider = settings.value('NOCHEH_EMBEDDING_PROVIDER') || 'openai';
  const locked = data.models?.embedding_locked;
  const embeddingModel = settings.value('NOCHEH_EMBEDDING_MODEL');
  const rebuilding = data.models?.embedding_rebuild;
  const voiceProvider = settings.value('NOCHEH_TRANSCRIPTION_PROVIDER') || 'openai';
  const voiceModel = settings.value('NOCHEH_TRANSCRIPTION_MODEL') || 'gpt-transcribe';
  const voiceModels = data.models?.transcription ?? [{model: voiceModel, usd_per_minute: 0}];
  const voiceKey = providers.find(p => p.id === voiceProvider)?.has_key;
  const providerOptions = (blank: string) => (
    <>
      <option value="">{blank}</option>
      {providers.map(p => (
        <option key={p.id} value={p.id}>
          {p.name}
          {p.has_key ? '' : ' (no key)'}
        </option>
      ))}
    </>
  );

  return (
    <Card>
      <CardHeader
        title="Models"
        description="One main model is enough. Pick a different one for a part only if you want to."
      />
      <div className="mt-3 border-t border-line">
        <div className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-start">
          <div>
            <p className="text-sm font-medium">Main model</p>
            <p className="text-[13px] text-muted">Used for every part below unless you change it there.</p>
          </div>
          <Field label="Provider" htmlFor="main-provider">
            <Select
              id="main-provider"
              value={main}
              disabled={busy || !providers.length}
              onChange={e => settings.set('NOCHEH_PROVIDER', e.target.value)}
            >
              {providerOptions(providers.length ? 'Choose a provider' : 'Add a provider first')}
            </Select>
          </Field>
          <Field label="Model" htmlFor="main-model" error={main && !mainModel ? 'Enter a model name.' : undefined}>
            <ModelInput
              id="main-model"
              value={mainModel}
              listing={main ? mainListing : null}
              disabled={busy}
              onChange={value => settings.set('NOCHEH_MODEL', value)}
            />
            {main && <ListingStatus listing={mainListing} className="mt-1.5" />}
          </Field>
        </div>
        {parts.map(part => (
          <PartRow key={part.id} part={part} providers={providers} name={name} providerOptions={providerOptions} />
        ))}
        <div className="grid gap-3 border-t border-line px-5 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-start">
          <div>
            <p className="text-sm font-medium">Memory search</p>
            <p className="text-[13px] text-muted">
              Makes memory searchable. Needs OpenAI or a gateway that offers the same embedding models.
            </p>
          </div>
          <Field label="Provider" htmlFor="embedding-provider">
            <Select
              id="embedding-provider"
              value={embeddingProvider}
              disabled={busy}
              onChange={e => settings.set('NOCHEH_EMBEDDING_PROVIDER', e.target.value)}
            >
              {providers
                .filter(p => p.id !== 'anthropic')
                .concat(
                  providers.some(p => p.id === embeddingProvider)
                    ? []
                    : [{id: embeddingProvider, name: name(embeddingProvider)} as Provider],
                )
                .map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.has_key === false ? ' (no key)' : ''}
                  </option>
                ))}
            </Select>
          </Field>
          <Field
            label="Model"
            htmlFor="embedding-model"
            hint={
              !locked
                ? 'Memory has no search data yet, so changing it needs nothing else.'
                : rebuilding && rebuilding === settings.saved('NOCHEH_EMBEDDING_MODEL') && embeddingModel === rebuilding
                  ? `Saved. Long-term memory is rebuilt with ${rebuilding} when this applies.`
                  : embeddingModel !== locked
                    ? `Memory is stored with ${locked}. Saving rebuilds long-term memory with ${embeddingModel} from your saved messages.`
                    : `Memory is stored with ${locked}. Choosing another model rebuilds long-term memory.`
            }
          >
            <Select
              id="embedding-model"
              value={embeddingModel}
              disabled={busy}
              onChange={e => settings.set('NOCHEH_EMBEDDING_MODEL', e.target.value)}
            >
              {(data.models?.embedding ?? [embeddingModel]).map(model => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 border-t border-line px-5 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-start">
          <div>
            <p className="text-sm font-medium">Voice notes</p>
            <p className="text-[13px] text-muted">
              Turns voice notes and audio files into text, which is checked for secrets like typed text. Needs OpenAI or
              a gateway that offers the same transcription models.
            </p>
          </div>
          <Field
            label="Provider"
            htmlFor="voice-provider"
            hint={voiceKey === false ? 'This provider has no key yet, so voice notes are only archived.' : undefined}
          >
            <Select
              id="voice-provider"
              value={voiceProvider}
              disabled={busy}
              onChange={e => settings.set('NOCHEH_TRANSCRIPTION_PROVIDER', e.target.value)}
            >
              {providers
                .filter(p => p.id !== 'anthropic')
                .concat(
                  providers.some(p => p.id === voiceProvider)
                    ? []
                    : [{id: voiceProvider, name: name(voiceProvider)} as Provider],
                )
                .map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.has_key === false ? ' (no key)' : ''}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Model" htmlFor="voice-model" hint="Price per hour of audio, from OpenAI.">
            <Select
              id="voice-model"
              value={voiceModel}
              disabled={busy}
              onChange={e => settings.set('NOCHEH_TRANSCRIPTION_MODEL', e.target.value)}
            >
              {voiceModels.map(row => (
                <option key={row.model} value={row.model}>
                  {row.model}
                  {row.usd_per_minute ? ` ($${(row.usd_per_minute * 60).toFixed(2)} per hour)` : ''}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
    </Card>
  );
}

function PartRow({
  part,
  providers,
  name,
  providerOptions,
}: {
  part: {id: string; label: string; provider_setting: string; model_setting: string};
  providers: Provider[];
  name: (id: string) => string;
  providerOptions: (blank: string) => React.ReactNode;
}) {
  const settings = useSettings();
  const busy = settings.busy;
  const main = settings.value('NOCHEH_PROVIDER');
  const chosen = settings.value(part.provider_setting);
  const model = settings.value(part.model_setting);
  const effective = chosen || main;
  const listing = useProviderModels(providers.find(p => p.id === effective));
  const text = PART_TEXT[part.id] ?? {title: part.label, hint: ''};
  const mainModel = settings.value('NOCHEH_MODEL');
  return (
    <div className="grid gap-3 border-t border-line px-5 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-start">
      <div>
        <p className="text-sm font-medium">{text.title}</p>
        <p className="text-[13px] text-muted">{text.hint}</p>
      </div>
      <Field label="Provider" htmlFor={part.id + '-provider'}>
        <Select
          id={part.id + '-provider'}
          value={chosen}
          disabled={busy || !providers.length}
          onChange={e => settings.set(part.provider_setting, e.target.value)}
        >
          {providerOptions(main ? `Same as main (${name(main)})` : 'Same as main')}
        </Select>
      </Field>
      <Field label="Model" htmlFor={part.id + '-model'}>
        <ModelInput
          id={part.id + '-model'}
          value={model}
          listing={listing}
          disabled={busy}
          inherit={mainModel ? `Same as main (${mainModel})` : 'Same as main'}
          onChange={value => settings.set(part.model_setting, value)}
        />
        {chosen && <ListingStatus listing={listing} className="mt-1.5" />}
      </Field>
    </div>
  );
}

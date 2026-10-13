import {useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {Plus, Trash2} from 'lucide-react';
import {call, Alert, Button} from '../lib/page-helpers';

type Provider = {id: string; name: string; kind: string; url: string | null; has_key: boolean};
type Part = {id: string; label: string; provider_setting: string; model_setting: string};
type Custom = {id: string; name: string; url: string};
type Listing = {signature: string; models: string[]; error?: string; loading?: boolean};

const OTHER = '__other_model__';
function listError(error: string): string {
  if (error === 'missing_key') return 'Paste its API key again to list models from this address.';
  if (error === 'invalid_url') return 'Enter an https:// address without a password or query to list its models.';
  if (error === 'invalid_key') return 'This key has characters an API key cannot have.';
  if (error === 'http_401' || error === 'http_403') return 'It refused the API key; check the key.';
  if (error === 'http_404') return 'It has no model list at this address; check the address or type the model name.';
  if (error.startsWith('http_')) return 'It answered with error ' + error.slice(5) + '; type the model name.';
  return 'It could not be reached; check the address or type the model name.';
}

const PRESET_KEYS: Record<string, string> = {openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY'};
const partHints: Record<string, string> = {
  reply: 'Writes every answer in Telegram and the browser chat.',
  memory: 'Honcho’s long-term memory: learning from messages and answering memory questions.',
  guard: 'Finds passwords and keys in messages before any model sees them. A small fast model is enough.',
};

/** Keys every Models control can change; the tab marks unsaved edits to any of them. */
export const modelSettingKeys = [
  'NOCHEH_PROVIDER',
  'NOCHEH_MODEL',
  'NOCHEH_REPLY_PROVIDER',
  'NOCHEH_REPLY_MODEL',
  'NOCHEH_MEMORY_PROVIDER',
  'NOCHEH_MEMORY_MODEL',
  'NOCHEH_GUARD_PROVIDER',
  'NOCHEH_GUARD_MODEL',
  'NOCHEH_EMBEDDING_PROVIDER',
  'NOCHEH_EMBEDDING_MODEL',
  'NOCHEH_PROVIDERS',
  'NOCHEH_PROVIDER_KEYS',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
];

/** Providers, their keys, and which provider and model each part of Nocheh uses. */
export function ModelRouting({
  data,
  changes,
  update,
  busy,
}: {
  data: any;
  changes: Record<string, string>;
  update: (next: Record<string, string>) => void;
  busy: boolean;
}) {
  const fields: any[] = data.fields;
  const saved = (key: string): string => fields.find(f => f.key === key)?.value ?? '';
  const value = (key: string): string => changes[key] ?? saved(key);
  const configured = (key: string): boolean => !!fields.find(f => f.key === key)?.configured;
  const set = (key: string, next: string) => {
    const result = {...changes};
    // An empty secret keeps the stored key; a value equal to the saved one is no change.
    const secret = !!fields.find(f => f.key === key)?.secret;
    if (secret ? !next : next === saved(key)) delete result[key];
    else result[key] = next;
    update(result);
  };

  const savedList: Provider[] = data.providers?.list || [];
  const parts: Part[] = data.providers?.parts || [];
  const customs: Custom[] = (() => {
    try {
      return JSON.parse(value('NOCHEH_PROVIDERS') || '[]');
    } catch {
      return [];
    }
  })();
  const typedKeys: Record<string, string> = (() => {
    try {
      return JSON.parse(changes.NOCHEH_PROVIDER_KEYS || '{}');
    } catch {
      return {};
    }
  })();
  const normalized = (text: string) => {
    try {
      return JSON.stringify(JSON.parse(text || '[]'));
    } catch {
      return text;
    }
  };
  const setCustoms = (next: Custom[], keys: Record<string, string> = typedKeys) => {
    const result: Record<string, string> = {...changes, NOCHEH_PROVIDERS: JSON.stringify(next)};
    if (result.NOCHEH_PROVIDERS === normalized(saved('NOCHEH_PROVIDERS'))) delete result.NOCHEH_PROVIDERS;
    const kept = Object.fromEntries(Object.entries(keys).filter(([id, key]) => key && next.some(c => c.id === id)));
    if (Object.keys(kept).length) result.NOCHEH_PROVIDER_KEYS = JSON.stringify(kept);
    else delete result.NOCHEH_PROVIDER_KEYS;
    update(result);
  };
  const presets = savedList.filter(p => p.kind !== 'custom');
  const all: Provider[] = [
    ...presets,
    ...customs.map(c => ({
      ...c,
      kind: 'custom',
      has_key: !!typedKeys[c.id] || !!savedList.find(p => p.id === c.id)?.has_key,
    })),
  ];
  const providerName = (id: string) => all.find(p => p.id === id)?.name || id;

  // Model lists: what each added provider lists. A
  // provider is asked again, after a short pause, whenever its address or typed key changes,
  // so its models appear while it is still being added; the server sends the key, never the page.
  const [listed, setListed] = useState<Record<string, Listing>>({});
  const requests = useMemo(
    () =>
      Object.fromEntries(
        all
          .filter(p => p.has_key && (p.kind !== 'custom' || /^https:\/\/\S+$/.test(p.url || '')))
          .map(p => {
            const typed = p.kind === 'custom' ? typedKeys[p.id] : changes[PRESET_KEYS[p.id]];
            return [
              p.id,
              {provider: p.id, ...(p.kind === 'custom' ? {url: p.url} : {}), ...(typed ? {key: typed} : {})},
            ];
          }),
      ) as Record<string, Record<string, string>>,
    [JSON.stringify(all), changes.NOCHEH_PROVIDER_KEYS, changes.OPENAI_API_KEY, changes.ANTHROPIC_API_KEY],
  );
  const latest = useRef(requests);
  latest.current = requests;
  useEffect(() => {
    const timers = Object.entries(requests).map(([id, request]) => {
      const signature = JSON.stringify(request);
      if (listed[id]?.signature === signature) return undefined;
      return setTimeout(() => {
        setListed(current => ({...current, [id]: {signature, models: current[id]?.models || [], loading: true}}));
        const done = (result: {models?: string[]; error?: string}) => {
          if (JSON.stringify(latest.current[id]) !== signature) return;
          setListed(current => ({...current, [id]: {signature, models: result.models || [], error: result.error}}));
        };
        call('/settings/provider-models', request).then(done, () => done({error: 'unreachable'}));
      }, 600);
    });
    return () => timers.forEach(timer => timer && clearTimeout(timer));
  }, [JSON.stringify(requests)]);
  const listing = (id: string): Listing | undefined =>
    requests[id] && listed[id]?.signature === JSON.stringify(requests[id]) ? listed[id] : undefined;
  const modelsOf = (id: string): string[] => listing(id)?.models || [];
  const listNote = (id: string): string => {
    if (!id) return 'Not configured. Choose a provider to list its models.';
    const provider = all.find(p => p.id === id);
    if (!provider) return '';
    if (provider.kind === 'custom' && !/^https:\/\/\S+$/.test(provider.url || ''))
      return 'Enter its https:// address to list its models.';
    if (!provider.has_key) return 'Add its API key to list its models.';
    const found = listing(id);
    if (!found || found.loading) return 'Loading its models…';
    if (found.error) return listError(found.error);
    return found.models.length
      ? found.models.length + ' models available.'
      : 'It listed no models; type the model name.';
  };

  const modelsClass = (id: string) => {
    const found = listing(id);
    return 'n-provider-models' + (found?.error ? ' is-error' : found?.models.length ? ' is-ready' : '');
  };
  // A part row speaks up only while its provider's models are not listed.
  const rowNote = (id: string): string => (modelsOf(id).length ? '' : listNote(id));
  const [typing, setTyping] = useState<Record<string, boolean>>({});

  const modelField = (id: string, key: string, provider: string, fallback?: string) => {
    const options = modelsOf(provider);
    const current = value(key);
    if (!options.length || typing[key])
      return (
        <input
          id={id + '-model'}
          value={current}
          placeholder={fallback ? 'Same as default · ' + fallback : 'Model name'}
          disabled={busy}
          autoComplete="off"
          onChange={e => set(key, e.target.value.trim())}
        />
      );
    return (
      <select
        id={id + '-model'}
        value={current}
        disabled={busy}
        onChange={e => {
          if (e.target.value === OTHER) setTyping({...typing, [key]: true});
          else set(key, e.target.value);
        }}
      >
        {fallback !== undefined && <option value="">Same as default · {fallback || 'not set'}</option>}
        {fallback === undefined && !current && <option value="">Choose a model</option>}
        {current && !options.includes(current) && <option value={current}>{current} · not listed</option>}
        {options.map(model => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
        <option value={OTHER}>Type another model…</option>
      </select>
    );
  };

  const keyField = (
    id: string,
    label: string,
    isConfigured: boolean,
    typed: string,
    onChange: (v: string) => void,
    models?: string,
  ) => (
    <div className="n-field">
      <label htmlFor={'key-' + id}>
        {label}
        <span className="n-secret-status">{typed ? 'New key' : isConfigured ? 'Configured' : 'Missing'}</span>
      </label>
      <input
        id={'key-' + id}
        type="password"
        value={typed}
        placeholder={isConfigured ? '****' : 'Paste the API key'}
        autoComplete="off"
        disabled={busy}
        onChange={e => onChange(e.target.value)}
      />
      <small>
        {typed
          ? 'Saved with the other changes.'
          : isConfigured
            ? 'Leave blank to keep the saved key; paste a new one to replace it.'
            : 'Needed before any part can use this provider.'}
      </small>
      {models && (typed || isConfigured) && (
        <small className={modelsClass(id)} role="status">
          {models}
        </small>
      )}
    </div>
  );

  // '' is not configured: a fresh installation starts, but model calls wait until a provider is chosen.
  const defaultProvider = value('NOCHEH_PROVIDER');
  const nothingConfigured = !saved('NOCHEH_PROVIDER') && parts.every(part => !saved(part.provider_setting));
  const embeddingChoices = all.filter(p => p.id !== 'anthropic');
  const locked = data.models?.embedding_locked;
  const row = (id: string, title: string, hint: ReactNode, provider: ReactNode, model: ReactNode, note: string) => (
    <div className="n-model-route" key={id}>
      <div className="n-model-route-title">
        <strong>{title}</strong>
        <small className="n-muted">{hint}</small>
      </div>
      <div className="n-field">
        <label htmlFor={id + '-provider'}>Provider</label>
        {provider}
      </div>
      <div className="n-field">
        <label htmlFor={id + '-model'}>Model</label>
        {model}
        {note && <small role="status">{note}</small>}
      </div>
    </div>
  );

  return (
    <>
      {nothingConfigured && (
        <Alert>
          Nocheh has no model provider yet. Add one below and choose it as the default, then save and apply.
        </Alert>
      )}
      <section className="n-settings-group" aria-labelledby="settings-providers">
        <h3 id="settings-providers">Providers</h3>
        <p className="n-muted">
          Where Nocheh sends model requests. Add OpenAI or Anthropic with an API key, or a custom OpenAI-compatible
          provider such as a hosted sub2api gateway with its address and key. Keys stay on the server and are never
          shown again.
        </p>
        <div className="n-form">
          {keyField(
            'openai',
            'OpenAI API key',
            configured('OPENAI_API_KEY'),
            changes.OPENAI_API_KEY ?? '',
            v => set('OPENAI_API_KEY', v),
            listNote('openai'),
          )}
          {keyField(
            'anthropic',
            'Anthropic API key',
            configured('ANTHROPIC_API_KEY'),
            changes.ANTHROPIC_API_KEY ?? '',
            v => set('ANTHROPIC_API_KEY', v),
            listNote('anthropic'),
          )}
        </div>
        {customs.map((custom, index) => {
          const change = (patch: Partial<Custom>) =>
            setCustoms(customs.map((c, i) => (i === index ? {...c, ...patch} : c)));
          const usedBy = [
            defaultProvider === custom.id && 'Default',
            ...parts.map(p => value(p.provider_setting) === custom.id && p.label),
            value('NOCHEH_EMBEDDING_PROVIDER') === custom.id && 'Memory search',
          ].filter(Boolean);
          const title = custom.name.trim() || 'New provider';
          return (
            <div className="n-custom-provider" role="group" aria-labelledby={'title-' + custom.id} key={custom.id}>
              <div className="n-custom-provider-head">
                <div>
                  <strong id={'title-' + custom.id}>{title}</strong>
                  <small className="n-muted">
                    {usedBy.length ? 'Used by ' + usedBy.join(', ') : 'Not used by any part yet'}
                  </small>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="n-custom-provider-remove"
                  aria-label={'Remove ' + (custom.name.trim() || 'provider')}
                  disabled={busy || usedBy.length > 0}
                  title={usedBy.length ? 'Choose another provider for the parts that use it first' : undefined}
                  onClick={() => setCustoms(customs.filter((_, i) => i !== index))}
                >
                  <Trash2 size={16} aria-hidden={true} /> Remove
                </Button>
              </div>
              <div className="n-custom-provider-fields">
                <div className="n-field">
                  <label htmlFor={'name-' + custom.id}>Name</label>
                  <input
                    id={'name-' + custom.id}
                    value={custom.name}
                    placeholder="sub2api"
                    disabled={busy}
                    onChange={e => change({name: e.target.value})}
                  />
                </div>
                <div className="n-field">
                  <label htmlFor={'url-' + custom.id}>Address</label>
                  <input
                    id={'url-' + custom.id}
                    value={custom.url}
                    placeholder="https://sub2api.example.workers.dev/v1"
                    disabled={busy}
                    onChange={e => change({url: e.target.value.trim()})}
                  />
                  <small>OpenAI-compatible, starting with https:// and usually ending in /v1.</small>
                </div>
                {keyField(
                  custom.id,
                  'API key',
                  !!savedList.find(p => p.id === custom.id)?.has_key,
                  typedKeys[custom.id] ?? '',
                  v => setCustoms(customs, {...typedKeys, [custom.id]: v}),
                )}
              </div>
              <p className={modelsClass(custom.id)} role="status">
                {listNote(custom.id)}
              </p>
            </div>
          );
        })}
        <div className="n-actions">
          <Button
            type="button"
            variant="outline"
            disabled={busy || customs.length >= 10}
            onClick={() => {
              let n = customs.length + 1;
              while (all.some(p => p.id === 'custom-' + n)) n += 1;
              setCustoms([...customs, {id: 'custom-' + n, name: '', url: ''}]);
            }}
          >
            <Plus size={16} aria-hidden={true} /> Add custom provider
          </Button>
        </div>
      </section>

      <section className="n-settings-group" aria-labelledby="settings-routes">
        <h3 id="settings-routes">Which provider each part uses</h3>
        <p className="n-muted">
          One provider and model is enough: every part uses the default unless you choose something else for it. Apply
          restarts the parts whose provider or model changed, including Honcho.
        </p>
        <div className="n-model-routes">
          {row(
            'default',
            'Default',
            'Used by every part set to “Same as default”.',
            <select
              id="default-provider"
              value={defaultProvider}
              disabled={busy}
              onChange={e => set('NOCHEH_PROVIDER', e.target.value)}
            >
              {!defaultProvider && <option value="">Not configured</option>}
              {all.map(p => (
                <option key={p.id} value={p.id}>
                  {(p.name || 'New provider') + (!p.has_key ? ' · no key' : '')}
                </option>
              ))}
            </select>,
            modelField('default', 'NOCHEH_MODEL', defaultProvider),
            rowNote(defaultProvider),
          )}
          {parts.map(part => {
            const chosen = value(part.provider_setting);
            const effective = chosen || defaultProvider;
            return row(
              part.id,
              part.label,
              partHints[part.id] || '',
              <select
                id={part.id + '-provider'}
                value={chosen}
                disabled={busy}
                onChange={e => set(part.provider_setting, e.target.value)}
              >
                <option value="">
                  Same as default · {defaultProvider ? providerName(defaultProvider) : 'Not configured'}
                </option>
                {all.map(p => (
                  <option key={p.id} value={p.id}>
                    {(p.name || 'New provider') + (!p.has_key ? ' · no key' : '')}
                  </option>
                ))}
              </select>,
              modelField(part.id, part.model_setting, effective, value('NOCHEH_MODEL')),
              rowNote(effective),
            );
          })}
          {row(
            'embedding',
            'Memory search',
            'Turns Honcho memory into searchable vectors, paid from the embedding budget. Anthropic does not offer this.',
            <select
              id="embedding-provider"
              value={value('NOCHEH_EMBEDDING_PROVIDER') || 'openai'}
              disabled={busy}
              onChange={e => set('NOCHEH_EMBEDDING_PROVIDER', e.target.value)}
            >
              {embeddingChoices.map(p => (
                <option key={p.id} value={p.id}>
                  {(p.name || 'New provider') + (!p.has_key ? ' · no key' : '')}
                </option>
              ))}
            </select>,
            <select
              id="embedding-model"
              value={value('NOCHEH_EMBEDDING_MODEL')}
              disabled={busy}
              onChange={e => set('NOCHEH_EMBEDDING_MODEL', e.target.value)}
            >
              {(data.models?.embedding || [value('NOCHEH_EMBEDDING_MODEL')]).map((model: string) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>,
            locked
              ? 'Memory already holds vectors from ' + locked + '; another model needs a Honcho memory rebuild first.'
              : 'It can be changed until memory stores its first vectors.',
          )}
        </div>
      </section>
    </>
  );
}

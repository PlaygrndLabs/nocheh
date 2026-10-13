import {useEffect, useState, type ReactNode} from 'react';
import {Plus, Trash2} from 'lucide-react';
import {call, Button} from '../lib/page-helpers';

type Provider = {id: string; name: string; kind: string; url: string | null; has_key: boolean};
type Part = {id: string; label: string; provider_setting: string; model_setting: string};
type Custom = {id: string; name: string; url: string};

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

  // Model lists: the built-in login's served models, or what a saved provider lists with its saved key.
  const [listed, setListed] = useState<Record<string, {models: string[]; error?: string}>>({});
  const listable = (id: string) => id !== 'builtin' && savedList.some(p => p.id === id && p.has_key);
  const wanted = Array.from(
    new Set(
      [
        value('NOCHEH_PROVIDER'),
        ...parts.map(p => value(p.provider_setting)),
        value('NOCHEH_EMBEDDING_PROVIDER'),
      ].filter(listable),
    ),
  );
  useEffect(() => {
    for (const id of wanted) {
      if (listed[id]) continue;
      setListed(current => ({...current, [id]: {models: []}}));
      call('/settings/provider-models?provider=' + encodeURIComponent(id))
        .then((result: any) => setListed(current => ({...current, [id]: result})))
        .catch(() => setListed(current => ({...current, [id]: {models: [], error: 'unreachable'}})));
    }
  }, [wanted.join(',')]);
  const modelsOf = (id: string): string[] =>
    id === 'builtin' ? data.models?.reasoning || [] : listed[id]?.models || [];
  const modelNote = (id: string): string => {
    if (id === 'builtin')
      return data.models?.provider_running === false
        ? 'Nocheh’s provider service is not running, so its models cannot be listed.'
        : modelsOf(id).length
          ? ''
          : 'Sign in to Claude or ChatGPT in the CPA dashboard to list models.';
    if (!savedList.some(p => p.id === id)) return 'Save this provider to list its models.';
    if (!savedList.find(p => p.id === id)?.has_key) return 'Add and save its API key to list its models.';
    const found = listed[id];
    if (!found) return '';
    if (found.error)
      return 'Its model list is unavailable (' + found.error.replace('_', ' ') + '); type the model name.';
    return found.models.length ? '' : 'It listed no models; type the model name.';
  };

  const modelInput = (id: string, key: string, provider: string, placeholder?: string) => {
    const options = modelsOf(provider);
    return (
      <>
        <input
          id={id + '-model'}
          list={key + '-models'}
          value={value(key)}
          placeholder={placeholder}
          disabled={busy}
          autoComplete="off"
          onChange={e => set(key, e.target.value.trim())}
        />
        <datalist id={key + '-models'}>
          {options.map(model => (
            <option key={model} value={model} />
          ))}
        </datalist>
      </>
    );
  };

  const keyField = (id: string, label: string, isConfigured: boolean, typed: string, onChange: (v: string) => void) => (
    <div className="n-field">
      <label htmlFor={'key-' + id}>
        {label}
        <span className="n-secret-status">{isConfigured ? 'Configured' : 'Missing'}</span>
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
        {isConfigured
          ? '**** is a placeholder, not the saved key. Leave blank to keep it; paste a new key to replace it.'
          : 'Needed before any part can use this provider.'}
      </small>
    </div>
  );

  const defaultProvider = value('NOCHEH_PROVIDER') || 'builtin';
  const embeddingChoices = all.filter(p => !['builtin', 'anthropic'].includes(p.id));
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
      <section className="n-settings-group" aria-labelledby="settings-providers">
        <h3 id="settings-providers">Providers</h3>
        <p className="n-muted">
          Where Nocheh sends model requests. Nocheh login is your Claude or ChatGPT subscription in Nocheh’s own proxy,
          signed in from the <a href="/providers/management.html">CPA dashboard</a>. Add OpenAI or Anthropic with an API
          key, or a custom OpenAI-compatible provider such as a hosted provider gateway with its address and key. Keys
          stay on the server and are never shown again.
        </p>
        <div className="n-form">
          {keyField('openai', 'OpenAI API key', configured('OPENAI_API_KEY'), changes.OPENAI_API_KEY ?? '', v =>
            set('OPENAI_API_KEY', v),
          )}
          {keyField(
            'anthropic',
            'Anthropic API key',
            configured('ANTHROPIC_API_KEY'),
            changes.ANTHROPIC_API_KEY ?? '',
            v => set('ANTHROPIC_API_KEY', v),
          )}
        </div>
        {customs.map((custom, index) => {
          const change = (patch: Partial<Custom>) =>
            setCustoms(customs.map((c, i) => (i === index ? {...c, ...patch} : c)));
          const inUse = [
            defaultProvider,
            ...parts.map(p => value(p.provider_setting)),
            value('NOCHEH_EMBEDDING_PROVIDER'),
          ].includes(custom.id);
          return (
            <fieldset className="n-custom-provider" key={custom.id}>
              <legend>{custom.name || 'New provider'}</legend>
              <div className="n-form">
                <div className="n-field">
                  <label htmlFor={'name-' + custom.id}>Name</label>
                  <input
                    id={'name-' + custom.id}
                    value={custom.name}
                    placeholder="my-gateway"
                    disabled={busy}
                    onChange={e => change({name: e.target.value})}
                  />
                </div>
                <div className="n-field">
                  <label htmlFor={'url-' + custom.id}>Address</label>
                  <input
                    id={'url-' + custom.id}
                    value={custom.url}
                    placeholder="https://my-gateway.example.workers.dev/v1"
                    disabled={busy}
                    onChange={e => change({url: e.target.value.trim()})}
                  />
                  <small>The OpenAI-compatible base address, usually ending in /v1. It must start with https://.</small>
                </div>
                {keyField(
                  custom.id,
                  'API key',
                  !!savedList.find(p => p.id === custom.id)?.has_key,
                  typedKeys[custom.id] ?? '',
                  v => setCustoms(customs, {...typedKeys, [custom.id]: v}),
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={busy || inUse}
                title={inUse ? 'Choose another provider for the parts that use it first' : undefined}
                onClick={() => setCustoms(customs.filter((_, i) => i !== index))}
              >
                <Trash2 size={16} aria-hidden={true} /> Remove {custom.name || 'provider'}
              </Button>
              {inUse && <small className="n-muted"> A part uses this provider, so it cannot be removed yet.</small>}
            </fieldset>
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
              {all.map(p => (
                <option key={p.id} value={p.id}>
                  {(p.name || 'New provider') + (p.id !== 'builtin' && !p.has_key ? ' · no key' : '')}
                </option>
              ))}
            </select>,
            modelInput('default', 'NOCHEH_MODEL', defaultProvider),
            modelNote(defaultProvider),
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
                <option value="">Same as default · {providerName(defaultProvider)}</option>
                {all.map(p => (
                  <option key={p.id} value={p.id}>
                    {(p.name || 'New provider') + (p.id !== 'builtin' && !p.has_key ? ' · no key' : '')}
                  </option>
                ))}
              </select>,
              modelInput(
                part.id,
                part.model_setting,
                effective,
                'Same as default · ' + (value('NOCHEH_MODEL') || 'not set'),
              ),
              modelNote(effective),
            );
          })}
          {row(
            'embedding',
            'Memory search',
            'Turns Honcho memory into searchable vectors, paid from the embedding budget. Nocheh login cannot do this.',
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

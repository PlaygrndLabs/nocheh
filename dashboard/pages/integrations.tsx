import {Panel, Details, useResource, StatusBadge} from '../lib/page-helpers';

export function Integrations() {
  const {data, error} = useResource('/runtime', 10000);
  return (
    <div>
      <Panel title="Hermes" note="Your agent runtime: chat, native tools, profiles, sessions and built-in memory.">
        {error && <p role="alert">{error}</p>}
        {!data && !error && <p role="status">Checking runtime…</p>}
        {data && (
          <div>
            <StatusBadge
              state={data.status?.ok ? 'connected' : 'unknown'}
              label={data.status?.ok ? 'Runtime connected' : 'Runtime unobserved'}
            />
            <p className="n-muted">
              {data.status?.model || 'Check runtime health or restart services in Maintenance.'}
            </p>
            <a className="n-text-link" href="/hermes/nocheh">
              Open native Hermes dashboard →
            </a>
            <div className="capability-list">
              {Object.entries(data.capabilities || {})
                .filter(([, v]) => typeof v === 'boolean')
                .map(([name, value]) => (
                  <div className="n-row" key={name}>
                    <b>{name.replaceAll('_', ' ')}</b>
                    <StatusBadge state={value ? 'ready' : 'disabled'} label={value ? 'Available' : 'Disabled'} />
                  </div>
                ))}
            </div>
            <Details value={data} label="Runtime status and capabilities" />
          </div>
        )}
      </Panel>
    </div>
  );
}

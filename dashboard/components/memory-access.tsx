import {useState} from 'react';
import {Alert, Badge, Button, EmptyState} from './ui/primitives';
import {CursorButtons, EvidenceLinks, Provenance, ResourceState, useOwnerCommand} from '../lib/owner-controls';
import {accessDescription} from '../lib/memory-access-presentation';
import {useResource} from '../lib/resource';

export type NodeKind = 'person' | 'project' | 'conversation' | 'topic' | 'fact';
export type MapNode = {id: string; kind: NodeKind; label: string; state?: string; detail?: Record<string, any>};
export type Request = {
  id: string;
  destination: string;
  state: string;
  revision: number;
  expires_at: string;
  wording: string | null;
  relationship_path: string[];
  evidence: {id: string}[];
  provenance: unknown;
};
export type Grant = {
  id: string;
  destination: string;
  fact_revision: number;
  mode: string;
  state: string;
  revision: number;
  wording: string | null;
  suspended_reason: string | null;
  provenance: unknown;
};
type RequestPage = {requests: Request[]; next: string | null};
type GrantPage = {grants: Grant[]; next: string | null};

export const countLabel = (count: number, label: string) => `${count} ${label}${count === 1 ? '' : 's'}`;
export const destinationName = (destination: string, nodes: MapNode[]) =>
  nodes.find(node => node.detail?.space_id === destination)?.label ??
  (destination.includes('/topic/')
    ? `Topic ${destination.split('/topic/')[1]} · Group ${destination.split('/topic/')[0]}`
    : `Conversation ${destination}`);

export function RequestRow({
  item,
  nodes = [],
  onChanged,
  disabled = false,
}: {
  item: Request;
  nodes?: MapNode[];
  onChanged: (message?: string) => void;
  disabled?: boolean;
}) {
  const [wording, setWording] = useState(item.wording ?? ''),
    [mode, setMode] = useState<'one_time' | 'persistent'>('one_time'),
    command = useOwnerCommand();
  const decide = async (decision: 'one_time' | 'persistent' | 'reject') => {
    if (
      await command.run('/memory-access/requests/' + item.id + '/decide', {
        decision,
        expected_revision: item.revision,
        ...(decision === 'reject' ? {} : {wording}),
      })
    )
      onChanged(
        decision === 'reject'
          ? 'Request rejected. No access granted.'
          : decision === 'one_time'
            ? 'One-time access approved.'
            : 'Access approved until revoked.',
      );
  };
  return (
    <article className="memory-access-card">
      <div className="list-heading">
        <div>
          <small>Requested for</small>
          <h3>{destinationName(item.destination, nodes)}</h3>
          <small>{item.destination}</small>
        </div>
        <Badge>{item.state === 'pending' ? 'Needs review' : item.state}</Badge>
      </div>
      {item.state === 'pending' ? (
        <>
          <label>
            Wording this conversation may use
            <textarea
              rows={4}
              maxLength={12000}
              value={wording}
              disabled={disabled || command.busy}
              onChange={event => setWording(event.target.value)}
            />
          </label>
          <p className="n-muted">Only this wording is shared. Original evidence and private provenance stay private.</p>
          <label>
            How long should access last?
            <select
              value={mode}
              disabled={disabled || command.busy}
              onChange={event => setMode(event.target.value as typeof mode)}
            >
              <option value="one_time">One-time (default)</option>
              <option value="persistent">Persistent until revoked</option>
            </select>
          </label>
          <p className="n-muted">
            {mode === 'one_time'
              ? 'For one pending reply. Used only after confirmed delivery.'
              : 'This exact group or topic can recall this wording until access is revoked or suspended.'}{' '}
            An approved follow-up may be sent automatically, according to your settings.
          </p>
        </>
      ) : (
        <p className="memory-prose">{item.wording}</p>
      )}
      <details className="memory-review-context">
        <summary>Why this was suggested · evidence</summary>
        <p>Related through {item.relationship_path.join(' → ') || 'confirmed evidence'}</p>
        <p className="n-muted">Expires {new Date(item.expires_at).toLocaleString()}</p>
        <EvidenceLinks sources={item.evidence} />
        <Provenance value={item.provenance} label="Owner-only provenance" />
      </details>
      {command.error && <Alert>{command.error}</Alert>}
      {item.state === 'pending' && (
        <div className="n-actions">
          <Button
            variant="default"
            disabled={disabled || command.busy || !wording.trim()}
            onClick={() => void decide(mode)}
          >
            {command.busy ? 'Saving…' : mode === 'one_time' ? 'Approve for one reply' : 'Approve until revoked'}
          </Button>
          <Button disabled={disabled || command.busy} onClick={() => void decide('reject')}>
            Reject once
          </Button>
        </div>
      )}
    </article>
  );
}

export function GrantRow({
  item,
  nodes = [],
  onChanged,
}: {
  item: Grant;
  nodes?: MapNode[];
  onChanged: (message?: string) => void;
}) {
  const command = useOwnerCommand();
  return (
    <article className="memory-access-card">
      <div className="list-heading">
        <div>
          <small>Shared with</small>
          <h3>{destinationName(item.destination, nodes)}</h3>
          <small>{item.destination}</small>
        </div>
        <Badge>{item.state}</Badge>
      </div>
      <p className="memory-prose">{item.wording || 'Approved wording is unavailable.'}</p>
      <p className="memory-access-duration">
        {item.mode === 'one_time' ? 'One reply only' : 'Until revoked'} · revision {item.fact_revision}
      </p>
      <p className="n-muted">
        {accessDescription(item.state)}
        {item.suspended_reason ? ' ' + item.suspended_reason.replaceAll('_', ' ') : ''}
      </p>
      {command.error && <Alert>{command.error}</Alert>}
      {['active', 'suspended'].includes(item.state) && (
        <>
          <Button
            variant="destructive"
            disabled={command.busy}
            onClick={async () => {
              if (await command.run('/memory-access/grants/' + item.id + '/revoke', {expected_revision: item.revision}))
                onChanged('Access revoked. Future recall through this grant is blocked.');
            }}
          >
            {command.busy ? 'Revoking…' : 'Revoke access'}
          </Button>
          <small className="memory-revoke-note">
            Stops future recall. Messages already delivered cannot be taken back.
          </small>
        </>
      )}
      <Provenance value={item.provenance} label="Owner-only provenance" />
    </article>
  );
}

const reviewPath = (base: string, after: string, destination?: string) => {
  const query = [
    ...(after ? ['after=' + encodeURIComponent(after)] : []),
    ...(destination ? ['destination=' + encodeURIComponent(destination)] : []),
  ].join('&');
  return base + (query ? '?' + query : '');
};

const noop = () => {};

export function AccessReview({
  mode,
  destination,
  nodes,
  onChanged = noop,
}: {
  mode: 'requests' | 'grants';
  destination?: string;
  nodes?: MapNode[];
  onChanged?: (message?: string) => void;
}) {
  const [pages, setPages] = useState(['']),
    [pagesFor, setPagesFor] = useState(destination);
  if (pagesFor !== destination) {
    // A cursor from another chat's list is meaningless here; start over.
    setPagesFor(destination);
    setPages(['']);
  }
  const directory = useResource<{nodes: MapNode[]}>(nodes ? null : '/memory-map?limit=250'),
    names = nodes ?? directory.data?.nodes ?? [],
    requests = useResource<RequestPage>(
      mode === 'requests' ? reviewPath('/memory-access/requests', pages.at(-1)!, destination) : null,
    ),
    grants = useResource<GrantPage>(
      mode === 'grants' ? reviewPath('/memory-access/grants', pages.at(-1)!, destination) : null,
    );
  const resource = mode === 'requests' ? requests : grants,
    all = mode === 'requests' ? (requests.data?.requests ?? []) : (grants.data?.grants ?? []),
    current = all.filter(item =>
      mode === 'requests' ? item.state === 'pending' : ['active', 'suspended'].includes(item.state),
    ),
    past = all.filter(item => !current.includes(item));
  const row = (item: Request | Grant) =>
    mode === 'requests' ? (
      <RequestRow key={item.id} item={item as Request} nodes={names} onChanged={onChanged} />
    ) : (
      <GrantRow key={item.id} item={item as Grant} nodes={names} onChanged={onChanged} />
    );
  const emptyTitle = destination
    ? mode === 'requests'
      ? 'No pending requests for this chat'
      : 'Nothing shared with this chat yet'
    : mode === 'requests'
      ? 'No pending requests on this page'
      : 'No current shares on this page';
  return (
    <section className="memory-access-review">
      {!destination && (
        <div className="memory-section-intro">
          <h3>{mode === 'requests' ? 'Review requests' : 'Shared memory'}</h3>
          <p className="n-muted">
            {mode === 'requests'
              ? 'Review the exact wording before allowing another conversation to use it.'
              : 'See where approved facts can be used, and revoke access when needed.'}
          </p>
        </div>
      )}
      <ResourceState {...resource} hasData={!!resource.data} />
      {resource.data && !current.length && destination && <p className="n-muted">{emptyTitle}.</p>}
      {resource.data && !current.length && !destination && (
        <EmptyState title={emptyTitle}>
          {mode === 'requests'
            ? 'Suggestions appear here when a related fact could help a group or topic. Nothing is shared without your approval.'
            : 'To share a fact, open it in Memory › People & facts and choose Share fact.'}
        </EmptyState>
      )}
      <div className="memory-access-cards">{current.map(row)}</div>
      {past.length > 0 && (
        <details className="memory-decision-history">
          <summary>
            {mode === 'requests' ? 'Past decisions' : 'Past access'} on this page ({past.length})
          </summary>
          <div className="memory-access-cards">{past.map(row)}</div>
        </details>
      )}
      {(!destination || all.length > 0) && (
        <div className="memory-review-pagination">
          <span>
            {resource.data
              ? `${countLabel(all.length, 'record')} on this page${resource.data.next ? ' · more available' : ''}`
              : ''}
          </span>
          <CursorButtons pages={pages} next={resource.data?.next} onChange={setPages} />
        </div>
      )}
    </section>
  );
}

export function AccessDefaults({
  destination: fixedDestination,
  onChanged = noop,
}: {
  destination?: string;
  onChanged?: (message?: string) => void;
}) {
  const data = useResource<any>('/memory-access/settings'),
    command = useOwnerCommand(),
    [pickedDestination, setDestination] = useState(''),
    destination = fixedDestination ?? pickedDestination;
  if (!data.data) return <ResourceState {...data} hasData={false} />;
  const global = data.data.settings.find((row: any) => row.destination === '*'),
    override = data.data.settings.find((row: any) => row.destination === destination);
  const fields = (prefix: string, values: any) => (
    <>
      <div className="search-toolbar">
        <label>
          Suggestions
          <select name={prefix + 'suggestions'} defaultValue={values.suggestions ?? global.suggestions}>
            <option value="related">Related entities only</option>
            <option value="off">Off</option>
          </select>
        </label>
        <label>
          Default approval
          <select
            name={prefix + 'default_grant_mode'}
            defaultValue={values.default_grant_mode ?? global.default_grant_mode}
          >
            <option value="one_time">One-time</option>
            <option value="persistent">Persistent</option>
          </select>
        </label>
        <label>
          Request lifetime (seconds)
          <input
            name={prefix + 'request_ttl_seconds'}
            type="number"
            min="60"
            max="2592000"
            defaultValue={values.request_ttl_seconds ?? global.request_ttl_seconds}
          />
        </label>
      </div>
      <label className="owner-check">
        <input
          name={prefix + 'notify_owner'}
          type="checkbox"
          defaultChecked={values.notify_owner ?? global.notify_owner}
        />{' '}
        Send content-free owner notification
      </label>
      <label className="owner-check">
        <input
          name={prefix + 'auto_followup'}
          type="checkbox"
          defaultChecked={values.auto_followup ?? global.auto_followup}
        />{' '}
        Send approved follow-up automatically
      </label>
    </>
  );
  const values = (form: FormData, prefix: string) => ({
    suggestions: form.get(prefix + 'suggestions'),
    notify_owner: form.get(prefix + 'notify_owner') === 'on',
    auto_followup: form.get(prefix + 'auto_followup') === 'on',
    request_ttl_seconds: Number(form.get(prefix + 'request_ttl_seconds')),
    default_grant_mode: form.get(prefix + 'default_grant_mode'),
  });
  return (
    <section className="n-panel">
      <h3>Suggestion and delivery settings</h3>
      {fixedDestination === undefined && (
        <>
          <h4>Global defaults</h4>
          <form
            className="owner-form"
            onSubmit={async event => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              if (
                await command.run('/memory-access/settings', {
                  destination: '*',
                  ...values(form, 'global_'),
                  expected_revision: global.revision,
                })
              )
                onChanged('Suggestion defaults saved.');
            }}
          >
            {fields('global_', global)}
            <Button type="submit" variant="default" disabled={command.busy}>
              Save defaults
            </Button>
          </form>
        </>
      )}
      <h4>Group or topic override</h4>
      <form
        key={destination + ':' + (override?.revision ?? 0)}
        className="owner-form"
        onSubmit={async event => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          if (
            await command.run('/memory-access/settings', {
              destination,
              ...values(form, 'override_'),
              expected_revision: override?.revision ?? 1,
            })
          )
            onChanged('Destination settings saved.');
        }}
      >
        {fixedDestination === undefined ? (
          <label>
            Exact destination
            <input
              value={destination}
              onChange={event => setDestination(event.target.value)}
              placeholder="-10042 or -10042/topic/7"
              required
            />
          </label>
        ) : (
          <small>Exact destination: {destination}</small>
        )}
        {fields('override_', override ?? {})}
        <Button type="submit" disabled={command.busy || !destination.trim()}>
          Save destination override
        </Button>
      </form>
      {command.error && <Alert>{command.error}</Alert>}
    </section>
  );
}

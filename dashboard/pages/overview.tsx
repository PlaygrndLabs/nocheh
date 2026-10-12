import {Archive, FileText, Activity, Clock3, ArrowUpRight, CheckCircle2, Inbox, TriangleAlert} from 'lucide-react';
import {useResource} from '../lib/resource';
import {StatusBadge} from '../components/status';
import {memoryAvailability, type DecisionPage} from '../lib/supervision';
import {Alert, Skeleton} from '../components/ui/primitives';
type Count = {state: string; count: number};
type Status = {archive?: {events: number; artifacts: Count[]}; guard_mode?: string};
type Monitor = {
  application?: {ok: boolean};
  runtime?: {status?: {telegram: string}};
  telegram_enabled: boolean;
  workflows?: {unavailable?: boolean; counts: Count[]; workers: {connected: boolean}[]};
  services?: {service: string; state: string}[];
};
export function Status() {
  const archive = useResource<Status>('/status', 10000),
    monitor = useResource<Monitor>('/monitoring', 10000),
    data = archive.data,
    health = monitor.data;
  const decisions = useResource<DecisionPage>('/decisions?limit=1', 10000),
    memory = useResource<any>('/memory/honcho', 10000),
    availability = memoryAvailability(memory.data, !!memory.error);
  const rows = health?.workflows?.unavailable ? null : health?.workflows?.counts;
  const count = (states: string[]) =>
    rows ? rows.filter(r => states.includes(r.state)).reduce((n, r) => n + r.count, 0) : null;
  const failed = count(['failed', 'retryable_failed']),
    uncertain = count(['ambiguous']),
    unhealthy = health?.services?.filter(s => s.state === 'unhealthy') || [],
    stale = health?.workflows?.workers?.filter(w => !w.connected).length || 0;
  const pending = decisions.error ? null : (decisions.data?.total ?? null);
  const problems = [
    failed ? `${failed} failed workflows` : null,
    uncertain ? `${uncertain} uncertain effects` : null,
    unhealthy.length ? `${unhealthy.length} unhealthy services` : null,
    stale ? `${stale} stale worker observations` : null,
  ].filter(Boolean);
  const metrics = [
    {
      title: 'Messages saved',
      value: data?.archive?.events,
      Icon: Archive,
      note: 'Original messages in your archive',
      link: 'archive',
    },
    {
      title: 'Files saved',
      value: data?.archive?.artifacts?.filter(r => r.state === 'ready').reduce((n, r) => n + r.count, 0),
      Icon: FileText,
      note: 'Original files available',
      link: 'archive',
    },
    {
      title: 'Work running',
      value: count(['running']),
      Icon: Activity,
      note: 'Replies, memory updates and other workflows',
      link: 'system?view=health',
    },
    {
      title: 'Work waiting',
      value: count(['queued', 'waiting']),
      Icon: Clock3,
      note: 'Queued or waiting for something else to finish',
      link: 'system?view=health',
    },
  ];
  return (
    <div>
      <section className="n-panel home-needs" aria-labelledby="home-needs-title">
        <h2 id="home-needs-title">What needs you</h2>
        <ul className="home-needs-list">
          <li>
            <Inbox size={18} aria-hidden="true" />
            <span>
              {pending == null
                ? decisions.loading
                  ? 'Checking for decisions…'
                  : 'Decisions could not be checked.'
                : pending === 0
                  ? 'No decisions are waiting.'
                  : pending === 1
                    ? '1 decision is waiting for you.'
                    : `${pending.toLocaleString()} decisions are waiting for you.`}
            </span>
            <a href="#inbox">
              Open inbox <ArrowUpRight size={15} aria-hidden="true" />
            </a>
          </li>
          <li className={problems.length ? 'home-needs-problem' : ''}>
            {problems.length ? (
              <TriangleAlert size={18} aria-hidden="true" />
            ) : (
              <CheckCircle2 size={18} aria-hidden="true" />
            )}
            <span>
              {problems.length
                ? problems.join(' · ')
                : monitor.error || !health
                  ? 'System health could not be checked.'
                  : 'No problems found.'}
            </span>
            <a href="#system?view=health">
              Check system <ArrowUpRight size={15} aria-hidden="true" />
            </a>
          </li>
        </ul>
      </section>
      <div className="health-strip" aria-label="Current system status">
        <StatusBadge
          state={
            monitor.error
              ? 'stale'
              : health?.application?.ok
                ? 'ready'
                : health?.application?.ok === false
                  ? 'failed'
                  : 'unknown'
          }
          label={
            monitor.error
              ? 'Observations stale'
              : health?.application?.ok
                ? 'API ready'
                : health?.application?.ok === false
                  ? 'API unavailable'
                  : 'API unobserved'
          }
        />
        <StatusBadge
          state={health?.runtime?.status?.telegram}
          label={'Telegram · ' + (health?.runtime?.status?.telegram || 'unknown')}
        />
        <StatusBadge state={data?.guard_mode} label={'Secret guarding · ' + (data?.guard_mode || 'unknown')} />
      </div>
      <section className="n-panel memory-availability" aria-label="Memory availability">
        <div className="list-heading">
          <div>
            <h2>Long-term memory</h2>
            <p className="n-muted">Whether Honcho is connected, up to date, and ready to recall.</p>
          </div>
          <a href="#memory?view=honcho">Open long-term memory →</a>
        </div>
        <div className="health-strip">
          <StatusBadge
            state={
              memory.error || !memory.data ? 'unknown' : memory.data?.connection?.attached ? 'connected' : 'disabled'
            }
            label={
              memory.error || !memory.data
                ? 'Connection unobserved'
                : memory.data?.connection?.attached
                  ? 'Attached'
                  : 'Detached'
            }
          />
          <StatusBadge state={availability.state} label={availability.label} />
          <StatusBadge
            state={memory.error || !memory.data ? 'unknown' : memory.data?.syncing ? 'syncing' : 'unknown'}
            label={
              memory.error || !memory.data
                ? 'Updates unobserved'
                : memory.data?.syncing
                  ? 'Learning new messages'
                  : 'No update running'
            }
          />
        </div>
        {memory.error && (
          <Alert>
            Memory availability could not be refreshed. Previously observed readiness is not current evidence.
          </Alert>
        )}
      </section>
      {(archive.error || monitor.error || decisions.error) && (
        <Alert>Some observations are unavailable. Previously loaded values may be stale.</Alert>
      )}
      <div className="overview-metrics">
        {metrics.map(({title, value, Icon, note, link}) => (
          <a className="n-panel metric-card" href={'#' + link} key={title}>
            <div>
              <span>{title}</span>
              <Icon size={17} />
            </div>
            <strong>
              {value == null ? archive.loading || monitor.loading ? <Skeleton /> : '—' : value.toLocaleString()}
            </strong>
            <small>{note}</small>
          </a>
        ))}
      </div>
      <div className="n-shortcuts">
        {[
          ['archive?view=imports', 'Import a chat', 'Bring your Telegram history into the archive.'],
          ['archive', 'Find a message', 'Search originals and the copies agents use.'],
          [
            'access',
            'Choose who can talk to Nocheh',
            'Turn Nocheh on in a group, pick people, and decide what chats share.',
          ],
        ].map(([id, title, note]) => (
          <a href={'#' + id} key={id} className="n-shortcut">
            <h2>
              {title}
              <ArrowUpRight size={17} />
            </h2>
            <p>{note}</p>
          </a>
        ))}
      </div>
      <details className="n-panel dashboard-help">
        <summary>How your archive, memory, and assistant fit together</summary>
        <div className="n-explain-grid">
          <div>
            <h3>Original messages</h3>
            <p>
              Messages, files and revisions are kept in your archive and never edited. Agents use a separate copy that
              you can edit.
            </p>
            <a href="#archive">Open the archive →</a>
          </div>
          <div>
            <h3>Working notes</h3>
            <p>
              Hermes keeps short generated notes and conversation history for each chat. Check important claims against
              the original messages.
            </p>
            <a href="#memory?view=working">Read working notes →</a>
          </div>
          <div>
            <h3>Long-term memory</h3>
            <p>
              Honcho learns from the messages you allow, and keeps each chat's memory to the people allowed to see it.
            </p>
            <a href="#memory?view=honcho">Open long-term memory →</a>
          </div>
        </div>
      </details>
    </div>
  );
}

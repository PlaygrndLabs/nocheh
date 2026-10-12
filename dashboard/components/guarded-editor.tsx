import {useState} from 'react';
import {useResource, refreshResources} from '../lib/resource';
import {StatusBadge} from './status';

type Call = (path: string, body?: unknown) => Promise<any>;
type Notify = (message: string, error?: boolean) => void;
type History = {revisions: {revision: number; author: string; created_at: string}[]; next: string | number | null};

// Update repeated copies of the main text in the projection, never the original.
export function replaceRepeated(value: any, previous: string | null, next: string): any {
  if (typeof value === 'string') return previous !== null && value === previous ? next : value;
  if (Array.isArray(value)) return value.map(v => replaceRepeated(v, previous, next));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceRepeated(v, previous, next)]));
  return value;
}

function Projection({
  source: latest,
  original,
  eventId,
  call,
  refresh,
  notify,
}: {
  source: any;
  original: any;
  eventId: string;
  call: Call;
  refresh: () => Promise<void>;
  notify: Notify;
}) {
  const [source] = useState(latest);
  const initial = source.content ?? original;
  const [text, setText] = useState(initial?.text ?? ''),
    [metadata, setMetadata] = useState(
      JSON.stringify(Object.fromEntries(Object.entries(initial ?? {}).filter(([key]) => key !== 'text')), null, 2),
    );
  const [busy, setBusy] = useState(false),
    [history, setHistory] = useState<History | null>(null),
    [preview, setPreview] = useState<any>(null),
    [problem, setProblem] = useState('');
  const hasText = initial && 'text' in initial;
  async function save(restore?: number) {
    setBusy(true);
    setProblem('');
    try {
      const content = restore
        ? undefined
        : replaceRepeated({...JSON.parse(metadata), ...(hasText ? {text} : {})}, initial?.text ?? null, text);
      await call('/data/' + eventId + '/guarded', {
        source_id: source.id,
        expected_revision: source.active_revision,
        ...(restore ? {restore_revision: restore} : {content}),
      });
      notify('Agent copy saved. Your original is unchanged.');
      await refresh();
    } catch (error: any) {
      setProblem(
        error.message === 'guard_revision_conflict'
          ? 'This copy changed elsewhere. Refresh and compare before saving again.'
          : error instanceof SyntaxError
            ? 'Check the other fields: they must be valid JSON.'
            : error.message,
      );
    } finally {
      setBusy(false);
    }
  }
  async function versions(before?: string | number | null) {
    try {
      const result = await call(
        '/data/' +
          eventId +
          '/guarded/history?source_id=' +
          encodeURIComponent(source.id) +
          (before ? '&before=' + before : ''),
      );
      setHistory(previous => ({
        revisions: [...(before ? (previous?.revisions ?? []) : []), ...result.revisions],
        next: result.next,
      }));
    } catch (error: any) {
      setProblem(error.message);
    }
  }
  async function view(revision: number) {
    try {
      setPreview(
        await call(
          '/data/' + eventId + '/guarded/history?source_id=' + encodeURIComponent(source.id) + '&revision=' + revision,
        ),
      );
    } catch (error: any) {
      setProblem(error.message);
    }
  }
  return (
    <article className="n-projection">
      <div className="n-projection-heading">
        <div>
          <p className="archive-kicker">
            {source.kind === 'events'
              ? 'Message wording'
              : source.kind === 'artifacts'
                ? 'File information'
                : 'Generated text'}
          </p>
          <h3>
            {source.kind === 'events'
              ? 'Agent copy'
              : source.kind === 'artifacts'
                ? 'Agent file copy'
                : original?.kind?.replaceAll('_', ' ') || 'Generated item'}
          </h3>
        </div>
        <StatusBadge
          state={source.active_revision ? 'ready' : source.state || 'pending'}
          label={
            source.active_revision
              ? 'Revision ' +
                source.active_revision +
                ' · ' +
                (source.author === 'owner' ? 'Owner edited' : 'Automatic')
              : source.state === 'failed'
                ? 'Preparation failed'
                : 'Waiting for preparation'
          }
        />
      </div>
      {latest.active_revision !== source.active_revision && (
        <p role="alert">
          A newer revision is available. Your edits and original revision are retained. Review the latest copy before
          saving.
        </p>
      )}
      {latest.active_revision !== source.active_revision && (
        <button type="button" onClick={refresh} disabled={busy}>
          Discard edits and load latest copy
        </button>
      )}
      {source.error_code && <p role="status">{source.error_code.replaceAll('_', ' ')}</p>}
      <section className="n-guard-editable n-agent-copy-editor">
        {!source.content && <p className="n-muted">No agent copy exists yet. Editing starts from the original.</p>}
        {hasText && (
          <label>
            Wording for agents
            <textarea
              rows={5}
              dir="auto"
              value={text}
              disabled={busy}
              onChange={event => setText(event.target.value)}
            />
          </label>
        )}
        <details>
          <summary>{hasText ? 'Advanced agent-copy fields' : 'Agent-copy file information'}</summary>
          <label>
            Fields (JSON)
            <textarea rows={10} value={metadata} disabled={busy} onChange={event => setMetadata(event.target.value)} />
          </label>
        </details>
        <p className="n-guard-note">Saving changes only the agent copy. The original above remains unchanged.</p>
        <div className="n-actions">
          <button type="button" disabled={busy} onClick={() => save()} className="n-primary">
            {busy ? 'Saving…' : 'Save agent copy'}
          </button>
          <button type="button" onClick={() => versions()} disabled={busy}>
            Revision history
          </button>
        </div>
      </section>
      {problem && <p role="alert">{problem}</p>}
      {history && (
        <div className="n-revision-history">
          <h4>Revision history</h4>
          {history.revisions.map(revision => (
            <div className="n-row" key={revision.revision}>
              <span>
                {'Revision ' +
                  revision.revision +
                  ' · ' +
                  revision.author +
                  ' · ' +
                  new Date(revision.created_at).toLocaleString()}
              </span>
              <button type="button" onClick={() => view(revision.revision)}>
                View revision
              </button>
            </div>
          ))}
          {history.next && (
            <button type="button" onClick={() => versions(history.next)}>
              Older revisions
            </button>
          )}
        </div>
      )}
      {preview && (
        <section>
          <h4>{'Revision ' + preview.revision + ' · read only'}</h4>
          <pre className="n-data">{JSON.stringify(preview.content, null, 2)}</pre>
          <button
            type="button"
            disabled={busy || preview.revision === source.active_revision}
            onClick={() => save(preview.revision)}
          >
            Restore as new revision
          </button>
        </section>
      )}
    </article>
  );
}

export function GuardedEditor({record, call, notify}: {record: any; call: Call; notify: Notify}) {
  const {data, error} = useResource('/data/' + record.id + '/guarded'),
    [reset, setReset] = useState(0);
  const reload = async () => {
    await refreshResources();
    setReset(v => v + 1);
  };
  function original(source: any) {
    if (source.kind === 'events') return {text: record.event.text, payload: record.event.payload};
    if (source.kind === 'artifacts') {
      const a = record.artifacts.find((a: any) => a.id === source.source_id);
      return {kind: a?.kind, metadata: a?.metadata};
    }
    const d = record.derived.find((d: any) => d.id === source.source_id);
    return {
      text: d ? new TextDecoder().decode(Uint8Array.from(atob(d.content_base64), c => c.charCodeAt(0))) : '',
      kind: d?.kind,
      provenance: d?.provenance,
    };
  }
  return (
    <section className="n-panel n-agent-copy">
      <p className="archive-kicker">Agent copy</p>
      <h2>What agents can use</h2>
      <p className="n-muted">
        Edit this only when agents should use different wording. Saving never changes the original message above.
      </p>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">Loading guarded versions…</p>}
      {(data?.projections ?? []).map((source: any) => (
        <Projection
          key={source.id + ':' + reset}
          source={source}
          original={original(source)}
          eventId={record.id}
          call={call}
          notify={notify}
          refresh={reload}
        />
      ))}
    </section>
  );
}

/**
 * The copy of a message (or file details, or a transcript) that the assistant
 * reads. The original never changes; the owner edits this copy, with a
 * revision check so an edit made elsewhere is never overwritten.
 */
import {useState} from 'react';
import {History, Pencil, RotateCcw} from 'lucide-react';
import {apiGet} from '../../lib/api';
import {useResource, refreshResources} from '../../lib/resource';
import {fullTime, problemText, replaceRepeated} from '../../lib/messages-format';
import {Badge, Button, Details, Field, LoadError, Notice, Skeleton, Spinner, Textarea} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {useCommand} from './use-command';

type Guard = {
  id?: string;
  state?: string;
  input?: Record<string, any> | null;
  content?: Record<string, any> | null;
  active_revision: number | null;
  author?: string | null;
  error_code?: string | null;
};
type Revision = {revision: number; author: string; created_at: string};

const authorLabel = (author?: string | null) => (author === 'owner' ? 'Edited by you' : 'Automatic');
const otherFields = (value: Record<string, any>) =>
  JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'text')), null, 2);
/** The words the assistant reads; a copy without a text field (file details) shows its fields. */
const shown = (value: Record<string, any> | null | undefined) =>
  value && 'text' in value ? (value.text ?? '') : JSON.stringify(value ?? {}, null, 2);
const NO_TEXT = 'No text. The assistant reads only this message’s files and details.';

export function GuardEditor({
  kind,
  id,
  emptyText = 'Not prepared yet. Nocheh prepares a copy for the assistant shortly after a message arrives.',
  onPrepare,
  preparing,
}: {
  kind: 'events' | 'artifacts' | 'derived_artifacts';
  id: string;
  emptyText?: string;
  onPrepare?: () => void;
  preparing?: boolean;
}) {
  const path = `/guards/${kind}/${id}`;
  const guard = useResource<Guard>(path, 15000);
  const feedback = useFeedback();
  const command = useCommand();
  const [draft, setDraft] = useState<{base: Guard; text: string; fields: string; fieldsError: string} | null>(null);

  if (!guard.data && guard.error)
    return <LoadError what="the assistant’s copy" onRetry={() => void refreshResources()} />;
  if (!guard.data) return <Skeleton className="h-20 w-full" />;
  const latest = guard.data;
  if (!latest.input)
    return (
      <Notice
        tone={latest.state === 'failed' ? 'warn' : 'info'}
        title={latest.state === 'failed' ? 'Preparing the copy failed' : 'No copy yet'}
        action={
          onPrepare && (
            <Button size="sm" busy={preparing} onClick={onPrepare}>
              {latest.state === 'failed' ? 'Try again' : 'Prepare now'}
            </Button>
          )
        }
      >
        {latest.state === 'failed' ? 'The assistant can’t use this yet. The original is safe.' : emptyText}
      </Notice>
    );

  const current = latest.content ?? latest.input;
  const hasText = typeof current.text === 'string' || current.text === null;
  const differs = !!latest.content && JSON.stringify(latest.content.text) !== JSON.stringify(latest.input.text);

  const startEdit = () =>
    setDraft({base: latest, text: current.text ?? '', fields: otherFields(current), fieldsError: ''});

  async function save() {
    if (!draft) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(draft.fields);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    } catch {
      setDraft({...draft, fieldsError: 'Other fields must be a JSON object. Your text is kept.'});
      return;
    }
    const initial = draft.base.content ?? draft.base.input ?? {};
    const content = replaceRepeated(
      // A message that had no text keeps having none unless the owner types some.
      {...parsed, ...(hasText ? {text: initial.text === null && !draft.text ? null : draft.text} : {})},
      typeof initial.text === 'string' ? initial.text : null,
      draft.text,
    );
    const result = await command.run('save', path, {expected_revision: draft.base.active_revision, content});
    if (result) {
      setDraft(null);
      feedback.toast('Saved. The original message is unchanged.');
    }
  }

  async function restore(revision: number) {
    const ok = await feedback.confirm({
      title: `Use version ${revision} again?`,
      body: 'It becomes the newest version of the assistant’s copy. Nothing is deleted.',
      confirm: 'Use this version',
    });
    if (!ok) return;
    const result = await command.run('restore', path, {
      expected_revision: latest.active_revision,
      restore_revision: revision,
    });
    if (result) {
      setDraft(null);
      feedback.toast(`Version ${revision} is in use again.`);
    }
  }

  const stale = draft && draft.base.active_revision !== latest.active_revision;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={latest.author === 'owner' ? 'accent' : 'neutral'}>{authorLabel(latest.author)}</Badge>
        {latest.active_revision && <span className="text-xs text-muted">Version {latest.active_revision}</span>}
        {differs && <span className="text-xs text-muted">· differs from the original</span>}
        {!draft && (
          <Button size="sm" className="ml-auto" onClick={startEdit}>
            <Pencil aria-hidden /> Edit
          </Button>
        )}
      </div>

      {!draft && (
        <pre
          dir="auto"
          className="max-h-72 overflow-auto rounded-lg border border-line bg-surface px-3 py-2.5 font-sans text-sm whitespace-pre-wrap break-words"
        >
          {shown(current) || <span className="text-muted italic">{NO_TEXT}</span>}
        </pre>
      )}

      {draft && (
        <div className="space-y-3 rounded-lg border border-accent/40 bg-accent-soft/30 p-3">
          {stale && (
            <Notice
              tone="warn"
              title="This changed somewhere else"
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    command.setError('');
                    setDraft({...draft, base: latest});
                  }}
                >
                  Load latest, keep my text
                </Button>
              }
            >
              Reload to see the latest, your text is kept.
              <span dir="auto" className="mt-1 line-clamp-3 block text-muted">
                Latest: {shown(current) || NO_TEXT}
              </span>
            </Notice>
          )}
          {hasText && (
            <Field label="Text the assistant reads" htmlFor={`guard-${kind}-${id}`}>
              <Textarea
                id={`guard-${kind}-${id}`}
                dir="auto"
                rows={6}
                value={draft.text}
                disabled={!!command.busy}
                onChange={event => setDraft({...draft, text: event.target.value})}
              />
            </Field>
          )}
          <Details summary={hasText ? 'Other fields (advanced)' : 'Fields'} open={!hasText}>
            <Field label="Fields as JSON" htmlFor={`guard-fields-${kind}-${id}`} error={draft.fieldsError}>
              <Textarea
                id={`guard-fields-${kind}-${id}`}
                rows={8}
                className="font-mono text-xs"
                value={draft.fields}
                disabled={!!command.busy}
                onChange={event => setDraft({...draft, fields: event.target.value, fieldsError: ''})}
              />
            </Field>
          </Details>
          {command.error && !stale && (
            <Notice tone="bad" title="Not saved">
              {command.error}
            </Notice>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" busy={command.busy === 'save'} onClick={() => void save()}>
              Save copy
            </Button>
            <Button variant="ghost" disabled={!!command.busy} onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <span className="text-xs text-muted">Only the assistant’s copy changes.</span>
          </div>
        </div>
      )}

      {!draft && command.error && <Notice tone="bad">{command.error}</Notice>}
      {latest.error_code && (
        <p className="text-xs text-muted">Last preparation problem: {latest.error_code.replaceAll('_', ' ')}</p>
      )}

      <Details summary="Earlier versions">
        <VersionHistory path={path} active={latest.active_revision} busy={!!command.busy} onRestore={restore} />
      </Details>
    </div>
  );
}

function VersionHistory({
  path,
  active,
  busy,
  onRestore,
}: {
  path: string;
  active: number | null;
  busy: boolean;
  onRestore: (revision: number) => void;
}) {
  const [before, setBefore] = useState<number[]>([]);
  const cursor = before.at(-1);
  const history = useResource<{revisions: Revision[]; next: number | null}>(
    path + '/history' + (cursor ? '?before=' + cursor : ''),
  );
  const [open, setOpen] = useState<{revision: number; text: string} | null>(null);
  const [loading, setLoading] = useState<number | null>(null);
  const [problem, setProblem] = useState('');

  async function view(revision: number) {
    if (open?.revision === revision) return setOpen(null);
    setLoading(revision);
    setProblem('');
    try {
      const data = await apiGet<{content: Record<string, any>}>(`${path}/revisions/${revision}`);
      setOpen({revision, text: shown(data.content) || NO_TEXT});
    } catch (error) {
      setProblem(problemText(error));
    } finally {
      setLoading(null);
    }
  }

  if (!history.data && history.error)
    return <LoadError what="earlier versions" onRetry={() => void refreshResources()} />;
  if (!history.data) return <Skeleton className="h-10 w-full" />;
  if (!history.data.revisions.length) return <p className="text-[13px] text-muted">No saved versions yet.</p>;
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-line rounded-lg border border-line">
        {history.data.revisions.map(item => (
          <li key={item.revision} className="px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <History className="size-3.5 text-muted" aria-hidden />
              <span className="font-medium">Version {item.revision}</span>
              <span className="text-muted">
                {authorLabel(item.author)} · {fullTime(item.created_at)}
              </span>
              {item.revision === active && <Badge tone="good">In use</Badge>}
              <Button variant="link" size="sm" className="ml-auto" onClick={() => void view(item.revision)}>
                {loading === item.revision ? <Spinner /> : open?.revision === item.revision ? 'Hide' : 'View'}
              </Button>
            </div>
            {open?.revision === item.revision && (
              <div className="mt-2 space-y-2">
                <pre
                  dir="auto"
                  className="max-h-60 overflow-auto rounded-md bg-subtle px-3 py-2 font-sans text-[13px] whitespace-pre-wrap break-words"
                >
                  {open.text}
                </pre>
                {item.revision !== active && (
                  <Button size="sm" disabled={busy} onClick={() => onRestore(item.revision)}>
                    <RotateCcw aria-hidden /> Use this version
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {problem && <p className="text-xs text-bad">{problem}</p>}
      {(before.length > 0 || history.data.next) && (
        <div className="flex gap-2">
          {before.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setBefore(before.slice(0, -1))}>
              Newer
            </Button>
          )}
          {history.data.next && (
            <Button size="sm" variant="ghost" onClick={() => setBefore([...before, history.data!.next!])}>
              Older
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

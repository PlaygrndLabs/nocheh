import {useEffect, useRef, useState} from 'react';
import {
  base,
  call,
  button,
  errorText,
  Data,
  download,
  exportJSON,
  useResource,
  refreshResources,
  StatusBadge,
  Badge,
  Alert,
} from '../lib/page-helpers';
import {GuardedEditor} from '../components/guarded-editor';
import {SourceVersions} from './source-versions';
import {sourceContentLabel, sourceContentTypes} from '../../src/source-content';

type Notify = (message: string, error?: boolean) => void;
type MediaKind = 'audio' | 'video' | 'image';

function MediaPreview({file}: {file: any}) {
  const [url, setUrl] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [problem, setProblem] = useState('');
  const pending = useRef<AbortController | null>(null),
    player = useRef<HTMLAudioElement>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  const kind: string = file.kind,
    media: MediaKind | null =
      kind === 'voice' || kind === 'audio'
        ? 'audio'
        : kind === 'video' || kind === 'video_note'
          ? 'video'
          : kind === 'photo' || kind === 'image'
            ? 'image'
            : null;
  useEffect(() => {
    if (media !== 'audio' || !url || !player.current) return;
    player.current
      .play()
      .catch(error =>
        setProblem(
          error?.name === 'NotAllowedError'
            ? 'Use the audio controls to start playback.'
            : 'Audio preview could not play. Download the original file instead.',
        ),
      );
  }, [media, url]);
  if (!media || file.state !== 'ready') return null;
  const fallback = (
    {
      voice: 'audio/ogg',
      audio: 'audio/mpeg',
      video: 'video/mp4',
      video_note: 'video/mp4',
      photo: 'image/jpeg',
      image: 'image/jpeg',
    } as Record<string, string>
  )[kind];
  const supplied = file.metadata?.mime_type;
  const safeTypes: Record<MediaKind, string[]> = {
    audio: ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm'],
    video: ['video/mp4', 'video/webm', 'video/ogg'],
    image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  };
  const mime = safeTypes[media].includes(supplied) ? supplied : fallback;
  async function load() {
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setProblem('');
    try {
      const response = await fetch(base + '/artifacts/' + file.id + '/download', {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw Error('preview_unavailable');
      const bytes = await response.arrayBuffer();
      if (!controller.signal.aborted) setUrl(URL.createObjectURL(new Blob([bytes], {type: mime})));
    } catch {
      if (!controller.signal.aborted) setProblem('Preview unavailable. Download the original file instead.');
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setLoading(false);
      }
    }
  }
  return (
    <div className="source-media-preview">
      {!url && (
        <button type="button" onClick={load} disabled={loading}>
          {loading
            ? 'Loading preview…'
            : media === 'image'
              ? 'View image'
              : 'Play ' + sourceContentLabel(kind).toLowerCase()}
        </button>
      )}
      {url && media === 'audio' && (
        <audio ref={player} controls preload="auto" src={url} aria-label={sourceContentLabel(kind)} />
      )}
      {url && media === 'video' && <video controls preload="none" src={url} aria-label={sourceContentLabel(kind)} />}
      {url && media === 'image' && <img src={url} alt={'Original ' + sourceContentLabel(kind).toLowerCase()} />}
      {problem && <p role="status">{problem}</p>}
    </div>
  );
}

/** Decodes a base64 generated item into text. */
const decode = (value: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(value), character => character.charCodeAt(0)));

export function Source({record, notify}: {record: any; notify: Notify}) {
  const files: any[] = record.artifacts || [],
    generated: any[] = record.derived || [];
  const transcripts = generated.filter(item => item.kind === 'transcript'),
    otherGenerated = generated.filter(item => item.kind !== 'transcript');
  const originalText: string | undefined = record.event?.text,
    types = sourceContentTypes(
      record.event?.kind,
      record.event?.payload,
      files.map(file => file.kind),
    );
  const hasSpeech = types.some(type => type === 'voice' || type === 'audio' || type === 'video_note');
  const payload = record.event?.payload || {},
    message = payload.message || payload.edited_message || payload.channel_post || payload.edited_channel_post || {};
  const structured = message.contact
    ? [message.contact.first_name, message.contact.last_name, message.contact.phone_number].filter(Boolean).join(' · ')
    : message.venue
      ? [message.venue.title, message.venue.address].filter(Boolean).join(' · ')
      : message.location
        ? [message.location.latitude, message.location.longitude].filter(value => value !== undefined).join(', ')
        : message.poll
          ? message.poll.question
          : message.dice
            ? [message.dice.emoji, message.dice.value].join(' · ')
            : message.game?.title || null;
  const original = (
    <section className="n-panel n-original-evidence">
      <div className="source-section-heading">
        <div>
          <p className="archive-kicker">Original message</p>
          <h2>What was received</h2>
        </div>
        <Badge>Permanent · read only</Badge>
      </div>
      <p className="n-muted">This is the source of truth and cannot be edited.</p>
      {types.length > 0 && originalText?.trim() && (
        <div className="source-content-types" aria-label="Message content">
          {types.map(type => (
            <span className="source-content-type" key={type}>
              {sourceContentLabel(type)}
            </span>
          ))}
        </div>
      )}
      {originalText?.trim() ? (
        <div className="n-original-message" dir="auto">
          {originalText}
        </div>
      ) : (
        <div className="n-original-message source-no-text">
          {types.length ? types.map(sourceContentLabel).join(' · ') : 'Message without text'}
          {structured && <small dir="auto">{structured}</small>}
          {files.length > 0 && <small>The original attachment is below.</small>}
        </div>
      )}
      {files.length > 0 && (
        <section className="source-files">
          <h3>{files.length === 1 ? 'Original attachment' : 'Original attachments'}</h3>
          {files.map(file => {
            const name = file.metadata?.relative_path?.split('/').pop() || file.metadata?.file_name;
            const duration = Number(file.metadata?.duration);
            return (
              <div className="source-file" key={file.id}>
                <div className="source-file-main">
                  <strong>{sourceContentLabel(file.kind)}</strong>
                  {name && <span dir="auto">{name}</span>}
                  {Number.isFinite(duration) && duration > 0 && (
                    <small>
                      {Math.floor(duration / 60) + ':' + String(Math.floor(duration % 60)).padStart(2, '0')}
                    </small>
                  )}
                </div>
                <div className="source-file-actions">
                  <StatusBadge state={file.state} />
                  {button(
                    'Download original',
                    () => download('/artifacts/' + file.id + '/download', name || file.id),
                    file.state !== 'ready',
                  )}
                </div>
                <MediaPreview file={file} />
              </div>
            );
          })}
        </section>
      )}
      <details className="source-technical">
        <summary>Advanced details and export</summary>
        <p className="n-muted">Generated items, provenance, source identity, and the complete source export.</p>
        {otherGenerated.length > 0 && (
          <section className="source-generated">
            <h3>{otherGenerated.length + ' generated ' + (otherGenerated.length === 1 ? 'item' : 'items')}</h3>
            {otherGenerated.map(item => (
              <article key={item.id}>
                <Badge>Generated</Badge>
                <h3>
                  {item.kind === 'browser_result' ? 'Assistant result' : 'Generated ' + item.kind.replaceAll('_', ' ')}
                </h3>
                <Data value={decode(item.content_base64)} />
                <details>
                  <summary>Generation provenance</summary>
                  <Data value={item.provenance} />
                </details>
              </article>
            ))}
          </section>
        )}
        <details>
          <summary>Source identity and technical metadata</summary>
          <Data value={record} />
        </details>
        <div className="source-utility-actions">
          {button('Download source JSON', () =>
            exportJSON(
              {id: record.id, reference: record.reference, event: record.event, artifacts: files},
              'nocheh-source-' + record.id + '.json',
            ),
          )}
        </div>
      </details>
    </section>
  );
  return (
    <div className="source-stack">
      {original}
      {record.derivative_versions &&
        record.event?.channel === 'telegram' &&
        !!(payload.message || payload.edited_message || payload.channel_post || payload.edited_channel_post) && (
          <SourceRetirement key={record.id} eventId={record.id} notify={notify} />
        )}
      {(hasSpeech || transcripts.length > 0) && (
        <section className="n-panel source-transcript">
          <div className="source-section-heading">
            <div>
              <p className="archive-kicker">Generated from audio</p>
              <h2>Transcript</h2>
            </div>
            <Badge>{transcripts.length ? 'Active version' : 'Unavailable'}</Badge>
          </div>
          {transcripts.length ? (
            transcripts.map(item => (
              <div key={item.id}>
                {transcripts.length > 1 && (
                  <h3>{files.find(file => file.id === item.artifact_id)?.metadata?.file_name || 'Audio attachment'}</h3>
                )}
                <p className="source-transcript-text" dir="auto">
                  {decode(item.content_base64) || 'The active transcript is empty.'}
                </p>
                <details className="source-transcript-provenance">
                  <summary>Transcription provenance</summary>
                  <Data value={item.provenance} />
                </details>
              </div>
            ))
          ) : (
            <p className="n-muted source-transcript-empty">No active transcript is available for this message.</p>
          )}
        </section>
      )}
      {!record.derivative_versions && <GuardedEditor key={record.id} record={record} call={call} notify={notify} />}
      {record.derivative_versions && <SourceVersions key={record.id} record={record} />}
    </div>
  );
}

function SourceRetirement({eventId, notify}: {eventId: string; notify: Notify}) {
  const path = '/sources/' + eventId + '/retirement',
    resource = useResource(path);
  const [saved, setSaved] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState(''),
    [chosen, setChosen] = useState<string[]>([]);
  const state = saved && (!resource.data || saved.revision > resource.data.revision) ? saved : resource.data;
  const offered: any[] = (state?.related_replies || []).filter((reply: any) => !reply.retired),
    selected = offered.filter(reply => chosen.includes(reply.event_id));
  // Each selected reply is a separate owner decision with its own revision check.
  async function retireReplies() {
    let done = 0;
    for (const reply of selected) {
      await call('/sources/' + reply.event_id + '/retirement', {
        retired: true,
        expected_revision: reply.revision,
        operation_id: crypto.randomUUID(),
      });
      done++;
    }
    setChosen([]);
    return done;
  }
  async function change() {
    if (!state || busy) return;
    setBusy(true);
    setProblem('');
    try {
      const result = await call(path, {
        retired: !state.retired,
        expected_revision: state.revision,
        operation_id: crypto.randomUUID(),
      });
      setSaved({...state, ...result});
      const replies = result.retired ? await retireReplies() : 0;
      notify(
        result.retired
          ? 'Message retired from future use.' +
              (replies ? ` ${replies} related ${replies === 1 ? 'reply' : 'replies'} also retired.` : '')
          : 'Message restored for future use.',
      );
      void refreshResources();
    } catch (error) {
      setProblem(errorText(error));
      void refreshResources();
    } finally {
      setBusy(false);
    }
  }
  async function retireSelected() {
    if (busy || !selected.length) return;
    setBusy(true);
    setProblem('');
    try {
      const replies = await retireReplies();
      notify(`${replies} related ${replies === 1 ? 'reply' : 'replies'} retired from future use.`);
      void refreshResources();
    } catch (error) {
      setProblem(errorText(error));
      void refreshResources();
    } finally {
      setBusy(false);
    }
  }
  const toggle = (id: string) =>
    setChosen(current => (current.includes(id) ? current.filter(value => value !== id) : [...current, id]));
  if (resource.error?.includes('telegram_message_not_found')) return null;
  return (
    <section className="n-panel source-retirement" aria-label="Nocheh use of this message">
      <p className="archive-kicker">Nocheh use</p>
      <h2>Use of this message</h2>
      <div
        className="source-retirement-state"
        data-retired={state?.retired ? 'true' : 'false'}
        role="status"
        aria-live="polite"
      >
        <strong>{!state ? 'Checking status…' : state.retired ? 'Retired from Nocheh' : 'Available to Nocheh'}</strong>
        <span>
          {!state
            ? 'Loading the saved owner decision.'
            : state.retired
              ? 'Nocheh will not use this message or its edits in future replies or learning.'
              : 'Nocheh may use this message and its edits in future replies or learning.'}
        </span>
      </div>
      <p className="n-muted source-retirement-note">
        The original stays in Archive. Retirement does not delete a Telegram message or recall a reply already sent.
      </p>
      {resource.error && !state && <Alert>Retirement status is unavailable. Refresh and try again.</Alert>}
      {problem && (
        <p className="source-retirement-error" role="alert">
          {'Change was not saved: ' + problem + '. Check the current status and try again.'}
        </p>
      )}
      {offered.length > 0 && (
        <fieldset className="source-retirement-related">
          <legend>Assistant replies that repeat this message</legend>
          <p className="n-muted">
            These delivered replies are separate messages and stay available unless you also retire them. Retirement
            does not recall them from Telegram.
          </p>
          {offered.map(reply => (
            <label key={reply.event_id} className="source-retirement-reply">
              <input
                type="checkbox"
                checked={chosen.includes(reply.event_id)}
                disabled={busy}
                onChange={() => toggle(reply.event_id)}
              />
              <span>
                <strong>{reply.relation === 'reply' ? 'Direct reply' : 'Quotes this message'}</strong>
                <span dir="auto">{reply.text || 'Reply without text'}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {state &&
        button(
          busy
            ? state.retired
              ? 'Restoring…'
              : 'Retiring…'
            : state.retired
              ? 'Undo retirement'
              : selected.length
                ? `Retire this message and ${selected.length} ${selected.length === 1 ? 'reply' : 'replies'}`
                : 'Retire this message',
          change,
          busy,
          state.retired ? '' : 'n-primary',
        )}
      {state?.retired &&
        selected.length > 0 &&
        button(
          busy ? 'Retiring…' : `Retire ${selected.length} selected ${selected.length === 1 ? 'reply' : 'replies'}`,
          retireSelected,
          busy,
          '',
        )}
      {state?.history?.length > 0 && (
        <details>
          <summary>Owner action history</summary>
          <Data value={state.history} />
        </details>
      )}
    </section>
  );
}

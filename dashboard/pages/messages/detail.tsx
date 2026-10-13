/**
 * One message in a side panel: the original first (never changed), its files,
 * then the copy the assistant uses, whether the assistant may use it at all,
 * and advanced details last.
 */
import {useEffect, useRef, useState, type ReactNode} from 'react';
import {Bot, CornerDownRight, Download, FileText, Lock, Play} from 'lucide-react';
import {apiBase, authedFetch, download, exportJSON} from '../../lib/api';
import {useResource, refreshResources} from '../../lib/resource';
import {href} from '../../lib/routes';
import {
  VOICE_ARCHIVED,
  actionStatus,
  contentText,
  decode,
  duration,
  fullTime,
  hasSpeech,
  isAssistant,
  originalTypes,
  reactionText,
  replyStatus,
  senderName,
  structuredSummary,
  telegramMessage,
  when,
  type ReplyPreview,
} from '../../lib/messages-format';
import {sourceContentLabel} from '../../../src/source-content';
import {Badge, Button, Details, LoadError, Notice, Skeleton, Technical} from '../../ui/core';
import {Drawer, useFeedback} from '../../ui/overlay';
import {GuardEditor} from './agent-copy';
import {HideControl} from './hide';
import {seenRows} from './list';
import {useChatNames} from './chat-names';
import {useCommand} from './use-command';
import {GeneratedVersions, Reprocess} from './versions';

function Section({title, aside, children}: {title: ReactNode; aside?: ReactNode; children: ReactNode}) {
  return (
    <section className="border-t border-line pt-4 first:border-t-0 first:pt-0">
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function MessageDrawer({
  id,
  onClose,
  onOpen,
}: {
  id: string | null;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const record = useResource<any>(id ? '/events/' + id : null, 15000);
  const chatName = useChatNames();
  const data = record.data?.id === id ? record.data : null;
  const kind: string | undefined = data?.event?.kind;
  const row = id ? seenRows.get(id) : undefined;
  const title = !data
    ? 'Message'
    : (isAssistant(kind) ? 'Assistant reply' : row?.reaction_preview ? 'Reaction' : 'Message') +
      ' in ' +
      chatName(data.event?.scope ?? row?.scope ?? '');
  return (
    <Drawer
      open={!!id}
      onOpenChange={open => !open && onClose()}
      title={title}
      description={data ? fullTime(data.event?.occurred_at || data.received_at) : undefined}
    >
      {!data && record.error && <LoadError what="this message" onRetry={() => void refreshResources()} />}
      {!data && !record.error && (
        <div className="space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}
      {data && id && <MessageDetail key={id} id={id} record={data} onOpen={onOpen} />}
    </Drawer>
  );
}

function MessageDetail({id, record, onOpen}: {id: string; record: any; onOpen: (id: string) => void}) {
  const feedback = useFeedback();
  const prepare = useCommand();
  const row = seenRows.get(id);
  const event = record.event ?? {};
  const files: any[] = record.artifacts ?? [];
  const derived: any[] = record.derived ?? [];
  const transcripts = derived.filter(item => item.kind === 'transcript');
  const archivedVoice = derived.some(
    item => item.kind === 'extraction_status' && decode(item.content_base64) === VOICE_ARCHIVED,
  );
  const otherGenerated = derived.filter(
    item =>
      item.kind !== 'transcript' &&
      !(item.kind === 'extraction_status' && decode(item.content_base64) === VOICE_ARCHIVED),
  );
  const types = originalTypes(record);
  const text: string | null = typeof event.text === 'string' && event.text.trim() ? event.text : null;
  const sender = senderName(event.payload, event.kind);
  const structured = structuredSummary(event.payload);
  const status = row ? replyStatus(row) : null;
  const action = row?.action_review;
  const replies: ReplyPreview[] = record.reply_messages ?? row?.reply_messages ?? [];
  const telegram = event.channel === 'telegram' && !!telegramMessage(event.payload);

  async function prepareNow() {
    const result = await prepare.run('prepare', `/sources/${id}/prepare`, {}, {operation: false});
    if (result) feedback.toast('Preparing the assistant’s copy. This takes a moment.');
  }

  return (
    <div className="space-y-5">
      {(status || action) && (
        <div className="flex flex-wrap items-center gap-2">
          {status && (
            <Badge tone={status.tone} dot>
              {status.label}
            </Badge>
          )}
          {status?.note && <span className="text-xs text-muted">{status.note}</span>}
          {action && (
            <a
              href={href('inbox', {action: action.id})}
              className="rounded-full focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Badge tone={actionStatus(action).tone} className="underline-offset-2 hover:underline">
                {actionStatus(action).label}
                {action.count > 1 ? ` (${action.count})` : ''} ›
              </Badge>
            </a>
          )}
        </div>
      )}

      <Section
        title="Original"
        aside={
          <Badge>
            <Lock className="size-3" aria-hidden /> Never changed
          </Badge>
        }
      >
        <div className="rounded-lg border border-line bg-subtle/50 px-3.5 py-3">
          {sender && <p className="mb-1 text-xs font-medium text-muted">{sender}</p>}
          {text ? (
            <p dir="auto" className="text-sm whitespace-pre-wrap break-words">
              {text}
            </p>
          ) : (
            <p className="text-sm text-muted italic">
              {row?.reaction_preview ? reactionText(row) : types.length ? contentText(types) : 'Message without text'}
            </p>
          )}
          {structured && (
            <p dir="auto" className="mt-1 text-[13px]">
              {structured}
            </p>
          )}
          {text && types.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {types.map(type => (
                <Badge key={type}>{sourceContentLabel(type)}</Badge>
              ))}
            </div>
          )}
        </div>
        {files.length > 0 && (
          <ul className="mt-3 space-y-2">
            {files.map(file => (
              <FileRow key={file.id} file={file} />
            ))}
          </ul>
        )}
      </Section>

      {replies.length > 0 && (
        <Section title="Assistant replied">
          <ul className="space-y-2">
            {replies.map(reply => (
              <li key={reply.id}>
                <button
                  type="button"
                  onClick={() => onOpen(reply.id)}
                  className="flex w-full items-start gap-2 rounded-lg border border-line px-3 py-2 text-left hover:bg-subtle"
                >
                  <CornerDownRight className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-xs text-muted">
                      <Bot className="size-3.5" aria-hidden /> {when(reply.received_at)}
                    </span>
                    <span dir="auto" className="line-clamp-3 block text-sm">
                      {reply.text?.trim() || contentText(reply.content_types) || 'Assistant message'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(hasSpeech(types) || transcripts.length > 0) && (
        <Section title="Transcript" aside={<Badge tone="info">Generated</Badge>}>
          {transcripts.length ? (
            transcripts.map(item => (
              <div key={item.id} className="space-y-1">
                {transcripts.length > 1 && (
                  <p className="text-xs font-medium text-muted">
                    {files.find(file => file.id === item.artifact_id)?.metadata?.file_name || 'Audio'}
                  </p>
                )}
                <p dir="auto" className="text-sm whitespace-pre-wrap break-words">
                  {decode(item.content_base64) || <span className="text-muted italic">The transcript is empty.</span>}
                </p>
              </div>
            ))
          ) : (
            <p className="text-[13px] text-muted">
              {archivedVoice
                ? 'Archived without transcription. The original audio is kept above.'
                : 'No transcript yet.'}
            </p>
          )}
        </Section>
      )}

      <Section title="Copy the assistant uses">
        <p className="mb-3 text-[13px] text-muted">
          Edit this when the assistant should read different wording. The original above never changes.
        </p>
        <GuardEditor kind="events" id={id} onPrepare={() => void prepareNow()} preparing={prepare.busy === 'prepare'} />
        {prepare.error && (
          <Notice tone="bad" className="mt-3">
            {prepare.error}
          </Notice>
        )}
      </Section>

      {telegram && (
        <Section title="Hide from the assistant">
          <HideControl id={id} />
        </Section>
      )}

      <section className="border-t border-line pt-4">
        <Details summary="More details">
          <div className="space-y-5">
            <div>
              <h4 className="mb-2 text-[13px] font-semibold">Generated versions</h4>
              <GeneratedVersions id={id} />
            </div>
            {files.length > 0 && (
              <div>
                <h4 className="mb-2 text-[13px] font-semibold">Make a new reading of a file</h4>
                <Reprocess id={id} files={files} />
              </div>
            )}
            {files
              .filter(file => file.state === 'ready')
              .map(file => (
                <div key={file.id}>
                  <h4 className="mb-2 text-[13px] font-semibold">
                    File details the assistant sees · {file.metadata?.file_name || sourceContentLabel(file.kind)}
                  </h4>
                  <GuardEditor kind="artifacts" id={file.id} emptyText="These file details are still being prepared." />
                </div>
              ))}
            {otherGenerated.map(item => (
              <div key={item.id}>
                <h4 className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
                  {item.kind.replaceAll('_', ' ').replace(/^./, (letter: string) => letter.toUpperCase())}
                  <Badge tone="info">Generated</Badge>
                </h4>
                <pre
                  dir="auto"
                  className="max-h-48 overflow-auto rounded-md bg-subtle px-3 py-2 font-sans text-[13px] whitespace-pre-wrap break-words"
                >
                  {decode(item.content_base64)}
                </pre>
                <Technical summary="How it was made" value={item.provenance} />
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() =>
                  exportJSON(
                    {id: record.id, source: record.source, reference: record.reference, event, artifacts: files},
                    'nocheh-message-' + id.slice(0, 12) + '.json',
                  )
                }
              >
                <Download aria-hidden /> Download original as JSON
              </Button>
              <Button size="sm" variant="ghost" busy={prepare.busy === 'prepare'} onClick={() => void prepareNow()}>
                Prepare the assistant’s copy again
              </Button>
            </div>
            <Technical summary="Full stored record" value={record} />
          </div>
        </Details>
      </section>
    </div>
  );
}

type Media = 'audio' | 'video' | 'image';
const mediaKind = (kind: string): Media | null =>
  ['voice', 'audio'].includes(kind)
    ? 'audio'
    : ['video', 'video_note', 'animation'].includes(kind)
      ? 'video'
      : ['photo', 'image', 'sticker'].includes(kind)
        ? 'image'
        : null;
const safeTypes: Record<Media, string[]> = {
  audio: ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm'],
  video: ['video/mp4', 'video/webm', 'video/ogg'],
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
};
const fallbackType: Record<string, string> = {
  voice: 'audio/ogg',
  audio: 'audio/mpeg',
  video: 'video/mp4',
  video_note: 'video/mp4',
  animation: 'video/mp4',
  photo: 'image/jpeg',
  image: 'image/jpeg',
  sticker: 'image/webp',
};

function FileRow({file}: {file: any}) {
  const name: string | undefined = file.metadata?.relative_path?.split('/').pop() || file.metadata?.file_name;
  const length = duration(file.metadata?.duration);
  const ready = file.state === 'ready';
  const media = mediaKind(file.kind);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  async function preview() {
    if (!media) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setProblem('');
    try {
      const response = await authedFetch(`${apiBase}/artifacts/${file.id}/download`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('preview_unavailable');
      const supplied = file.metadata?.mime_type;
      const type = safeTypes[media].includes(supplied) ? supplied : fallbackType[file.kind];
      const bytes = await response.arrayBuffer();
      if (!controller.signal.aborted) setUrl(URL.createObjectURL(new Blob([bytes], {type})));
    } catch {
      if (!controller.signal.aborted) setProblem('Preview isn’t available. Download the file instead.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return (
    <li className="rounded-lg border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <FileText className="size-4 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1 text-[13px]">
          <span className="font-medium">{sourceContentLabel(file.kind)}</span>
          {name && (
            <span dir="auto" className="ml-1.5 break-all text-muted">
              {name}
            </span>
          )}
          {length && <span className="ml-1.5 text-muted">{length}</span>}
        </span>
        {!ready && <Badge tone="info">Downloading from Telegram</Badge>}
        {ready && media && !url && (
          <Button size="sm" variant="ghost" busy={loading} onClick={() => void preview()}>
            <Play aria-hidden /> {media === 'image' ? 'View' : 'Play'}
          </Button>
        )}
        <Button
          size="sm"
          disabled={!ready}
          onClick={() => download(`/artifacts/${file.id}/download`, name || file.kind + '-' + file.id.slice(0, 8))}
        >
          <Download aria-hidden /> Download
        </Button>
      </div>
      {url && media === 'audio' && (
        <audio className="mt-2 w-full" controls autoPlay src={url} aria-label={sourceContentLabel(file.kind)} />
      )}
      {url && media === 'video' && (
        <video
          className="mt-2 max-h-80 w-full rounded-md"
          controls
          src={url}
          aria-label={sourceContentLabel(file.kind)}
        />
      )}
      {url && media === 'image' && (
        <img
          className="mt-2 max-h-96 rounded-md"
          src={url}
          alt={'Original ' + sourceContentLabel(file.kind).toLowerCase()}
        />
      )}
      {problem && <p className="mt-1 text-xs text-muted">{problem}</p>}
    </li>
  );
}

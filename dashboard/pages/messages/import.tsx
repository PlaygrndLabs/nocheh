/**
 * Messages › Import: bring old Telegram chats in from a Telegram Desktop
 * export. Upload, check what's inside, choose where each chat belongs, then
 * import with progress. Importing never sends old replies.
 */
import {useRef, useState} from 'react';
import {FileArchive, FolderOpen, History, Upload} from 'lucide-react';
import {apiBase, apiPost, authedFetch} from '../../lib/api';
import {useParam} from '../../lib/navigation';
import {useResource, refreshResources} from '../../lib/resource';
import {setParams} from '../../lib/routes';
import {useSettings} from '../../lib/settings';
import {cn} from '../../lib/utils';
import {
  canStart,
  dateSpan,
  fullTime,
  importStatus,
  isResume,
  matchingGroup,
  preparationLabel,
  problemText,
  type ImportJob,
} from '../../lib/messages-format';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Empty,
  LoadError,
  LoadingRows,
  Notice,
  Select,
  Stat,
} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {useChatNames} from './chat-names';

/** Browsers read this non-standard attribute to let the owner pick a whole folder. */
const folderPicker = {webkitdirectory: ''} as Record<string, string>;

function Progress({value, max, label}: {value: number; max: number; label: string}) {
  const percent = max > 0 ? Math.min(100, Math.round((100 * value) / max)) : 0;
  return (
    <div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        className="h-2 overflow-hidden rounded-full bg-subtle"
      >
        <div className="h-full rounded-full bg-accent transition-[width]" style={{width: percent + '%'}} />
      </div>
      <p className="mt-1.5 text-xs text-muted">{label}</p>
    </div>
  );
}

const UPLOAD_PIECE = 16 * 1024 * 1024;

export function ImportView() {
  const jobs = useResource<ImportJob[]>('/jobs', 4000);
  const selectedId = useParam('job');
  const imports = (jobs.data ?? []).filter(job => job.kind === 'import');
  const selected = imports.find(job => job.id === selectedId) ?? null;
  const [upload, setUpload] = useState<{done: number; total: number; stage: string; error: string} | null>(null);
  const feedback = useFeedback();

  async function send(files: File[]) {
    if (!files.length) return;
    setUpload({done: 0, total: files.length, stage: 'Starting upload…', error: ''});
    try {
      const job = await apiPost<ImportJob>('/jobs', {});
      let done = 0;
      for (const file of files) {
        const name = file.webkitRelativePath || file.name;
        // Large files go in pieces, so a proxy's request size limit doesn't stop them.
        for (let offset = 0; offset === 0 || offset < file.size; offset += UPLOAD_PIECE) {
          const end = Math.min(file.size, offset + UPLOAD_PIECE),
            more = end < file.size;
          const response = await authedFetch(
            `${apiBase}/jobs/${job.id}/upload?name=${encodeURIComponent(name)}&offset=${offset}${more ? '&more=1' : ''}`,
            {
              method: 'PUT',
              body: file.slice(offset, end),
            },
          );
          if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'request_failed');
          if (more)
            setUpload({
              done,
              total: files.length,
              stage: `Uploading file ${done + 1} of ${files.length} (${Math.round((end / file.size) * 100)}%)`,
              error: '',
            });
        }
        done++;
        setUpload({done, total: files.length, stage: `Uploaded ${done} of ${files.length} files`, error: ''});
      }
      setUpload({done, total: files.length, stage: 'Checking the export…', error: ''});
      await apiPost(`/jobs/${job.id}/preview`, {});
      await refreshResources();
      setUpload(null);
      setParams({job: job.id}, true);
      feedback.toast('Export checked. Review it below, then start the import.');
    } catch (error) {
      setUpload(current => ({done: current?.done ?? 0, total: files.length, stage: '', error: problemText(error)}));
      void refreshResources();
    }
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Import Telegram history"
          description="In Telegram Desktop, open a chat or Settings › Advanced › Export Telegram data, and choose JSON."
        />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <FilePick
              label="Choose ZIP or JSON"
              icon={FileArchive}
              accept=".json,.zip"
              disabled={!!upload && !upload.error}
              onFiles={send}
              primary
            />
            <FilePick
              label="Choose export folder"
              icon={FolderOpen}
              folder
              disabled={!!upload && !upload.error}
              onFiles={send}
            />
          </div>
          <p className="text-xs text-muted">
            Pick the folder or a ZIP to include photos and voice notes; a JSON file alone brings text only. Limits: 128
            MB for the messages file (result.json), 50 MB per other file, 512 MB in total.
          </p>
          {upload && !upload.error && <Progress value={upload.done} max={upload.total} label={upload.stage} />}
          {upload?.error && (
            <Notice
              tone="bad"
              title="The export wasn’t imported"
              action={
                <Button size="sm" variant="ghost" onClick={() => setUpload(null)}>
                  Dismiss
                </Button>
              }
            >
              {upload.error}
            </Notice>
          )}
        </CardBody>
      </Card>

      {selected && <ImportReview key={selected.id} job={selected} />}
      {selectedId && !selected && jobs.data && (
        <Notice tone="warn" title="That import isn’t in the list any more">
          Choose one from the history below.
        </Notice>
      )}

      <Card>
        <CardHeader title="Past imports" />
        {jobs.error && <LoadError what="imports" onRetry={() => void refreshResources()} className="mx-5 mt-3" />}
        {!jobs.data && !jobs.error && <LoadingRows rows={2} />}
        {jobs.data && !imports.length && (
          <Empty icon={History} title="No imports yet">
            Imports you start appear here with their progress, so you can come back and resume one.
          </Empty>
        )}
        {!!imports.length && (
          <ul className="mt-3 border-t border-line">
            {imports.map(job => {
              const status = importStatus(job);
              const total = job.preview?.messages ?? 0;
              return (
                <li key={job.id} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    onClick={() => setParams({job: job.id === selectedId ? null : job.id})}
                    aria-current={job.id === selectedId || undefined}
                    className={cn(
                      'flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-left text-sm hover:bg-subtle/60',
                      job.id === selectedId && 'bg-accent-soft/50',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {job.preview?.chats.map(chat => chat.name).join(', ') || 'Telegram export'}
                      </span>
                      <span className="text-xs text-muted">
                        {fullTime(job.created_at)}
                        {total ? ` · ${job.completed} of ${total} messages` : ''}
                      </span>
                    </span>
                    <Badge tone={status.tone} dot>
                      {status.label}
                    </Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function FilePick({
  label,
  icon: Icon,
  accept,
  folder,
  disabled,
  primary,
  onFiles,
}: {
  label: string;
  icon: typeof Upload;
  accept?: string;
  folder?: boolean;
  disabled?: boolean;
  primary?: boolean;
  onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant={primary ? 'primary' : 'secondary'} disabled={disabled} onClick={() => input.current?.click()}>
        <Icon aria-hidden /> {label}
      </Button>
      <input
        ref={input}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        accept={accept}
        multiple={folder}
        {...(folder ? folderPicker : {})}
        onChange={event => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          onFiles(files);
        }}
      />
    </>
  );
}

function ImportReview({job}: {job: ImportJob}) {
  const settings = useSettings();
  const chatName = useChatNames();
  const feedback = useFeedback();
  const resume = isResume(job);
  const [mapping, setMapping] = useState<Record<string, string>>(job.mapping ?? {});
  const [learn, setLearn] = useState(job.review_approved ?? false);
  const [busy, setBusy] = useState<'start' | 'cancel' | null>(null);
  const [problem, setProblem] = useState('');
  const preview = job.preview;
  const status = importStatus(job);
  const editable = job.state === 'ready' && !resume;
  const owner = settings.saved('TELEGRAM_OWNER_ID');
  const groups = settings
    .saved('TELEGRAM_GROUP_IDS')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const chosenMapping = resume ? (job.mapping ?? {}) : mapping;
  const chosenLearn = resume ? (job.review_approved ?? false) : learn;
  const shared = Object.values(chosenMapping).some(target => groups.includes(target));

  async function act(action: 'start' | 'cancel') {
    if (action === 'start' && shared && editable) {
      const ok = await feedback.confirm({
        title: 'Share imported history with a group?',
        body: 'Everyone the assistant answers in that group may get answers based on the chats you mapped to it.',
        confirm: 'Start import',
      });
      if (!ok) return;
    }
    if (action === 'cancel') {
      const ok = await feedback.confirm({
        title: 'Stop this import?',
        body: 'Messages already imported stay. You can resume later with the same choices.',
        confirm: 'Stop import',
      });
      if (!ok) return;
    }
    setBusy(action);
    setProblem('');
    try {
      await apiPost(
        `/jobs/${job.id}/${action}`,
        action === 'start' ? {mapping: chosenMapping, review_approved: chosenLearn} : {},
      );
      feedback.toast(
        action === 'cancel'
          ? 'Import stopped. Messages already imported are kept.'
          : 'Import started. Old messages never get replies.',
      );
    } catch (error) {
      setProblem(problemText(error));
    } finally {
      setBusy(null);
      void refreshResources();
    }
  }

  if (!preview)
    return (
      <Card>
        <CardHeader
          title={job.state === 'preview_failed' ? 'Couldn’t read this export' : 'Upload not finished'}
          description={
            job.state === 'preview_failed'
              ? `${problemText(job.error)} Choose the export again above.`
              : 'This export was never checked, so it can’t be imported. Choose the export again above.'
          }
          action={
            <Badge tone={status.tone} dot>
              {status.label}
            </Badge>
          }
        />
        <CardBody />
      </Card>
    );

  const total = preview.messages;
  return (
    <Card>
      <CardHeader
        title="Review and import"
        description={`Uploaded ${fullTime(job.created_at)}`}
        action={
          <>
            <Badge tone={status.tone} dot>
              {status.label}
            </Badge>
            <Button variant="ghost" size="sm" onClick={() => setParams({job: null})}>
              Close
            </Button>
          </>
        }
      />
      <CardBody className="space-y-5">
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <Stat label="Messages" value={total.toLocaleString()} />
          <Stat label="Files included" value={preview.supplied_files.toLocaleString()} />
          <Stat
            label="Files missing"
            value={preview.missing_files.toLocaleString()}
            tone={preview.missing_files ? 'warn' : undefined}
          />
        </div>
        {dateSpan(preview.first_at, preview.last_at) && (
          <p className="text-[13px] text-muted">Messages from {dateSpan(preview.first_at, preview.last_at)}</p>
        )}
        {preview.missing_files > 0 && (
          <p className="text-xs text-muted">Messages with missing files are still imported with their text.</p>
        )}

        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Where each chat belongs</h3>
          <p className="text-[13px] text-muted">
            {resume
              ? 'Chosen when the import started. They can’t change, even when it resumes.'
              : 'By default an imported chat is private to you. Mapping it to a group lets the assistant use it there.'}
          </p>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {preview.chats.map(chat => (
              <li
                key={chat.id}
                className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <label htmlFor={`map-${chat.id}`} className="min-w-0 text-sm">
                  <span className="block truncate font-medium" dir="auto">
                    {chat.name}
                  </span>
                  <span className="text-xs text-muted">
                    {chat.messages.toLocaleString()} messages
                    {chat.topics ? ` · ${chat.topics.toLocaleString()} ${chat.topics === 1 ? 'topic' : 'topics'}` : ''}
                    {dateSpan(chat.first_at, chat.last_at) ? ` · ${dateSpan(chat.first_at, chat.last_at)}` : ''}
                  </span>
                  {(() => {
                    const match = matchingGroup(chat, groups);
                    return editable && match && chosenMapping[chat.id] !== match ? (
                      <span className="block text-xs text-warn">
                        This is {chatName(match)}. Share it with that chat so messages already saved aren’t kept twice.
                      </span>
                    ) : null;
                  })()}
                </label>
                <Select
                  id={`map-${chat.id}`}
                  className="sm:w-72"
                  value={chosenMapping[chat.id] ?? ''}
                  disabled={!editable || !!busy}
                  onChange={event => {
                    const next = {...mapping};
                    if (event.target.value) next[chat.id] = event.target.value;
                    else delete next[chat.id];
                    setMapping(next);
                  }}
                >
                  <option value="">Private to you (separate history)</option>
                  {owner && <option value={owner}>Add to your private chat with the assistant</option>}
                  {groups.map(group => (
                    <option key={group} value={group}>
                      Share with {chatName(group)}
                    </option>
                  ))}
                  {chosenMapping[chat.id] &&
                    chosenMapping[chat.id] !== owner &&
                    !groups.includes(chosenMapping[chat.id]!) && (
                      <option value={chosenMapping[chat.id]}>{chatName(chosenMapping[chat.id]!)}</option>
                    )}
                </Select>
              </li>
            ))}
          </ul>
        </div>

        <label
          className={cn(
            'flex items-start gap-3 rounded-lg border border-line p-3',
            editable && 'cursor-pointer hover:bg-subtle/60',
          )}
        >
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-accent"
            checked={chosenLearn}
            disabled={!editable || !!busy}
            onChange={event => setLearn(event.target.checked)}
          />
          <span className="text-sm">
            <span className="font-medium">Let the assistant learn from this history</span>
            <span className="mt-0.5 block text-[13px] text-muted">
              Optional. Without it, imported messages are kept and searchable but not learned from.
              {resume ? ' This choice is kept when resuming.' : ''}
            </span>
          </span>
        </label>

        {job.state !== 'ready' && total > 0 && (
          <Progress
            value={job.completed}
            max={total}
            label={`${job.completed.toLocaleString()} of ${total.toLocaleString()} messages${job.duplicates ? ` · ${job.duplicates.toLocaleString()} already kept` : ''}`}
          />
        )}
        {job.state === 'complete' && job.prepared && !job.prepared_at && (
          <Progress
            value={job.prepared.ready + job.prepared.failed}
            max={Math.max(1, job.prepared.total)}
            label={preparationLabel(job.prepared)}
          />
        )}
        {job.state === 'complete' && job.prepared_at && (
          <p className="text-sm text-muted">
            Ready: every message is saved, read and checked for secrets. You can ask about this chat now.
          </p>
        )}
        {job.error && (
          <Notice tone={job.state === 'failed' ? 'bad' : 'warn'} title="Last problem">
            {problemText(job.error)}
          </Notice>
        )}
        {problem && (
          <Notice tone="bad" title="Didn’t work">
            {problem}
          </Notice>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {canStart(job) && (
            <Button variant="primary" busy={busy === 'start'} disabled={!!busy} onClick={() => void act('start')}>
              {job.completed || resume ? 'Resume import' : 'Start import'}
            </Button>
          )}
          {job.state === 'running' && (
            <Button variant="danger" busy={busy === 'cancel'} disabled={!!busy} onClick={() => void act('cancel')}>
              Stop import
            </Button>
          )}
          {job.state === 'complete' && (
            <Button variant="secondary" onClick={() => (location.hash = '#messages')}>
              See imported messages
            </Button>
          )}
          <span className="text-xs text-muted">Old messages are archived only; no replies are sent.</span>
        </div>
      </CardBody>
    </Card>
  );
}

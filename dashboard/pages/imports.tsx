import {useState} from 'react';
import {
  base,
  authedFetch,
  call,
  button,
  errorText,
  Panel,
  friendlyState,
  jobName,
  Steps,
  useLoad,
  useResource,
  StatusBadge,
  Progress,
} from '../lib/page-helpers';

/** Browsers read this non-standard attribute to let the owner pick a whole folder. */
const folderPicker = {webkitdirectory: ''};

export function Jobs({notify}: {notify: (message: string, error?: boolean) => void}) {
  const [tick, setTick] = useState(0),
    {data: jobs, error} = useResource<any[]>('/jobs', 10000, tick),
    [settings] = useLoad('/settings');
  const [selected, setSelected] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(''),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [reviewApproved, setReviewApproved] = useState(false);

  const fields = Object.fromEntries((settings?.fields || []).map((f: any) => [f.key, f.value]));
  const scopes: string[] = [fields.TELEGRAM_OWNER_ID, ...(fields.TELEGRAM_GROUP_IDS || '').split(',')].filter(Boolean);
  const upload = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    setProgress('Preparing upload…');
    try {
      const job = await call('/jobs', {});
      let done = 0;
      for (const file of files) {
        const name = file.webkitRelativePath || file.name;
        const response = await authedFetch(base + '/jobs/' + job.id + '/upload?name=' + encodeURIComponent(name), {
          method: 'PUT',
          body: file,
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Upload failed');
        setProgress('Uploaded ' + ++done + ' of ' + files.length + ' files');
      }
      setProgress('Checking export and media…');
      const preview = await call('/jobs/' + job.id + '/preview', {});
      setSelected(preview);
      setMapping({});
      setReviewApproved(false);
      setTick(v => v + 1);
      setProgress('Ready to review.');
    } catch (e) {
      notify(errorText(e), true);
      setProgress('Upload needs attention. Your archive has not been imported.');
    } finally {
      setBusy(false);
    }
  };
  const run = async (job: any, action: string) => {
    setBusy(true);
    try {
      const result = await call(
        '/jobs/' + job.id + '/' + action,
        action === 'start'
          ? {mapping: job.mapping || mapping, review_approved: job.review_approved ?? reviewApproved}
          : {},
      );
      setSelected(result);
      setTick(v => v + 1);
      notify(
        action === 'cancel'
          ? 'Import stopped. Already archived messages are retained.'
          : 'Import started. Historical messages will not send replies.',
      );
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      setBusy(false);
    }
  };
  const current = jobs?.find(j => j.id === selected?.id) || selected;
  return (
    <div>
      <Panel
        title="1. Choose a Telegram export"
        note="Export from Telegram Desktop as JSON. Select the export folder to include media, a ZIP, or a JSON file for text only."
      >
        <Steps
          items={['Choose an export', 'Review access and files', 'Import and track progress']}
          current={current?.state === 'ready' ? 1 : current?.preview ? 2 : 0}
        />
        <div className="n-actions">
          <label className="n-file">
            Select JSON or ZIP
            <input type="file" accept=".json,.zip" disabled={busy} onChange={e => upload([...e.target.files!])} />
          </label>
          <label className="n-file">
            Select export folder
            <input
              type="file"
              {...folderPicker}
              multiple
              disabled={busy}
              onChange={e => upload([...e.target.files!])}
            />
          </label>
        </div>
        <p role="status">{progress}</p>
        <p className="n-muted">
          Limits: 32 MiB export JSON, 50 MiB per media file, 256 MiB ZIP upload, 512 MiB unpacked.
        </p>
      </Panel>
      {!current?.preview && (
        <Panel
          title="2. Review access and files"
          note="Choose an export above to preview message counts and missing files, then decide whether its history stays private or is shared with a selected group."
        />
      )}
      {current?.preview && (
        <Panel title="2. Review access and files">
          <p>
            {current.preview.messages +
              ' messages · ' +
              current.preview.supplied_files +
              ' supplied files · ' +
              current.preview.missing_files +
              ' missing files'}
          </p>
          {current.preview.chats.map((c: any) => (
            <div className="n-field" key={c.id}>
              <label htmlFor={'scope-' + c.id}>{c.name + ' · ' + c.messages + ' messages'}</label>
              <select
                id={'scope-' + c.id}
                value={(current.mapping || mapping)[c.id] || ''}
                disabled={busy || current.state !== 'ready'}
                onChange={e => {
                  const next = {...mapping};
                  if (e.target.value) next[c.id] = e.target.value;
                  else delete next[c.id];
                  setMapping(next);
                }}
              >
                <option value="">Owner-only archive (default)</option>
                {scopes.map(s => (
                  <option value={s} key={s}>
                    {s === fields.TELEGRAM_OWNER_ID ? 'Owner DM · ' + s : 'Share with group · ' + s}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <p className="n-muted">
            Group mapping makes this history available to that group. Import stores originals; it does not automatically
            rewrite memory.
          </p>
          <label className="n-review-consent">
            <input
              type="checkbox"
              checked={current.review_approved ?? reviewApproved}
              disabled={busy || current.state !== 'ready'}
              onChange={e => setReviewApproved(e.target.checked)}
            />
            Allow this import to be learned by memory
          </label>
          <p className="n-muted">
            Optional. This permits native memory review and Honcho learning when attached. Guarding alone does not
            permit learning. This choice is preserved when resuming.
          </p>
          <StatusBadge state={current.state} label={friendlyState(current.state)} />
          {current.preview.messages > 0 && (
            <Progress
              value={(100 * current.completed) / current.preview.messages}
              label={
                current.completed +
                ' / ' +
                current.preview.messages +
                ' messages · ' +
                current.duplicates +
                ' duplicates'
              }
            />
          )}
          {current.error && <p role="alert">{current.error}</p>}
          {['ready', 'failed', 'cancelled', 'interrupted'].includes(current.state) &&
            button(
              current.completed ? 'Resume import' : 'Start import',
              () => run(current, 'start'),
              busy,
              'n-primary',
            )}
          {current.state === 'running' && button('Stop import', () => run(current, 'cancel'))}
        </Panel>
      )}
      <Panel
        title="3. Import history"
        note="Select an import to inspect its progress or resume it. Maintenance and settings jobs appear in Maintenance."
      >
        {error && <p role="alert">{error}</p>}
        {jobs?.some(j => j.kind === 'import') ? (
          <div className="n-list">
            {jobs
              .filter(j => j.kind === 'import')
              .map(j => (
                <div className="n-job" key={j.id}>
                  {button(jobName(j.kind) + ' · ' + new Date(j.created_at).toLocaleString(), () => {
                    setSelected(j);
                    setMapping(j.mapping || {});
                    setReviewApproved(j.review_approved ?? false);
                  })}
                  <StatusBadge state={j.state} label={friendlyState(j.state)} />
                  <small>{j.completed + ' processed'}</small>
                  {j.error && <p role="alert">{j.error}</p>}
                  {j.result && j.kind !== 'import' && <p>{'Result: ' + (j.result.status || j.state)}</p>}
                </div>
              ))}
          </div>
        ) : (
          <p className="n-muted">
            {jobs ? 'No imports yet. Your first import will appear here.' : 'Loading import history…'}
          </p>
        )}
      </Panel>
    </div>
  );
}

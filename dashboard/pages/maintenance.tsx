import {useRef, useState, type MouseEvent} from 'react';
import {
  call,
  button,
  errorText,
  Panel,
  friendlyState,
  jobName,
  Details,
  download,
  useResource,
  StatusBadge,
  Modal,
} from '../lib/page-helpers';

function OperationResult({result}: {result: any}) {
  if (result.containers)
    return (
      <div>
        {result.execution_holds && Object.values(result.execution_holds).some(Boolean) && (
          <p role="status">
            This restored installation is held for inspection. Review pending work before activating it.
          </p>
        )}
        {result.containers.map((c: any) => (
          <div className="n-row" key={c.service}>
            <div>
              <b>{c.service}</b>
              <p className="n-muted">{[c.tool, c.location, c.purpose].filter(Boolean).join(' · ')}</p>
            </div>
            <div>
              <StatusBadge state={c.state} />
              {c.expected_state && <small>{'Expected ' + c.expected_state}</small>}
            </div>
          </div>
        ))}
        <Details value={result} label="Full diagnostics" />
      </div>
    );
  const messages: Record<string, string> = {
    backed_up: 'Full backup created.',
    restored_inactive:
      'Backup restored into a separate inactive installation. Telegram and the copied login remain disabled.',
    exported: 'Portable archive ZIP ready to download.',
    restarted: 'Services restarted and readiness checked.',
    applied: 'Saved settings applied to running services.',
    apply_failed: result.rolled_back
      ? 'Applying settings failed. The previous configuration was restored.'
      : 'Applying settings failed. Check diagnostics before trying again.',
  };
  return (
    <div>
      <p>{messages[result.status] || 'Task finished. See details for its result.'}</p>
      {result.status === 'exported' && (
        <p className="n-muted">
          {result.events +
            ' source records · ' +
            result.files +
            ' original files' +
            (result.native_profiles !== undefined ? ' · ' + result.native_profiles + ' native profiles' : '')}
        </p>
      )}
      {result.status === 'restored_inactive' && (
        <p className="n-muted">
          {(result.verified_tables?.length || 0) +
            ' tables verified · ' +
            result.verified_state_files +
            ' state files verified'}
        </p>
      )}
      <Details value={result} />
    </div>
  );
}

export function Operations({notify}: {notify: (message: string, error?: boolean) => void}) {
  const [tick, setTick] = useState(0),
    {data: listing, error: listError} = useResource('/operations', 10000, tick),
    {data: jobs, error: jobsError} = useResource<any[]>('/jobs', 10000, tick),
    [review, setReview] = useState(''),
    [backup, setBackup] = useState(''),
    [port, setPort] = useState(8795),
    [busy, setBusy] = useState(false);

  const reviewTrigger = useRef<HTMLElement | null>(null);
  // `button` passes the click event through, so the review dialog can return focus to its trigger.
  const openReview = (action: string, event?: MouseEvent<HTMLElement>) => {
    reviewTrigger.current = event?.currentTarget ?? null;
    setReview(action);
  };
  const run = async (action: string) => {
    setBusy(true);
    try {
      await call('/operations', {action, options: action === 'restore' ? {backup, port} : undefined});
      setReview('');
      setTick(v => v + 1);
      notify('Task started. Follow its progress in Recent maintenance below.');
    } catch (e) {
      notify(errorText(e), true);
    } finally {
      setBusy(false);
    }
  };
  const descriptions: Record<string, string> = {
    backup:
      'Pause archive writers, save a consistent database, files and runtime snapshot, then resume those services. This local backup includes private state and credentials.',
    restart:
      'Restart Hermes and the archive workers, then check readiness. Telegram replies may be briefly interrupted.',
    restore:
      'Restore the selected backup into a new, separate local installation. Telegram stays disabled and the copied subscription login stays inactive. Your current installation is not replaced.',
  };
  const tasks = (jobs || []).filter(j => j.kind !== 'import');
  const operations: [action: string, title: string, note: string, label: string][] = [
    [
      'portable-export',
      'Export archive and memory',
      'Download originals, file bytes, generated results and native notes/session databases. Operational credentials are excluded.',
      'Export archive & memory ZIP',
    ],
    [
      'diagnose',
      'Check service health',
      'Inspect containers and archive readiness without changing your data.',
      'Run diagnostics',
    ],
    [
      'export',
      'Download your archive',
      'Create a portable ZIP of original source records and files.',
      'Prepare archive ZIP',
    ],
    [
      'backup',
      'Back up the installation',
      'Save the database, files and Hermes runtime state, including credentials, locally.',
      'Review full backup',
    ],
    [
      'restart',
      'Restart services',
      'Restart the assistant and workers. Wait for active imports to finish.',
      'Review restart',
    ],
  ];
  return (
    <div>
      <div className="n-operation-grid">
        {operations.map(([action, title, note, label]) => (
          <Panel key={action} title={title} note={note}>
            {button(
              label,
              (event?: MouseEvent<HTMLElement>) =>
                ['backup', 'restart'].includes(action) ? openReview(action, event) : run(action),
              busy,
            )}
          </Panel>
        ))}
      </div>
      <Panel title="Saved backups">
        {listError && <p role="alert">{listError}</p>}
        {!listing && !listError && <p role="status">Loading saved backups…</p>}
        {listing && (
          <p className="n-muted">
            {listing.backups.length
              ? listing.backups.length +
                ' local backup' +
                (listing.backups.length === 1 ? '' : 's') +
                ' available. Restore creates a separate installation for verification.'
              : 'No backups yet. Create a full backup above to enable an inactive restore.'}
          </p>
        )}
        <details>
          <summary>Advanced · restore a backup into an inactive installation</summary>
          <p className="n-muted">{descriptions.restore}</p>
          <div className="n-form">
            <label>
              Saved backup
              <select
                value={backup}
                onChange={e => {
                  setBackup(e.target.value);
                  setReview('');
                }}
              >
                <option value="">Choose a backup</option>
                {(listing?.backups || []).map((b: any) => (
                  <option key={b.id} value={b.id}>
                    {new Date(b.created_at).toLocaleString() + ' · ' + b.files + ' files'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Local port for the inactive installation
              <input
                type="number"
                min={1024}
                max={65535}
                value={port}
                onChange={e => {
                  setPort(Number(e.target.value));
                  setReview('');
                }}
              />
            </label>
          </div>
          {button(
            'Review inactive restore',
            (event?: MouseEvent<HTMLElement>) => openReview('restore', event),
            !backup || busy,
          )}
        </details>
      </Panel>
      <Modal
        returnFocus={reviewTrigger.current}
        open={!!review}
        onOpenChange={open => {
          if (!open) setReview('');
        }}
        title={
          'Review ' +
          ({backup: 'full backup', restart: 'service restart', restore: 'inactive restore'} as Record<string, string>)[
            review
          ]
        }
      >
        <p>{descriptions[review]}</p>
        {review === 'restore' && <p>{'Backup ' + backup + ' · local port ' + port}</p>}
        <div className="n-actions">
          {button('Confirm ' + review, () => run(review), busy, 'n-primary')}
          {button('Cancel', () => setReview(''))}
        </div>
      </Modal>
      <Panel
        title="Recent maintenance"
        note="Diagnostics, exports, backups, restarts, restores and settings applies. Results update automatically."
      >
        {jobsError && <p role="alert">{jobsError}</p>}
        {jobs && !tasks.length && (
          <p className="n-empty">No maintenance tasks yet. Run diagnostics above to check the installation.</p>
        )}
        {tasks.map(j => (
          <article className="n-result" key={j.id}>
            <div className="n-result-heading">
              <h3>{jobName(j.kind)}</h3>
              <StatusBadge state={j.state} label={friendlyState(j.state)} />
            </div>
            <small>{new Date(j.created_at).toLocaleString()}</small>
            {j.error && <p role="alert">{j.error}</p>}
            {j.result && (
              <details>
                <summary>Inspect result</summary>
                <OperationResult result={j.result} />
              </details>
            )}
            {['operations.export', 'operations.portable-export'].includes(j.kind) &&
              j.state === 'complete' &&
              button('Download ZIP', () => download('/exports/' + j.id + '/download', 'nocheh-archive.zip'))}
          </article>
        ))}
      </Panel>
    </div>
  );
}

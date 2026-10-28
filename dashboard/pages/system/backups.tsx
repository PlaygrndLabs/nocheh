/** System › Backups: back up, restore, export, check and restart, with a history of past tasks. */
import {useState, type ReactNode} from 'react';
import {Archive, Download, HardDriveDownload, History, RotateCcw, Stethoscope, Undo2} from 'lucide-react';
import {apiPost, download} from '../../lib/api';
import {useParam} from '../../lib/navigation';
import {refreshResources, useResource} from '../../lib/resource';
import {setParams} from '../../lib/routes';
import {
  ago,
  count,
  dateTime,
  jobName,
  jobOutcome,
  jobState,
  operationError,
  serviceName,
  serviceState,
} from '../../lib/system-format';
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  LoadError,
  LoadingRows,
  Notice,
  Select,
  Spinner,
  Technical,
} from '../../ui/core';
import {Dialog, Drawer, useFeedback} from '../../ui/overlay';

type Job = {
  id: string;
  kind: string;
  state: string;
  created_at: string;
  error?: string | null;
  result?: any;
  automatic?: boolean;
};
type Backup = {id: string; created_at: string; files: number; automatic?: boolean};
type Schedule = {
  enabled: boolean;
  time: string;
  time_zone: string;
  keep: number;
  next_at: string | null;
  skipped?: string | null;
};
const taskName = (job: Job) => (job.automatic ? 'Automatic backup' : jobName(job.kind));
type Action = 'backup' | 'export' | 'portable-export' | 'diagnose' | 'restart' | 'restore';

const isExport = (job: Job) => job.kind === 'operations.export' || job.kind === 'operations.portable-export';
const zipName = (job: Job) =>
  job.kind === 'operations.portable-export' ? 'nocheh-archive-memory.zip' : 'nocheh-archive.zip';
const running = (job: Job) => job.state === 'running' || job.state === 'queued';

function DownloadButton({job, size = 'sm'}: {job: Job; size?: 'sm' | 'md'}) {
  return (
    <Button
      size={size}
      variant="primary"
      onClick={event => {
        event.stopPropagation();
        download('/exports/' + job.id + '/download', zipName(job));
      }}
    >
      <Download aria-hidden /> Download ZIP
    </Button>
  );
}

export function BackupsView() {
  const jobs = useResource<Job[]>('/jobs', 5000);
  const listing = useResource<{backups: Backup[]; schedule?: Schedule}>('/operations', 10000);
  const {toast, confirm} = useFeedback();
  const [busy, setBusy] = useState<Action | ''>('');
  const [problem, setProblem] = useState<{action: Action; text: string} | null>(null);
  const [restoring, setRestoring] = useState(false);

  const tasks = (Array.isArray(jobs.data) ? jobs.data : [])
    .filter(job => job.kind !== 'import')
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const active = tasks.find(running);
  const latest = (action: Action) => tasks.find(job => job.kind === 'operations.' + action);
  const backups = listing.data?.backups ?? [];
  const schedule = listing.data?.schedule;

  const start = async (action: Action, options?: Record<string, unknown>) => {
    setBusy(action);
    setProblem(null);
    try {
      await apiPost('/operations', {action, ...(options ? {options} : {})});
      toast(jobName('operations.' + action) + ' started');
      setRestoring(false);
      return true;
    } catch (err) {
      setProblem({action, text: operationError(err instanceof Error ? err.message : '')});
      return false;
    } finally {
      setBusy('');
      void refreshResources();
    }
  };

  const ask = async (action: Action) => {
    const reviews: Partial<Record<Action, Parameters<typeof confirm>[0]>> = {
      backup: {
        title: 'Back up now?',
        body: 'Saving new messages pauses for a moment while the backup is made, and this page may be briefly unavailable. The backup includes your keys, so keep it private.',
        confirm: 'Back up',
      },
      restart: {
        title: 'Restart Nocheh?',
        body: 'The assistant and its workers restart. Replies pause for about a minute; nothing is lost.',
        confirm: 'Restart',
        danger: true,
      },
    };
    const review = reviews[action];
    if (review && !(await confirm(review))) return;
    await start(action);
  };

  const card = (
    action: Action,
    Icon: typeof Archive,
    title: string,
    text: string,
    label: string,
    extra?: ReactNode,
  ) => {
    const last = latest(action);
    const state = last ? jobState(last.state) : null;
    return (
      <Card key={action} className="flex flex-col p-5">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text">
            <Icon className="size-[18px]" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold">{title}</h2>
            <p className="mt-0.5 text-[13px] text-muted">{text}</p>
          </div>
        </div>
        {extra}
        {problem?.action === action && (
          <Notice tone="bad" className="mt-3">
            {problem.text}
          </Notice>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
          {action === 'restore' ? (
            <Button disabled={!!active || !backups.length} onClick={() => setRestoring(true)}>
              {label}
            </Button>
          ) : (
            <Button busy={busy === action} disabled={!!busy || !!active} onClick={() => ask(action)}>
              {label}
            </Button>
          )}
          {last && isExport(last) && last.state === 'complete' && <DownloadButton job={last} />}
          {last && state && (
            <span className="flex items-center gap-1.5 text-xs text-muted">
              Last {ago(last.created_at)}
              <Badge tone={state.tone}>{state.label}</Badge>
            </span>
          )}
        </div>
      </Card>
    );
  };

  return (
    <>
      {active && (
        <Notice tone="info" title={`${taskName(active)} is running`} action={<Spinner />}>
          Started {ago(active.created_at)}. Other tasks can start when it finishes.
        </Notice>
      )}
      {jobs.error && !jobs.data && <LoadError what="tasks" />}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {card(
          'backup',
          HardDriveDownload,
          'Back up now',
          'Saves messages, files, settings and the assistant’s state on this machine, including keys.',
          'Back up now',
          schedule && (
            <p className="mt-3 text-xs text-muted">
              {schedule.enabled
                ? `Every day at ${schedule.time} (${schedule.time_zone.replace(/_/g, ' ')}), keeping the last ${schedule.keep}.` +
                  (schedule.next_at ? ` Next ${dateTime(schedule.next_at)}.` : '')
                : 'Automatic backups are off.'}{' '}
              {schedule.skipped === 'low_disk' && 'The last one was skipped: not enough free disk space. '}
              <a className="text-accent-text underline-offset-2 hover:underline" href="#settings?view=privacy">
                Change
              </a>
            </p>
          ),
        )}
        {card(
          'restore',
          Undo2,
          'Restore a backup',
          'Opens a saved backup as a separate, switched-off copy so you can check it. Your current Nocheh keeps running.',
          'Restore…',
          <p className="mt-3 text-xs text-muted">
            {listing.error && !listing.data
              ? 'Saved backups couldn’t be listed.'
              : !listing.data
                ? 'Looking for saved backups…'
                : backups.length
                  ? `${backups.length} saved · newest ${dateTime(backups[0]!.created_at)}`
                  : 'No backups saved yet.'}
          </p>,
        )}
        {card(
          'export',
          Archive,
          'Export your archive',
          'A ZIP of your original messages and files, to keep anywhere.',
          'Prepare ZIP',
        )}
        {card(
          'portable-export',
          Archive,
          'Export archive and memory',
          'Adds the assistant’s notes and chat history. Keys and passwords are left out.',
          'Prepare ZIP',
        )}
        {card(
          'diagnose',
          Stethoscope,
          'Check services',
          'Looks at every service and reports problems. Changes nothing.',
          'Run check',
        )}
        {card(
          'restart',
          RotateCcw,
          'Restart Nocheh',
          'Restarts the assistant and workers. Replies pause for about a minute.',
          'Restart…',
        )}
      </div>
      <JobHistory tasks={tasks} loading={!jobs.data && !jobs.error} />
      <RestoreDialog
        open={restoring}
        onOpenChange={setRestoring}
        backups={backups}
        busy={busy === 'restore'}
        problem={problem?.action === 'restore' ? problem.text : ''}
        onRestore={(backup, port) => start('restore', {backup, port})}
      />
      <JobDrawer tasks={tasks} />
    </>
  );
}

function RestoreDialog({
  open,
  onOpenChange,
  backups,
  busy,
  problem,
  onRestore,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  backups: Backup[];
  busy: boolean;
  problem: string;
  onRestore: (backup: string, port: number) => void;
}) {
  const [backup, setBackup] = useState('');
  const [port, setPort] = useState('8795');
  const [typed, setTyped] = useState('');
  const chosen = backups.find(b => b.id === backup) ?? backups[0];
  const portNumber = Number(port);
  const portOk = Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535;
  const ready = !!chosen && portOk && typed.trim().toLowerCase() === 'restore';
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        onOpenChange(next);
        if (!next) setTyped('');
      }}
      title="Restore a backup"
      description="This makes a second, switched-off copy of Nocheh from the backup. Telegram and scheduled work stay off in it."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="danger"
            busy={busy}
            disabled={!ready}
            onClick={() => chosen && onRestore(chosen.id, portNumber)}
          >
            Restore backup
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Backup" htmlFor="restore-backup">
          <Select id="restore-backup" value={chosen?.id ?? ''} onChange={e => setBackup(e.target.value)}>
            {backups.map(b => (
              <option key={b.id} value={b.id}>
                {dateTime(b.created_at)} · {count(b.files)} files{b.automatic ? ' · automatic' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Address for the restored copy"
          htmlFor="restore-port"
          hint="A free local port between 1024 and 65535. The copy opens there so you can check it."
          error={port && !portOk ? 'Choose a number between 1024 and 65535.' : undefined}
        >
          <Input
            id="restore-port"
            inputMode="numeric"
            value={port}
            onChange={e => setPort(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
        <Notice tone="warn">Restoring uses disk space and runs extra services until you remove the copy.</Notice>
        <Field label={<>Type “restore” to confirm</>} htmlFor="restore-confirm">
          <Input id="restore-confirm" value={typed} autoComplete="off" onChange={e => setTyped(e.target.value)} />
        </Field>
        {problem && <Notice tone="bad">{problem}</Notice>}
      </div>
    </Dialog>
  );
}

function JobHistory({tasks, loading}: {tasks: Job[]; loading: boolean}) {
  const [all, setAll] = useState(false);
  const shown = all ? tasks : tasks.slice(0, 8);
  return (
    <Card>
      <div className="px-5 pt-4">
        <h2 className="text-[15px] font-semibold">History</h2>
        <p className="mt-0.5 text-[13px] text-muted">
          Backups, exports, checks, restarts and settings changes being applied.
        </p>
      </div>
      <div className="mt-3">
        {loading ? (
          <LoadingRows rows={3} />
        ) : !tasks.length ? (
          <Empty icon={History} title="Nothing here yet">
            Tasks you start above, and settings you apply, are listed here with their result.
          </Empty>
        ) : (
          <ul>
            {shown.map(job => {
              const state = jobState(job.state);
              return (
                <li key={job.id} className="border-t border-line">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setParams({job: job.id})}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setParams({job: job.id});
                      }
                    }}
                    className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 hover:bg-subtle/60 focus-visible:bg-subtle focus-visible:outline-none"
                  >
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="text-sm font-medium">{taskName(job)}</p>
                      <p className="text-[13px] text-muted">{jobOutcome(job)}</p>
                    </div>
                    <span className="text-xs text-muted" title={dateTime(job.created_at)}>
                      {ago(job.created_at)}
                    </span>
                    <Badge tone={state.tone}>{state.label}</Badge>
                    {isExport(job) && job.state === 'complete' && <DownloadButton job={job} />}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {tasks.length > 8 && (
          <div className="border-t border-line px-5 py-3">
            <Button variant="link" size="sm" onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `Show all ${tasks.length}`}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function JobDrawer({tasks}: {tasks: Job[]}) {
  const id = useParam('job');
  const job = tasks.find(task => task.id === id);
  const result = job?.result ?? {};
  const state = job ? jobState(job.state) : null;
  const containers: any[] = Array.isArray(result.containers) ? result.containers : [];
  return (
    <Drawer
      open={!!id}
      onOpenChange={open => !open && setParams({job: null})}
      title={job ? taskName(job) : 'Task'}
      description={job ? dateTime(job.created_at) : undefined}
      footer={job && isExport(job) && job.state === 'complete' ? <DownloadButton job={job} size="md" /> : undefined}
    >
      {!job ? (
        <Notice tone="warn" title="This task isn’t in the list">
          It may have been removed, or the list hasn’t loaded yet.
        </Notice>
      ) : (
        <div className="space-y-5">
          <div className="flex items-center gap-2">
            <Badge tone={state!.tone} dot>
              {state!.label}
            </Badge>
            <span className="text-sm">{jobOutcome(job)}</span>
          </div>
          {result.execution_holds && Object.values(result.execution_holds).some(Boolean) && (
            <Notice tone="info">The restored copy is on hold so you can check waiting work before using it.</Notice>
          )}
          {result.status === 'restored_inactive' && (
            <p className="text-sm text-muted">
              {count(result.verified_tables?.length ?? 0)} tables and {count(result.verified_state_files ?? 0)} files
              checked.
            </p>
          )}
          {containers.length > 0 && (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {containers.map(row => {
                const service = serviceState(row.state);
                return (
                  <li key={row.service} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1">{serviceName(row)}</span>
                    <Badge tone={service.tone}>{service.label}</Badge>
                  </li>
                );
              })}
            </ul>
          )}
          <Technical value={job} />
        </div>
      )}
    </Drawer>
  );
}

/** System › Backups: back up, restore, export, check and restart, with a history of past tasks. */
import {useState, type ReactNode} from 'react';
import {Download, History} from 'lucide-react';
import {apiPost, download} from '../../lib/api';
import {useParam, useSubTab} from '../../lib/navigation';
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
  ActionRow,
  Badge,
  Button,
  Card,
  CardHeader,
  Dot,
  Empty,
  Field,
  Input,
  LoadError,
  LoadingRows,
  Notice,
  Pager,
  Select,
  Spinner,
  Table,
  Td,
  Technical,
  Th,
} from '../../ui/core';
import {Dialog, Drawer, useFeedback} from '../../ui/overlay';
import {SubPanel, SubTabs} from '../../ui/page';

type Job = {
  id: string;
  kind: string;
  state: string;
  created_at: string;
  error?: string | null;
  result?: any;
  automatic?: boolean;
};
type Backup = {id: string; created_at: string; files: number; automatic?: boolean; offsite?: boolean};
type OffsiteStatus = {
  enabled: boolean;
  keep: number;
  bucket: string | null;
  last?: {state: string; at: string; error?: string; bytes?: number; prune_error?: string} | null;
  check?: {state: string; at: string; error?: string} | null;
  last_sent?: {at: string; bytes?: number} | null;
};
type Schedule = {
  enabled: boolean;
  time: string;
  time_zone: string;
  keep: number;
  next_at: string | null;
  skipped?: string | null;
  /** Less free space than another backup needs; Back up now still runs. */
  low_disk?: boolean | null;
};
/** How the latest backups ended (ADR-0251). Names are escaped by the server and shown only here. */
type BackupHealth = {
  failed: number;
  reason?: string | null;
  path?: string | null;
  unreadable: number;
  unreadable_paths?: string[];
};
const taskName = (job: Job) =>
  job.automatic
    ? job.kind === 'operations.offsite'
      ? 'Automatic off-site copy'
      : 'Automatic backup'
    : jobName(job.kind);
type Action =
  'backup' | 'export' | 'portable-export' | 'diagnose' | 'restart' | 'restore' | 'offsite' | 'offsite-check';

function offsiteSummary(offsite: OffsiteStatus | undefined, sending: boolean): string {
  if (!offsite) return '';
  if (!offsite.enabled) return 'Off. Copies stay only on this machine.';
  const last = offsite.last,
    good = offsite.last_sent;
  const stored = good
    ? `Last copy ${dateTime(good.at)}${good.bytes != null ? ` (${size(good.bytes)})` : ''}.`
    : 'No copy sent yet.';
  const latest = sending
    ? 'Sending a copy now.'
    : last?.state === 'failed'
      ? `The last try failed ${dateTime(last.at)}: ${operationError(last.error ?? 'offsite_failed')}`
      : last?.state === 'running'
        ? `A copy started ${dateTime(last.at)} didn’t finish.`
        : '';
  return [latest, stored, `Keeping the last ${offsite.keep} in ${offsite.bucket ?? 'the bucket'}.`]
    .filter(Boolean)
    .join(' ');
}

function checkSummary(offsite: OffsiteStatus | undefined): string {
  const check = offsite?.check;
  if (!offsite?.enabled) return '';
  if (!check) return 'Not tested yet.';
  return check.state === 'passed'
    ? `Passed ${dateTime(check.at)}.`
    : `Failed ${dateTime(check.at)}: ${operationError(check.error ?? 'offsite_failed')}`;
}

const size = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : bytes >= 1024 ** 2
      ? `${Math.round(bytes / 1024 ** 2)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

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

const subTabs = ['actions', 'history'] as const;

export function BackupsView() {
  const jobs = useResource<Job[]>('/jobs', 5000);
  const listing = useResource<{
    backups: Backup[];
    schedule?: Schedule;
    offsite?: OffsiteStatus;
    health?: BackupHealth;
  }>('/operations', 10000);
  const {toast, confirm} = useFeedback();
  const [busy, setBusy] = useState<Action | ''>('');
  const [problem, setProblem] = useState<{action: Action; text: string} | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [tab, setTab] = useSubTab(subTabs);

  const tasks = (Array.isArray(jobs.data) ? jobs.data : [])
    .filter(job => job.kind !== 'import')
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const active = tasks.find(running);
  const latest = (action: Action) => tasks.find(job => job.kind === 'operations.' + action);
  const backups = listing.data?.backups ?? [];
  const schedule = listing.data?.schedule;
  const offsite = listing.data?.offsite;
  const health = listing.data?.health;

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

  /** One action as a table row: what it does and how its last run went, then its button. */
  const row = (action: Action, title: string, text: string, label: string, extra?: ReactNode, unavailable = false) => {
    const last = latest(action);
    const state = last ? jobState(last.state) : null;
    return (
      <ActionRow
        key={action}
        title={title}
        detail={
          <>
            <p>{text}</p>
            {extra}
            {last && state && (
              <p className="flex items-center gap-1.5 text-xs">
                Last run {ago(last.created_at)}
                <span className="inline-flex items-center gap-1.5 text-fg">
                  <Dot tone={state.tone} />
                  {state.label}
                </span>
              </p>
            )}
            {problem?.action === action && <Notice tone="bad">{problem.text}</Notice>}
          </>
        }
      >
        <span className="inline-flex items-center justify-end gap-2">
          {last && isExport(last) && last.state === 'complete' && <DownloadButton job={last} />}
          {action === 'restore' ? (
            <Button size="sm" disabled={!!active || !backups.length} onClick={() => setRestoring(true)}>
              {label}
            </Button>
          ) : (
            <Button
              size="sm"
              busy={busy === action}
              disabled={!!busy || !!active || unavailable}
              onClick={() => ask(action)}
            >
              {label}
            </Button>
          )}
        </span>
      </ActionRow>
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
      <SubTabs
        label="Backups"
        value={tab}
        onChange={setTab}
        tabs={[
          {id: 'actions', label: 'Actions'},
          {id: 'history', label: 'History'},
        ]}
      />
      {tab === 'actions' && (
        <SubPanel id="actions" current={tab}>
          <Card className="overflow-hidden">
            <Table aria-label="Backup and maintenance actions" className="max-sm:block">
              <thead className="max-sm:sr-only">
                <tr>
                  <Th scope="col" className="w-52">
                    Action
                  </Th>
                  <Th scope="col">What it does</Th>
                  <Th scope="col">
                    <span className="sr-only">Start</span>
                  </Th>
                </tr>
              </thead>
              <tbody className="[&>tr:last-child>*]:border-b-0 max-sm:block">
                {row(
                  'backup',
                  'Back up now',
                  'Saves messages, files, settings and the assistant’s state on this machine, including keys. The SSH keys of your machines in Settings › Machines stay out.',
                  'Back up now',
                  <>
                    {schedule && (
                      <p className="text-xs">
                        {schedule.enabled
                          ? `Every day at ${schedule.time} (${schedule.time_zone.replace(/_/g, ' ')}), keeping the last ${schedule.keep}.` +
                            (schedule.next_at ? ` Next ${dateTime(schedule.next_at)}.` : '')
                          : 'Automatic backups are off.'}{' '}
                        {schedule.skipped === 'low_disk' && 'The last one was skipped: not enough free disk space. '}
                        <a
                          className="text-accent-text underline-offset-2 hover:underline"
                          href="#settings?view=privacy"
                        >
                          Change
                        </a>
                      </p>
                    )}
                    {schedule?.low_disk && (
                      <Notice tone="warn">
                        Free disk space is low. Back up now still runs, but the backup may fill the disk.
                      </Notice>
                    )}
                    <BackupHealthNotice health={health} />
                  </>,
                )}
                {row(
                  'restore',
                  'Restore a backup',
                  'Opens a saved backup as a separate, switched-off copy so you can check it. Your current Nocheh keeps running.',
                  'Restore…',
                  <p className="text-xs">
                    {listing.error && !listing.data
                      ? 'Saved backups couldn’t be listed.'
                      : !listing.data
                        ? 'Looking for saved backups…'
                        : backups.length
                          ? `${backups.length} saved · newest ${dateTime(backups[0]!.created_at)}`
                          : 'No backups saved yet.'}
                  </p>,
                )}
                {row(
                  'offsite',
                  'Off-site copy',
                  'Sends the newest backup to your own storage, encrypted on this machine first when you set a passphrase.',
                  'Send copy now',
                  offsite && (
                    <p className="text-xs">
                      {offsiteSummary(offsite, !!latest('offsite') && running(latest('offsite')!))}{' '}
                      <a className="text-accent-text underline-offset-2 hover:underline" href="#settings?view=privacy">
                        {offsite.enabled ? 'Change' : 'Set up'}
                      </a>
                    </p>
                  ),
                  !offsite?.enabled || !backups.length,
                )}
                {row(
                  'offsite-check',
                  'Test the off-site copy',
                  'Downloads the newest copy, opens it and checks every file. Nothing is restored.',
                  'Run test',
                  offsite?.enabled && <p className="text-xs">{checkSummary(offsite)}</p>,
                  !offsite?.enabled,
                )}
                {row(
                  'export',
                  'Export your archive',
                  'A ZIP of your original messages and files, to keep anywhere.',
                  'Prepare ZIP',
                )}
                {row(
                  'portable-export',
                  'Export archive and memory',
                  'Adds the assistant’s notes and chat history. Keys and passwords are left out.',
                  'Prepare ZIP',
                )}
                {row(
                  'diagnose',
                  'Check services',
                  'Looks at every service and reports problems. Changes nothing.',
                  'Run check',
                )}
                {row(
                  'restart',
                  'Restart Nocheh',
                  'Restarts the assistant and workers. Replies pause for about a minute.',
                  'Restart…',
                )}
              </tbody>
            </Table>
          </Card>
        </SubPanel>
      )}
      {tab === 'history' && (
        <SubPanel id="history" current={tab}>
          <JobHistory tasks={tasks} loading={!jobs.data && !jobs.error} />
        </SubPanel>
      )}
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

/** Why the latest backups didn't finish, and what a command made unreadable, with the entries they name. */
function BackupHealthNotice({health}: {health: BackupHealth | undefined}) {
  if (!health) return null;
  const paths = health.unreadable_paths ?? [];
  return (
    <>
      {health.failed > 0 && (
        <Notice
          tone="bad"
          title={
            health.failed === 1 ? 'The last backup didn’t finish' : `The last ${health.failed} backups didn’t finish`
          }
        >
          {operationError(health.reason ?? 'backup_failed')} Older backups are kept.
          {health.path && (
            <span className="mt-1 block break-all font-mono text-xs">
              {health.reason === 'backup_unsupported_link' ? 'Link: ' : 'At: '}
              {health.path}
            </span>
          )}
        </Notice>
      )}
      {health.unreadable > 0 && (
        <Notice tone="warn">
          The newest backup left out {count(health.unreadable)} {health.unreadable === 1 ? 'entry' : 'entries'} that a
          command made unreadable in its workspace. Make them readable again to back them up.
          {paths.map((path, index) => (
            <span key={index} className="mt-1 block break-all font-mono text-xs">
              {path}
            </span>
          ))}
          {health.unreadable > paths.length && (
            <span className="mt-1 block text-xs">…and {count(health.unreadable - paths.length)} more.</span>
          )}
        </Notice>
      )}
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

const HISTORY = 10;

function JobHistory({tasks, loading}: {tasks: Job[]; loading: boolean}) {
  const [page, setPage] = useState(0);
  const at = Math.min(page, Math.max(0, Math.ceil(tasks.length / HISTORY) - 1));
  return (
    <Card>
      <CardHeader
        title="History"
        description="Backups, exports, checks, restarts and settings changes being applied."
      />
      <div className="mt-3 border-t border-line">
        {loading ? (
          <LoadingRows rows={3} />
        ) : !tasks.length ? (
          <Empty icon={History} title="Nothing here yet">
            Tasks you start under Actions, and settings you apply, are listed here with their result.
          </Empty>
        ) : (
          <>
            <Table aria-label="History" className="max-sm:block">
              <thead className="max-sm:sr-only">
                <tr>
                  <Th scope="col">Task</Th>
                  <Th scope="col">Result</Th>
                  <Th scope="col">When</Th>
                  <Th scope="col">Status</Th>
                  <Th scope="col">
                    <span className="sr-only">Download</span>
                  </Th>
                </tr>
              </thead>
              <tbody className="max-sm:block">
                {tasks.slice(at * HISTORY, at * HISTORY + HISTORY).map(job => {
                  const state = jobState(job.state);
                  return (
                    <tr
                      key={job.id}
                      className="cursor-pointer hover:bg-subtle/60 max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:border-b max-sm:border-line max-sm:px-4 max-sm:py-2"
                      onClick={() => setParams({job: job.id})}
                    >
                      <Td className="max-sm:w-full max-sm:border-0 max-sm:p-0">
                        <button
                          type="button"
                          className="text-left font-medium hover:underline"
                          onClick={() => setParams({job: job.id})}
                        >
                          {taskName(job)}
                        </button>
                      </Td>
                      <Td className="text-[13px] text-muted max-sm:w-full max-sm:border-0 max-sm:p-0">
                        {jobOutcome(job)}
                      </Td>
                      <Td className="text-[13px] whitespace-nowrap text-muted max-sm:border-0 max-sm:p-0 max-sm:py-1">
                        <time dateTime={job.created_at} title={dateTime(job.created_at)}>
                          {ago(job.created_at)}
                        </time>
                      </Td>
                      <Td className="text-[13px] whitespace-nowrap max-sm:border-0 max-sm:p-0">
                        <span className="inline-flex items-center gap-1.5">
                          <Dot tone={state.tone} />
                          {state.label}
                        </span>
                      </Td>
                      <Td className="py-1.5 text-right whitespace-nowrap max-sm:ml-auto max-sm:border-0 max-sm:p-0">
                        {isExport(job) && job.state === 'complete' && <DownloadButton job={job} />}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <Pager
              page={at}
              hasNext={(at + 1) * HISTORY < tasks.length}
              onPage={setPage}
              summary={`${count(tasks.length)} ${tasks.length === 1 ? 'task' : 'tasks'} · open one for its details`}
            />
          </>
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

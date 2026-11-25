/**
 * Schedules: every chat's schedules, set by asking in a chat, in one table (ADR-0266, ADR-0290). Each row can be paused,
 * resumed, run now or deleted, each press with Nocheh's grant for it; one Nocheh did not save shows as not running and can
 * only be deleted. The same page is a tab of the mini app.
 */
import * as React from 'react';
import {CalendarClock, History, Pause, Play, PlayCircle, Trash2} from 'lucide-react';
import {apiPost} from '../lib/api';
import {problemText} from '../lib/messages-format';
import {refreshResources, useResource} from '../lib/resource';
import {scheduleRowId} from '../lib/search';
import {ago, dateTime, duration} from '../lib/system-format';
import {Badge, Button, Card, Empty, LoadError, LoadingRows, Table, Td, Th, type Tone} from '../ui/core';
import {useFeedback} from '../ui/overlay';
import {Page} from '../ui/page';
import {LinkButton} from '../ui/link-button';
import {href} from '../lib/routes';
import {zoneName} from './settings/general';

export type Schedule = {
  id: string;
  profile: string;
  scope: string;
  name: string;
  schedule: string;
  timezone: string | null;
  enabled: boolean;
  state: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_delivery_error: string | null;
  running: boolean;
  pending: boolean;
  set_in_chat: boolean;
  /** False when Nocheh did not save its last change: it does not run until it is set again by asking (ADR-0290). */
  saved?: boolean;
  owner_chat: boolean;
  member_chat?: boolean;
  chat_title: string | null;
};
type Operation = 'pause' | 'resume' | 'run' | 'delete';
/** One run in a schedule's log: when, timed or Run now, and how it ended; never what it said. */
export type ScheduleRun = {
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger: 'timed' | 'run_now' | 'catch_up';
  result: string;
  error_code: string | null;
};

/** How a run ended, in a word, with its tone. */
export function runResult(run: Pick<ScheduleRun, 'result'>): {label: string; tone: Tone} {
  return (
    (
      {
        running: {label: 'Running', tone: 'info'},
        sent: {label: 'Sent', tone: 'good'},
        nothing_new: {label: 'Nothing new', tone: 'neutral'},
        waiting: {label: 'Waiting for your yes', tone: 'info'},
        sending: {label: 'Sending', tone: 'info'},
        declined: {label: 'Declined', tone: 'neutral'},
        kept: {label: 'Kept in Nocheh', tone: 'neutral'},
        not_sent: {label: 'Not sent', tone: 'warn'},
        skipped: {label: 'Skipped', tone: 'warn'},
        stopped: {label: 'Stopped', tone: 'neutral'},
        failed: {label: 'Failed', tone: 'bad'},
      } as Record<string, {label: string; tone: Tone}>
    )[run.result] ?? {label: 'Unknown', tone: 'neutral'}
  );
}
const runTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const triggers: Record<ScheduleRun['trigger'], string> = {timed: 'Timed', run_now: 'Run now', catch_up: 'Catch-up'};

/** Where a schedule's results go, as the owner sees it. */
export function scheduleChat(row: Pick<Schedule, 'owner_chat' | 'member_chat' | 'chat_title'>): string {
  if (row.owner_chat) return 'Your private chat';
  if (row.member_chat) return `Private chat of ${row.chat_title ?? 'a member'}`;
  return row.chat_title ?? 'A group';
}

/** How the last run went, in a word, with its tone. */
export function lastResult(row: Schedule): {label: string; tone: Tone} {
  if (row.running) return {label: 'Running', tone: 'info'};
  if (row.pending) return {label: 'Starting', tone: 'info'};
  if (!row.last_run_at && !row.last_status) return {label: 'Not run yet', tone: 'neutral'};
  if (row.last_status === 'skipped') return {label: 'Skipped', tone: 'warn'};
  if (row.last_status === 'error') return {label: 'Failed', tone: 'bad'};
  if (row.last_delivery_error) return {label: 'Not sent', tone: 'warn'};
  return {label: 'Done', tone: 'good'};
}

/** When a schedule runs next: its time, or why it does not. */
function nextRun(row: Schedule): string {
  if (row.saved === false && row.state !== 'completed') return 'Not running: ask again to set it';
  if (!row.enabled) return row.state === 'completed' ? 'Finished' : 'Paused';
  return row.next_run_at ? dateTime(row.next_run_at) : '—';
}

export default function Schedules({settingsLink = true}: {settingsLink?: boolean}) {
  // While a run starts or runs, the page follows it every two seconds, so its result shows without a reload.
  const [poll, setPoll] = React.useState(15000);
  const {data, error} = useResource<{schedules: Schedule[]}>('/schedules', poll);
  const rows = data?.schedules ?? [];
  const active = rows.some(row => row.running || row.pending);
  React.useEffect(() => setPoll(active ? 2000 : 15000), [active]);
  return (
    <Page
      title="Schedules"
      description="Things Nocheh does at a set time. Ask in your private chat to add one. Your private chat's results come with no card; a group's wait for your yes."
    >
      <OwnerTimeZone settingsLink={settingsLink} />
      <Card>
        {error ? (
          <div className="p-5">
            <LoadError what="the schedules" />
          </div>
        ) : !data ? (
          <LoadingRows rows={4} />
        ) : !rows.length ? (
          <Empty icon={CalendarClock} title="No schedules yet">
            Ask in your private chat, for example “every weekday at 8, send me a short brief”.
          </Empty>
        ) : (
          <Table aria-label="Schedules">
            <thead>
              <tr>
                <Th scope="col">Name</Th>
                <Th scope="col" className="hidden md:table-cell">
                  Chat
                </Th>
                <Th scope="col" className="hidden sm:table-cell">
                  When
                </Th>
                <Th scope="col" className="hidden sm:table-cell">
                  Next run
                </Th>
                <Th scope="col" className="hidden sm:table-cell">
                  Last result
                </Th>
                <Th scope="col">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <ScheduleRow key={row.profile + ':' + row.id} row={row} />
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}

/**
 * The owner's time zone, read only: it is set once in Settings › General (ADR-0311), and new schedules set in the owner's
 * private chat run in it. Schedules already set keep theirs. The mini app has no settings, so it names where to change it.
 */
function OwnerTimeZone({settingsLink}: {settingsLink: boolean}) {
  const {data} = useResource<{time_zone: string}>('/tasks/settings');
  const value = data?.time_zone;
  if (!value) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
      <span>
        New schedules run in your time zone, <span className="font-medium text-fg">{zoneName(value)}</span>.
        {!settingsLink && ' Change it in the dashboard’s Settings › General, or tell Nocheh in your private chat.'}
      </span>
      {settingsLink && (
        <LinkButton href={href('settings', {view: 'general'})} variant="ghost">
          Change in Settings › General
        </LinkButton>
      )}
    </p>
  );
}

function ScheduleRow({row}: {row: Schedule}) {
  const feedback = useFeedback();
  const [busy, setBusy] = React.useState<Operation | null>(null);
  const [log, setLog] = React.useState(false);
  const result = lastResult(row);
  const act = async (operation: Operation) => {
    if (
      operation === 'delete' &&
      !(await feedback.confirm({
        title: `Delete “${row.name || 'this schedule'}”?`,
        body: 'It stops running. This can’t be undone.',
        confirm: 'Delete',
        danger: true,
      }))
    )
      return;
    setBusy(operation);
    try {
      await apiPost('/schedules', {
        operation,
        profile: row.profile,
        job_id: row.id,
        request_id: crypto.randomUUID().replaceAll('-', ''),
      });
      feedback.toast(
        {pause: 'Paused.', resume: 'Resumed.', run: 'Running now. The result comes to its chat.', delete: 'Deleted.'}[
          operation
        ],
      );
      await refreshResources();
    } catch (failure) {
      feedback.toast(problemText(failure), 'bad');
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <tr id={scheduleRowId(row)}>
        <Td>
          <div className="font-medium" dir="auto">
            {row.name || 'Unnamed schedule'}
          </div>
          <div className="text-xs text-muted md:hidden">{scheduleChat(row)}</div>
          <div className="text-xs text-muted sm:hidden">Next: {nextRun(row)}</div>
        </Td>
        <Td className="hidden md:table-cell" dir="auto">
          {scheduleChat(row)}
        </Td>
        <Td className="hidden whitespace-nowrap sm:table-cell">
          {row.schedule || '—'}
          {row.timezone && <span className="text-muted"> · {row.timezone}</span>}
        </Td>
        <Td className="hidden whitespace-nowrap sm:table-cell">{nextRun(row)}</Td>
        <Td className="hidden whitespace-nowrap sm:table-cell">
          <span className="inline-flex items-center gap-2">
            <Badge tone={result.tone} dot title={row.last_run_at ? dateTime(row.last_run_at) : undefined}>
              {result.label}
            </Badge>
            {/* The time is the last finished run's; a run under way has none yet. */}
            {row.last_run_at && !row.running && !row.pending && (
              <span className="text-xs text-muted">{ago(row.last_run_at)}</span>
            )}
          </span>
        </Td>
        <Td className="whitespace-nowrap text-right">
          <div className="inline-flex gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setLog(open => !open)}
              aria-label="Runs"
              aria-expanded={log}
              title="Runs"
            >
              <History aria-hidden />
            </Button>
            {row.state !== 'completed' && row.saved !== false && (
              <Button
                size="icon-sm"
                variant="ghost"
                busy={busy === (row.enabled ? 'pause' : 'resume')}
                disabled={!!busy}
                onClick={() => act(row.enabled ? 'pause' : 'resume')}
                aria-label={row.enabled ? 'Pause' : 'Resume'}
                title={row.enabled ? 'Pause' : 'Resume'}
              >
                {row.enabled ? <Pause aria-hidden /> : <Play aria-hidden />}
              </Button>
            )}
            <Button
              size="icon-sm"
              variant="ghost"
              busy={busy === 'run'}
              disabled={!!busy || row.running || row.pending || row.saved === false}
              onClick={() => act('run')}
              aria-label="Run now"
              title="Run now"
            >
              <PlayCircle aria-hidden />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              busy={busy === 'delete'}
              disabled={!!busy}
              onClick={() => act('delete')}
              aria-label="Delete"
              title="Delete"
            >
              <Trash2 aria-hidden />
            </Button>
          </div>
        </Td>
      </tr>
      {log && (
        <tr>
          <td colSpan={6} className="bg-subtle/60 px-2 py-2 sm:px-4">
            <ScheduleRuns row={row} />
          </td>
        </tr>
      )}
    </>
  );
}

/** A schedule's runs, newest first, followed live while one runs. */
function ScheduleRuns({row}: {row: Schedule}) {
  const query = new URLSearchParams({scope: row.scope, job_id: row.id}).toString();
  const {data, error} = useResource<{runs: ScheduleRun[]}>(
    '/schedules/runs?' + query,
    row.running || row.pending ? 2000 : 15000,
  );
  if (error) return <LoadError what="the runs" />;
  if (!data) return <LoadingRows rows={2} />;
  if (!data.runs.length) return <p className="py-1 text-sm text-muted">No runs yet.</p>;
  return (
    <Table aria-label={`Runs of ${row.name || 'this schedule'}`}>
      <thead>
        <tr>
          <Th scope="col">Started</Th>
          <Th scope="col" className="hidden sm:table-cell">
            How
          </Th>
          <Th scope="col">Result</Th>
          <Th scope="col" className="hidden sm:table-cell">
            Took
          </Th>
        </tr>
      </thead>
      <tbody>
        {data.runs.map(run => {
          const result = runResult(run);
          return (
            <tr key={run.id}>
              <Td className="whitespace-nowrap" title={dateTime(run.started_at)}>
                {runTime.format(new Date(run.started_at))}
                <div className="text-xs text-muted sm:hidden">{triggers[run.trigger] ?? run.trigger}</div>
              </Td>
              <Td className="hidden whitespace-nowrap sm:table-cell">{triggers[run.trigger] ?? run.trigger}</Td>
              <Td className="whitespace-nowrap">
                <Badge tone={result.tone} dot title={run.error_code ?? undefined}>
                  {result.label}
                </Badge>
              </Td>
              <Td className="hidden whitespace-nowrap sm:table-cell">
                {run.finished_at ? duration(Date.parse(run.finished_at) - Date.parse(run.started_at)) : '—'}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

/**
 * Schedules: every chat's schedules, set by asking in your private chat or from the command line, in one table (ADR-0266).
 * Each row can be paused, resumed, run now or deleted. The same page is a tab of the mini app.
 */
import * as React from 'react';
import {CalendarClock, Pause, Play, PlayCircle, Trash2} from 'lucide-react';
import {apiPost} from '../lib/api';
import {problemText} from '../lib/messages-format';
import {refreshResources, useResource} from '../lib/resource';
import {ago, dateTime} from '../lib/system-format';
import {Badge, Button, Card, Empty, LoadError, LoadingRows, Table, Td, Th, type Tone} from '../ui/core';
import {useFeedback} from '../ui/overlay';
import {Page} from '../ui/page';

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
  owner_chat: boolean;
  chat_title: string | null;
};
type Operation = 'pause' | 'resume' | 'run' | 'delete';

/** Where a schedule's results go, as the owner sees it. */
export function scheduleChat(row: Pick<Schedule, 'owner_chat' | 'chat_title'>): string {
  return row.owner_chat ? 'Your private chat' : (row.chat_title ?? 'A group');
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
  if (!row.enabled) return row.state === 'completed' ? 'Finished' : 'Paused';
  return row.next_run_at ? dateTime(row.next_run_at) : '—';
}

export default function Schedules() {
  const {data, error} = useResource<{schedules: Schedule[]}>('/schedules', 15000);
  const rows = data?.schedules ?? [];
  return (
    <Page
      title="Schedules"
      description="Things Nocheh does at a set time. Ask in your private chat to add one. Your private chat's results come with no card; a group's wait for your yes."
    >
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

function ScheduleRow({row}: {row: Schedule}) {
  const feedback = useFeedback();
  const [busy, setBusy] = React.useState<Operation | null>(null);
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
    <tr>
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
          {row.last_run_at && <span className="text-xs text-muted">{ago(row.last_run_at)}</span>}
        </span>
      </Td>
      <Td className="whitespace-nowrap text-right">
        <div className="inline-flex gap-1">
          {row.state !== 'completed' && (
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
            disabled={!!busy || row.running || row.pending}
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
  );
}

/**
 * Background jobs: long work the agent proposed and someone approved, such as
 * reading a whole chat. Shown live with each job's to-do list, with Stop; and
 * the owner's limits for them, saved with the Save button at the top.
 */
import {useState} from 'react';
import {Check, Circle, CircleDot, Square} from 'lucide-react';
import {apiPost, type ApiError} from '../../lib/api';
import {useDraftSource} from '../../lib/drafts';
import {refreshResources, useResource} from '../../lib/resource';
import {ago, dateTime} from '../../lib/system-format';
import {Badge, Button, Card, CardHeader, Field, Input, LoadError, LoadingRows, type Tone} from '../../ui/core';
import {useFeedback} from '../../ui/overlay';
import {useChatNames} from '../messages/chat-names';

type Todo = {content: string; status: string};
export type Job = {
  id: string;
  title: string | null;
  state: string;
  chat: string;
  asked_in: string;
  steps: number;
  cost_usd: number;
  cost_limit_usd: number;
  minutes_limit: number;
  estimate: {minutes?: number; cost_usd?: number | null; messages?: number};
  todo: Todo[];
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  error_code: string | null;
};
type Limits = {cost_limit_usd: number; minutes_limit: number; member_daily_jobs: number; revision: number};

export const jobStates: Record<string, [string, Tone]> = {
  proposed: ['Waiting for approval', 'info'],
  approved: ['Approved, starting', 'info'],
  running: ['Running', 'accent'],
  reporting: ['Sending the report', 'accent'],
  stopping: ['Stopping', 'warn'],
  done: ['Done', 'good'],
  stopped: ['Stopped', 'neutral'],
  rejected: ['Rejected', 'neutral'],
  failed: ['Failed', 'bad'],
};
const open = new Set(['proposed', 'approved', 'running', 'reporting']);
const money = (value: number) => '$' + (value < 10 ? value.toFixed(2) : value.toFixed(0));

/** What a job has done and what it may still spend, in one line. */
export function jobProgress(job: Job): string {
  const done = job.todo.filter(item => item.status === 'completed').length;
  return [
    job.steps === 1 ? '1 step' : `${job.steps} steps`,
    job.todo.length ? `${done} of ${job.todo.length} to-dos done` : null,
    `${money(job.cost_usd)} of ${money(job.cost_limit_usd)}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

function TodoList({items}: {items: Todo[]}) {
  if (!items.length) return null;
  return (
    <ul className="mt-2 space-y-1 text-[13px]" aria-label="To-do list">
      {items.slice(0, 12).map((item, index) => (
        <li key={index} className="flex items-start gap-2">
          {item.status === 'completed' ? (
            <Check aria-label="Done" className="mt-0.5 size-3.5 shrink-0 text-good" />
          ) : item.status === 'in_progress' ? (
            <CircleDot aria-label="In progress" className="mt-0.5 size-3.5 shrink-0 text-accent-text" />
          ) : (
            <Circle aria-label="Not started" className="mt-0.5 size-3.5 shrink-0 text-muted" />
          )}
          <span dir="auto" className={item.status === 'completed' ? 'text-muted line-through' : undefined}>
            {item.content}
          </span>
        </li>
      ))}
      {items.length > 12 && <li className="text-muted">and {items.length - 12} more</li>}
    </ul>
  );
}

export function BackgroundJobs() {
  const jobs = useResource<{jobs: Job[]}>('/background-jobs', 5000);
  const chatName = useChatNames();
  const {confirm, toast} = useFeedback();
  const [busy, setBusy] = useState('');
  const stop = async (job: Job) => {
    const ok = await confirm({
      title: 'Stop this job?',
      body: 'The step that is running is cancelled and no report is sent. What it already spent stays spent.',
      confirm: 'Stop',
      danger: true,
    });
    if (!ok) return;
    setBusy(job.id);
    try {
      await apiPost(`/background-jobs/${job.id}/stop`, {});
      toast('Stopping the job.');
      await refreshResources();
    } catch {
      toast('Couldn’t stop the job. It may have finished already.', 'bad');
    } finally {
      setBusy('');
    }
  };
  const list = jobs.data?.jobs ?? [];
  return (
    <Card>
      <CardHeader
        title="Background jobs"
        description="Long work the assistant asked to do, such as reading a whole chat. Each one runs after Approve on its card in Telegram and sends its report to the chat where it was asked."
      />
      <div className="mt-3 border-t border-line">
        {jobs.error && !jobs.data ? (
          <LoadError what="background jobs" className="m-5" onRetry={() => void refreshResources()} />
        ) : !jobs.data ? (
          <LoadingRows rows={2} />
        ) : !list.length ? (
          <p className="px-5 py-4 text-[13px] text-muted">
            No jobs yet. When you ask for something big in Telegram, the assistant offers a job with its time and cost.
          </p>
        ) : (
          <ul className="divide-y divide-line" aria-label="Background jobs">
            {list.map(job => {
              const [label, tone] = jobStates[job.state] ?? [job.state, 'neutral'];
              return (
                <li key={job.id} className="px-5 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium" dir="auto">
                        {job.title ?? 'Job'}
                      </p>
                      <p className="text-xs text-muted">
                        {chatName(job.chat)}
                        {job.asked_in !== job.chat ? ` · asked in ${chatName(job.asked_in)}` : ''} ·{' '}
                        {job.finished_at
                          ? `ended ${ago(job.finished_at)}`
                          : job.started_at
                            ? `started ${ago(job.started_at)}`
                            : `asked ${ago(job.created_at)}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={tone} dot>
                        {label}
                      </Badge>
                      {open.has(job.state) && (
                        <Button size="sm" variant="danger" busy={busy === job.id} onClick={() => void stop(job)}>
                          <Square aria-hidden /> Stop
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className="mt-1 text-[13px] text-muted" title={dateTime(job.created_at)}>
                    {jobProgress(job)}
                    {job.state === 'failed' && job.error_code ? ` · ${job.error_code.replaceAll('_', ' ')}` : ''}
                  </p>
                  {(open.has(job.state) || job.state === 'stopping') && <TodoList items={job.todo} />}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

const fields: {
  key: keyof Omit<Limits, 'revision'>;
  title: string;
  hint: string;
  min: number;
  max: number;
  step: number;
}[] = [
  {
    key: 'cost_limit_usd',
    title: 'Cost limit per job (US dollars)',
    hint: 'A job stops and reports at this cost. A member’s job estimated above it waits for your approval.',
    min: 0.5,
    max: 1000,
    step: 0.5,
  },
  {
    key: 'minutes_limit',
    title: 'Time limit per job (minutes)',
    hint: 'A job stops and reports after this long.',
    min: 5,
    max: 1440,
    step: 5,
  },
  {
    key: 'member_daily_jobs',
    title: 'Jobs a member may start each day',
    hint: 'In each group. You have no daily limit.',
    min: 0,
    max: 100,
    step: 1,
  },
];

export function BackgroundJobLimits() {
  const saved = useResource<Limits>('/background-jobs/settings');
  const [draft, setDraft] = useState<Partial<Limits>>({});
  const [revision, setRevision] = useState<number | null>(null);
  const data = saved.data;
  const value = (key: keyof Limits) => draft[key] ?? data?.[key];
  const edit = (key: keyof Limits, next: number) => {
    setRevision(current => current ?? data?.revision ?? null);
    setDraft(current => {
      const changed = {...current, [key]: next};
      if (data && next === data[key]) delete changed[key];
      return changed;
    });
  };
  const reset = () => {
    setDraft({});
    setRevision(null);
  };
  useDraftSource({
    id: 'background-job-limits',
    labels: Object.keys(draft).length ? ['Background job limits'] : [],
    save: async () => {
      if (!data) return;
      const body = {
        cost_limit_usd: Number(value('cost_limit_usd')),
        minutes_limit: Number(value('minutes_limit')),
        member_daily_jobs: Number(value('member_daily_jobs')),
        revision: revision ?? data.revision,
      };
      if (fields.some(field => !(body[field.key] >= field.min && body[field.key] <= field.max)))
        throw new Error('Keep each job limit within its range, then save again.');
      try {
        await apiPost('/background-jobs/settings', body);
        reset();
        await refreshResources();
      } catch (e) {
        throw new Error(
          /conflict|changed/.test((e as ApiError)?.message ?? '')
            ? 'Job limits were changed somewhere else. Your edits are kept; check them and save again.'
            : 'Couldn’t save the job limits.',
        );
      }
    },
    discard: reset,
  });
  return (
    <Card>
      <CardHeader
        title="Background jobs"
        description="Limits for long work the assistant runs after Approve, such as reading a whole chat. A job approved with a higher estimate gets half again over its estimate."
      />
      <div className="mt-3 border-t border-line">
        {saved.error && !data ? (
          <LoadError what="the job limits" className="m-5" onRetry={() => void refreshResources()} />
        ) : !data ? (
          <LoadingRows rows={3} />
        ) : (
          <div className="grid gap-4 px-5 py-4 sm:grid-cols-3">
            {fields.map(field => (
              <Field key={field.key} label={field.title} hint={field.hint} htmlFor={'job-' + field.key}>
                <Input
                  id={'job-' + field.key}
                  type="number"
                  inputMode="decimal"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={String(value(field.key) ?? '')}
                  onChange={e => edit(field.key, Number(e.target.value))}
                />
              </Field>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

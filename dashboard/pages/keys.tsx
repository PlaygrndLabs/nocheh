/**
 * Keys (ADR-0307): each person's keys, the owner first and then each member, on or paused, with how many are open and
 * when one was last used; and "Stop everything now", which ends every key and everything waiting on one, then gives the
 * agent a new login. A member's pause stays on the Members page.
 */
import {useEffect, useState} from 'react';
import {KeyRound, OctagonX} from 'lucide-react';
import type {KeyList, KeyPerson, KeyStopCounts, KeyStopResult} from '../../src/key-wire';
import {apiGet, apiPost, type ApiError} from '../lib/api';
import {refreshResources, useResource} from '../lib/resource';
import {followJob, type ApplyJob, type ApplyOutcome} from '../lib/settings';
import {ago, dateTime} from '../lib/system-format';
import {Button, Card, Dot, Empty, LoadError, LoadingRows, Notice, Table, Td, Th} from '../ui/core';
import {useFeedback} from '../ui/overlay';
import {Page} from '../ui/page';
import {elapsed} from '../ui/save-bar';
import {handle} from './members/model';
import {memberHref} from './members/hooks';

/** The name a person shows by: "You" for the owner; a member's name, @username, or "Member". */
function personName(person: KeyPerson): string {
  if (person.person === 'owner') return 'You';
  return person.name?.trim() || handle(person.username) || 'Member';
}

const plural = (count: number, one: string, many = one + 's') =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** "Last stopped 5 min ago: 3 keys, 1 card, 2 runs ended." Keys always show; other parts only when some ended. */
export function lastStopLine(stopped: {at: string} & KeyStopCounts): string {
  const parts = [
    plural(stopped.keys, 'key'),
    stopped.cards && plural(stopped.cards, 'card'),
    stopped.follow_ups && plural(stopped.follow_ups, 'follow-up'),
    stopped.jobs && plural(stopped.jobs, 'job'),
    stopped.runs && plural(stopped.runs, 'run'),
  ].filter(Boolean);
  return `Last stopped ${ago(stopped.at)}: ${parts.join(', ')} ended.`;
}

function People({list, loading}: {list: KeyList | null; loading: boolean}) {
  const people = list?.people ?? [];
  return (
    <Card>
      {loading && <LoadingRows rows={2} />}
      {list && !people.length && <Empty icon={KeyRound} title="No one has keys yet" />}
      {people.length > 0 && (
        <Table aria-label="People and their keys" className="max-sm:block [&>tbody]:max-sm:block">
          <thead className="max-sm:sr-only">
            <tr>
              <Th scope="col">Person</Th>
              <Th scope="col">State</Th>
              <Th scope="col">Open keys</Th>
              <Th scope="col">Last used</Th>
            </tr>
          </thead>
          <tbody>
            {people.map(person => {
              const name = personName(person);
              return (
                <tr
                  key={person.person}
                  className="hover:bg-subtle/60 max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-0.5 max-sm:border-b max-sm:border-line max-sm:px-4 max-sm:py-2.5 max-sm:[&>td]:border-0 max-sm:[&>td]:p-0"
                >
                  <Td className="max-w-0 sm:w-[35%] max-sm:w-full max-sm:max-w-none">
                    {person.person === 'owner' ? (
                      <span className="block truncate font-medium">{name}</span>
                    ) : (
                      <a
                        href={memberHref(person.person)}
                        className="block truncate font-medium hover:underline"
                        dir="auto"
                      >
                        {name}
                      </a>
                    )}
                  </Td>
                  <Td className="text-[13px] whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      <Dot tone={person.state === 'paused' ? 'warn' : 'good'} />
                      {person.state === 'paused' ? 'Paused' : 'On'}
                    </span>
                  </Td>
                  <Td className="tabular text-[13px] whitespace-nowrap">
                    {person.open.toLocaleString()}
                    <span className="sm:hidden"> open</span>
                  </Td>
                  <Td className="text-[13px] whitespace-nowrap text-muted">
                    {person.last_use ? (
                      <time dateTime={person.last_use} title={dateTime(person.last_use)}>
                        <span className="sm:hidden">Used </span>
                        {ago(person.last_use)}
                      </time>
                    ) : (
                      'Not in 30 days'
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

type Progress = {step: 'stopping' | 'login'; job?: string; started: number};

/** What a finished new login says: nothing when it worked, else a plain line. */
function loginProblem({job, ended}: ApplyOutcome): string | null {
  if (ended === 'finished' && job.state === 'complete') return null;
  if (ended === 'finished' && job.result?.status === 'apply_failed' && job.result?.rolled_back)
    return 'Keys were ended, but the services didn’t start with the new login, so the old login is back. Try again.';
  return 'Keys were ended, but the new login didn’t finish. Check System, then try again.';
}

/** A new agent login still running, for example after a reload or a lost answer; null when there is none. */
async function runningLogin(): Promise<ApplyJob | null> {
  try {
    const jobs = await apiGet<(ApplyJob & {kind?: string})[]>('/jobs');
    return jobs.find(job => job.kind === 'settings.agent_login' && ['running', 'queued'].includes(job.state)) ?? null;
  } catch {
    return null;
  }
}

// The login this page follows, so a second mount or a second press never follows it twice.
let followingLogin: string | null = null;

function StopEverything({stopped}: {stopped: KeyList['stopped']}) {
  const {confirm, toast} = useFeedback();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [problem, setProblem] = useState('');
  const [, tick] = useState(0);
  // The elapsed time counts up while the services restart, so the page visibly keeps working.
  useEffect(() => {
    if (progress?.step !== 'login') return;
    const timer = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(timer);
  }, [progress?.step]);

  /** Follows a new login to its end and says how it went. */
  const follow = async (job: ApplyJob) => {
    if (followingLogin === job.id) return;
    followingLogin = job.id;
    try {
      const started = Date.parse(job.created_at ?? '') || Date.now();
      setProgress({step: 'login', job: job.step, started});
      const outcome = await followJob(job, started, step => setProgress({step: 'login', job: step, started}));
      const failed = loginProblem(outcome);
      if (failed) setProblem(failed);
      else toast('Everything stopped. The agent has a new login.');
    } finally {
      followingLogin = null;
    }
  };

  // A login started before a reload keeps showing until it ends.
  useEffect(() => {
    let live = true;
    void runningLogin().then(async job => {
      if (!live || !job || followingLogin) return;
      setProblem('');
      try {
        await follow(job);
      } finally {
        setProgress(null);
        void refreshResources();
      }
    });
    return () => {
      live = false;
    };
  }, []);

  const stop = async () => {
    const ok = await confirm({
      title: 'Stop everything now?',
      body: 'Every key ends, and waiting cards, follow-ups, jobs and runs are cancelled. The agent then gets a new login, and services restart for about a minute.',
      confirm: 'Stop everything',
      danger: true,
    });
    if (!ok) return;
    setProblem('');
    setProgress({step: 'stopping', started: Date.now()});
    try {
      try {
        await apiPost<KeyStopResult>('/keys/stop', {operation_id: crypto.randomUUID()});
      } catch {
        setProblem('Stopping didn’t go through. Try again.');
        return;
      }
      let job: ApplyJob;
      try {
        job = await apiPost<ApplyJob>('/keys/agent-login', {});
      } catch (error) {
        // The login may have started although its answer was lost, or another tab may have started one.
        const running = await runningLogin();
        if (running) {
          job = running;
        } else {
          const code = (error as ApiError).message;
          setProblem(
            code === 'wait_for_active_jobs' || code === 'job_busy'
              ? 'Keys were ended, but another task, such as a backup, is running. Try again when it finishes.'
              : 'Keys were ended, but the new login didn’t start. Check System, then try again.',
          );
          return;
        }
      }
      await follow(job);
    } finally {
      setProgress(null);
      void refreshResources();
    }
  };

  const busy = progress !== null;
  const line =
    progress?.step === 'stopping'
      ? 'Ending keys…'
      : progress?.job === 'rolling_back'
        ? `Going back to the old login… ${elapsed(progress.started)}`
        : progress
          ? `Restarting services… ${elapsed(progress.started)}`
          : '';
  return (
    <Card className="border-bad/40 px-5 py-4">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-80">
          <h2 className="text-[15px] font-semibold">Stop everything now</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            Ends every key in use, cancels waiting approval cards, follow-ups, jobs and runs, then gives the agent a new
            login. Services restart for about a minute; new messages work again after that.
          </p>
        </div>
        <Button variant="danger" busy={busy} disabled={busy} onClick={() => void stop()}>
          <OctagonX aria-hidden /> Stop everything now
        </Button>
      </div>
      {line && (
        <p role="status" className="tabular mt-3 text-[13px] text-muted">
          {line}
        </p>
      )}
      {problem && !busy && (
        <Notice tone="bad" className="mt-3">
          {problem}
        </Notice>
      )}
      {stopped && (
        <p className="mt-3 text-xs text-muted" data-testid="keys-last-stop">
          <span title={dateTime(stopped.at)}>{lastStopLine(stopped)}</span>
        </p>
      )}
    </Card>
  );
}

export default function KeysPage() {
  const list = useResource<KeyList>('/keys', 30000);
  return (
    <Page
      title="Keys"
      description="Each reply or run gets its own key, which ends when it is done. Pausing a member ends their keys."
    >
      {list.error && !list.data && <LoadError what="keys" onRetry={() => void refreshResources()} />}
      <People list={list.data} loading={!list.data && !list.error} />
      <StopEverything stopped={list.data?.stopped ?? null} />
    </Page>
  );
}

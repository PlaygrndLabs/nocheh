/** Pure reading of `GET /monitoring`: work counts and the list of things that need a look. */
import type {Tone} from '../ui/core';
import {href} from './routes';
import {count, routeName, sendKinds, serviceName, telegramReason, telegramStates} from './system-format';

export type WorkCounts = {
  available: boolean;
  running: number;
  queued: number;
  waiting: number;
  retrying: number;
  failed: number;
  uncertain: number;
};

export function workCounts(health: any): WorkCounts {
  const available = !!health && !health.unavailable && Array.isArray(health.counts);
  const sum = (...states: string[]) =>
    available
      ? (health.counts as {state: string; count: number}[])
          .filter(row => states.includes(row.state))
          .reduce((n, row) => n + row.count, 0)
      : 0;
  return {
    available,
    running: sum('running'),
    queued: sum('queued'),
    waiting: sum('waiting'),
    retrying: sum('retryable_failed'),
    failed: sum('failed'),
    uncertain: sum('ambiguous'),
  };
}

/** Workers that should be connected (managed by the scheduler) and those that are. */
export function workers(health: any): {connected: number; total: number} {
  const list: any[] = Array.isArray(health?.workers) ? health.workers.filter((w: any) => w.owner !== 'legacy') : [];
  return {connected: list.filter(w => w.connected).length, total: list.length};
}

export type Issue = {tone: Tone; text: string; detail?: string; link?: string; action?: string};

/** One send as storage lists it: codes and ids only, never what was said. */
export type ChatSend = {
  id: string;
  at: string;
  channel: string;
  kind: string;
  method: string;
  chat: string | null;
  chat_title: string | null;
  topic: number | null;
  message_id: number | null;
  detail: string | null;
  state: string;
  status: number;
  error_code: string | null;
  reference: string | null;
  ms: number | null;
};
export type ChatSends = {
  window_hours: number;
  sent: number;
  failed: number;
  uncertain: number;
  not_sent: number;
  problems: number;
  problem_kinds: Record<string, number>;
  last_problem_at: string | null;
  latest_problems: ChatSend[];
};

/** The last day's sends to chat apps, from storage status; null when storage didn't answer. */
export function chatSends(m: any): ChatSends | null {
  const sends = m?.archive?.chat_sends;
  return sends && typeof sends.problems === 'number' ? sends : null;
}

export const sendSummary = (s: ChatSends): string =>
  `Last day: ${count(s.sent)} sent, ${count(s.failed)} failed, ${count(s.uncertain)} uncertain, ${count(s.not_sent)} not sent`;

/** Sends a chat app refused or never answered in the last day; expected no-ops don't count. */
export function sendIssue(m: any): (Issue & {link: string; action: string}) | null {
  const s = chatSends(m);
  if (!s?.problems) return null;
  const latest = Array.isArray(s.latest_problems) ? s.latest_problems : [];
  // Only uncertain ones may still have arrived, so they warn; a refusal is a failure.
  const failed = latest.length ? latest.some(row => row.state === 'failed') : s.failed > 0;
  return {
    tone: failed ? 'bad' : 'warn',
    text: `${s.problems} ${s.problems === 1 ? 'send' : 'sends'} to chat apps failed in the last day`,
    detail:
      Object.entries(s.problem_kinds ?? {})
        .map(([kind, n]) => `${sendKinds[kind] ?? kind}: ${n}`)
        .join(' · ') || undefined,
    link: href('system', {view: 'sends', filter: 'problems'}),
    action: 'Review',
  };
}

export function issues(m: any): Issue[] {
  if (!m) return [];
  const list: Issue[] = [];
  if (m.application?.ok === false || m.application?.unavailable)
    list.push({
      tone: 'bad',
      text: 'Nocheh’s main service isn’t answering',
      detail: 'Messages may not be saved or answered.',
    });
  const telegram = m.runtime?.status?.telegram;
  if (m.telegram_enabled && telegram && telegram !== 'connected') {
    const state = telegramStates[telegram];
    list.push({
      tone: 'bad',
      text: 'Telegram isn’t receiving messages',
      detail: telegramReason(m.runtime?.status?.telegram_details?.error_code) || state?.label,
      link: href('settings'),
      action: 'Telegram settings',
    });
  }
  const services: any[] = Array.isArray(m.services) ? m.services : [];
  const down = services.filter(s => s.state === 'unhealthy');
  if (down.length)
    list.push({
      tone: 'bad',
      text: down.length === 1 ? `${serviceName(down[0])} needs a look` : `${down.length} services need a look`,
      detail: down.length > 1 ? down.map(serviceName).join(', ') : 'It isn’t running as expected.',
    });
  const routes: any[] = Array.isArray(m.routes) ? m.routes : [];
  const missing = routes.filter(r => !r.configured);
  if (missing.length)
    list.push({
      tone: 'warn',
      text: `No model is set up for ${missing.map(r => routeName(r.part, r.label).toLowerCase()).join(', ')}`,
      detail: 'That work waits until a model is chosen.',
      link: href('settings', {view: 'models'}),
      action: 'Choose a model',
    });
  const work = workCounts(m.workflows);
  if (work.failed || work.retrying)
    list.push({
      tone: work.failed ? 'bad' : 'warn',
      text: `${work.failed + work.retrying} background ${work.failed + work.retrying === 1 ? 'task' : 'tasks'} failed`,
      detail: work.retrying ? `${work.retrying} will be retried automatically.` : undefined,
      link: href('system', {view: 'work', status: work.failed ? 'failed' : 'retryable_failed'}),
      action: 'Review',
    });
  if (work.uncertain)
    list.push({
      tone: 'warn',
      text: `${work.uncertain} ${work.uncertain === 1 ? 'task has' : 'tasks have'} an uncertain result`,
      detail: 'It may or may not have happened, so it won’t be repeated automatically.',
      link: href('system', {view: 'work', status: 'ambiguous'}),
      action: 'Review',
    });
  if (m.workflows?.unavailable)
    list.push({
      tone: 'warn',
      text: 'Background work couldn’t be checked',
      detail: 'Counts and failures are unknown right now.',
    });
  const team = workers(m.workflows);
  if (team.total && team.connected < team.total)
    list.push({
      tone: 'warn',
      text: `${team.total - team.connected} background ${team.total - team.connected === 1 ? 'worker isn’t' : 'workers aren’t'} connected`,
      detail: 'Their work waits until they reconnect.',
      link: href('system', {view: 'work'}),
      action: 'Details',
    });
  const models: any[] = Array.isArray(m.model_problems) ? m.model_problems : [];
  for (const row of models) {
    const failed = row.failed
      ? `${row.failed} model ${row.failed === 1 ? 'call' : 'calls'} failed today` +
        (row.why ? `: ${row.why}` : row.refused ? `, ${row.refused} refused by the model` : '')
      : '';
    const hidden = row.hidden
      ? `${row.hidden} ${row.hidden === 1 ? 'text was' : 'texts were'} hidden whole because the model refused to check ${row.hidden === 1 ? 'it' : 'them'}`
      : '';
    list.push({
      tone: 'warn',
      text: `${routeName(row.part, row.label)}: ${[failed, hidden].filter(Boolean).join('; ')}`,
      detail: `Model ${row.model}.${row.refused || row.hidden ? ' If it keeps refusing, choose another model for this part.' : ''}`,
      link: href('usage', {days: '1'}),
      action: 'Usage',
    });
  }
  const spool = m.archive?.archive?.spool_failures;
  if (Array.isArray(spool) && spool.length)
    list.push({
      tone: 'bad',
      text: `${spool.length} incoming messages couldn’t be saved`,
      detail: 'Run a service check in Backups.',
    });
  const sends = sendIssue(m);
  if (sends) list.push(sends);
  return list;
}

/** Home: is Nocheh working, what needs the owner, and a few numbers for today. */
import {AlertTriangle, ArrowRight, CheckCircle2, CircleDashed, XCircle} from 'lucide-react';
import {useResource} from '../lib/resource';
import {href} from '../lib/routes';
import {memoryAvailability} from '../lib/supervision';
import {cn} from '../lib/utils';
import {Card, CardHeader, LoadError, Skeleton, Stat, type Tone} from '../ui/core';
import {Page} from '../ui/page';

type Item = {tone: Tone; text: string; detail?: string; link: string; action: string};

const money = (value: number) =>
  value === 0 ? '$0' : value < 0.01 ? '<$0.01' : '$' + value.toFixed(value < 10 ? 2 : 0);

export default function Home() {
  const monitoring = useResource<any>('/monitoring', 15000);
  const status = useResource<any>('/status', 30000);
  const decisions = useResource<any>('/decisions?limit=1', 30000);
  const memory = useResource<any>('/memory/honcho', 30000);
  const usage = useResource<any>('/usage?days=1', 60000);

  const m = monitoring.data;
  const counts: {state: string; count: number}[] = m?.workflows?.counts ?? [];
  const sum = (...states: string[]) => counts.filter(c => states.includes(c.state)).reduce((n, c) => n + c.count, 0);
  const failed = sum('failed', 'retryable_failed');
  const uncertain = sum('ambiguous');
  const services: any[] = m?.services ?? [];
  const down = services.filter(s => s.expected_state === 'running' && !['running', 'healthy'].includes(s.state));
  const routes: any[] = m?.routes ?? [];
  const noModel = routes.length > 0 && routes.filter(r => r.part !== 'embedding').some(r => !r.configured);
  const telegram = m?.runtime?.status?.telegram;
  const waiting = decisions.data?.total ?? 0;
  const availability = memoryAvailability(memory.data, !!memory.error && !memory.data);

  const items: Item[] = [];
  if (m?.application?.ok === false)
    items.push({
      tone: 'bad',
      text: 'Nocheh isn’t answering',
      detail: 'Its main service is down.',
      link: href('system'),
      action: 'Check system',
    });
  if (noModel)
    items.push({
      tone: 'warn',
      text: 'No model is set up for every part',
      detail: 'Messages are kept and answered once a model is chosen.',
      link: href('settings', {view: 'models'}),
      action: 'Choose a model',
    });
  if (waiting)
    items.push({
      tone: 'warn',
      text: waiting === 1 ? '1 decision is waiting for you' : `${waiting} decisions are waiting for you`,
      link: href('inbox'),
      action: 'Open inbox',
    });
  if (down.length)
    items.push({
      tone: 'bad',
      text:
        down.length === 1
          ? `${down[0].purpose || down[0].service} isn’t running`
          : `${down.length} services aren’t running`,
      link: href('system'),
      action: 'Check system',
    });
  if (failed || uncertain)
    items.push({
      tone: failed ? 'bad' : 'warn',
      text: [failed && `${failed} background tasks failed`, uncertain && `${uncertain} have an uncertain result`]
        .filter(Boolean)
        .join(', '),
      link: href('system', {view: 'work'}),
      action: 'Review',
    });
  if (telegram === 'disabled')
    items.push({
      tone: 'neutral',
      text: 'Telegram is turned off',
      detail: 'Nocheh won’t receive or answer messages until it’s on.',
      link: href('settings'),
      action: 'Telegram settings',
    });
  if (memory.data && availability.state !== 'ready')
    items.push({
      tone: 'warn',
      text: availability.label,
      link: href('memory', {view: 'longterm'}),
      action: 'Open memory',
    });

  const loading = !m && !monitoring.error;
  const headline = loading
    ? null
    : monitoring.error && !m
      ? {
          tone: 'warn' as Tone,
          text: 'Status unavailable',
          detail: 'Nocheh’s status couldn’t be read. It may be restarting.',
        }
      : items.some(i => i.tone === 'bad')
        ? {tone: 'bad' as Tone, text: 'Something needs attention', detail: 'See below for what isn’t working.'}
        : items.length
          ? {tone: 'warn' as Tone, text: 'Nocheh is running', detail: 'A few things need you.'}
          : {tone: 'good' as Tone, text: 'Nocheh is running', detail: 'Everything is working and nothing needs you.'};

  const rows: any[] = usage.data?.rows ?? [];
  const cost = rows.reduce((n, r) => n + (r.cost_usd ?? 0), 0);
  const costKnown = rows.every(r => r.cost_complete !== false && r.cost_usd !== null);
  const replies = rows.filter(r => r.part === 'reply').reduce((n, r) => n + (r.calls ?? 0), 0);
  const HeadIcon = headline?.tone === 'good' ? CheckCircle2 : headline?.tone === 'bad' ? XCircle : AlertTriangle;

  return (
    <Page title="Home">
      <Card className="overflow-hidden">
        <div className="flex items-center gap-4 px-5 py-5">
          {headline ? (
            <>
              <span
                className={cn(
                  'grid size-11 shrink-0 place-items-center rounded-full',
                  headline.tone === 'good' && 'bg-good-soft text-good',
                  headline.tone === 'warn' && 'bg-warn-soft text-warn',
                  headline.tone === 'bad' && 'bg-bad-soft text-bad',
                )}
              >
                <HeadIcon className="size-6" aria-hidden />
              </span>
              <div>
                <p className="text-lg font-semibold">{headline.text}</p>
                <p className="text-sm text-muted">{headline.detail}</p>
              </div>
            </>
          ) : (
            <div className="w-full space-y-2">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-4 w-72" />
            </div>
          )}
        </div>
        {items.length > 0 && (
          <ul aria-label="What needs you" className="border-t border-line">
            {items.map(item => (
              <li key={item.text} className="border-b border-line last:border-b-0">
                <a href={item.link} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-subtle">
                  <span
                    aria-hidden
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      item.tone === 'bad' ? 'bg-bad' : item.tone === 'warn' ? 'bg-warn' : 'bg-muted',
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{item.text}</span>
                    {item.detail && <span className="block text-xs text-muted">{item.detail}</span>}
                  </span>
                  <span className="hidden shrink-0 items-center gap-1 text-[13px] font-medium text-accent-text sm:flex">
                    {item.action} <ArrowRight className="size-3.5" aria-hidden />
                  </span>
                  <ArrowRight className="size-4 shrink-0 text-muted sm:hidden" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        )}
        {decisions.error && !decisions.data && (
          <p className="flex items-center gap-2 border-t border-line px-5 py-3 text-xs text-muted">
            <CircleDashed className="size-3.5" aria-hidden /> Waiting decisions couldn’t be checked.{' '}
            <a className="font-medium text-accent-text hover:underline" href={href('inbox')}>
              Open inbox
            </a>
          </p>
        )}
      </Card>

      <div>
        <h2 className="mb-3 text-sm font-medium text-muted">Today</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label="Replies sent"
            value={usage.data ? replies.toLocaleString() : usage.error ? '—' : '…'}
            href={href('usage')}
          />
          <Stat
            label="Model cost"
            value={
              usage.data ? (costKnown ? money(cost) : rows.length ? money(cost) + '+' : '$0') : usage.error ? '—' : '…'
            }
            hint={usage.data && !costKnown ? 'Some calls can’t be priced' : undefined}
            href={href('usage')}
          />
          <Stat
            label="Messages kept"
            value={status.data ? Number(status.data.archive?.events ?? 0).toLocaleString() : status.error ? '—' : '…'}
            hint="All time"
            href={href('messages')}
          />
          <Stat
            label="Long-term memory"
            value={
              <span className="text-lg">
                {memory.data
                  ? availability.state === 'ready'
                    ? memory.data.syncing
                      ? 'Learning'
                      : 'Up to date'
                    : availability.state === 'disabled'
                      ? 'Off'
                      : 'Limited'
                  : memory.error
                    ? '—'
                    : '…'}
              </span>
            }
            hint={memory.data?.syncing ? 'Catching up on new messages' : undefined}
            href={href('memory', {view: 'longterm'})}
          />
        </div>
      </div>

      {monitoring.error && m && <LoadError what="the latest status" />}

      <Card>
        <CardHeader title="Where things are" description="Everything Nocheh keeps belongs to you." />
        <div className="grid gap-px overflow-hidden rounded-b-xl bg-line sm:grid-cols-3">
          {[
            {title: 'Chats', text: 'Turn Nocheh on in a group and choose who can talk to it.', link: href('chats')},
            {title: 'Messages', text: 'Search every message, and import old Telegram history.', link: href('messages')},
            {title: 'Memory', text: 'See and correct what Nocheh has learned.', link: href('memory')},
          ].map(card => (
            <a
              key={card.title}
              href={card.link}
              className="mt-px bg-surface px-5 py-4 transition-colors hover:bg-subtle"
            >
              <span className="flex items-center gap-1 text-sm font-medium">
                {card.title} <ArrowRight className="size-3.5 text-muted" aria-hidden />
              </span>
              <span className="mt-0.5 block text-[13px] text-muted">{card.text}</span>
            </a>
          ))}
        </div>
      </Card>
    </Page>
  );
}

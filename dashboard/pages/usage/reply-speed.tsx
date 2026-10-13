/**
 * Reply speed: how long replies take and where the time goes, split into
 * Nocheh's own work, waiting in line, outside services and the model. Stages of
 * one reply never overlap; time nothing explains is shown as not measured.
 */
import {useState} from 'react';
import {ArrowUpRight, Timer} from 'lucide-react';
import {useParam} from '../../lib/navigation';
import {useResource} from '../../lib/resource';
import {href, setParams} from '../../lib/routes';
import {dateTime, duration, stageName, timingCategories, timingCategory} from '../../lib/system-format';
import {cn} from '../../lib/utils';
import {Badge, Button, Card, CardHeader, Empty, LoadError, LoadingRows, Notice, Table, Td, Th} from '../../ui/core';
import {Drawer} from '../../ui/overlay';
import {LinkButton} from '../../ui/link-button';

type Stage = {stage: string; label: string; category: string; messages: number; ms_p50: number; ms_p95: number};
export type TimingSummary = {
  observed_at: string;
  messages: number;
  reply_ms_p50: number | null;
  reply_ms_p95: number | null;
  stages: Stage[];
  recent: {
    event_id: string;
    started_at: string | null;
    reply_ms: number | null;
    unmeasured_ms: number | null;
    complete?: boolean;
  }[];
};
type Breakdown = {
  event_id: string;
  started_at: string | null;
  reply_ms: number | null;
  complete: boolean;
  attempts: number;
  unmeasured_ms: number | null;
  stages: {stage: string; label: string; category: string; ms: number; calls: number}[];
};

const ORDER = ['internal', 'workflow', 'third_party', 'llm', 'unmeasured'];

/** A bar split by kind of time, with a legend underneath. */
function SplitBar({parts, label}: {parts: {category: string; ms: number}[]; label: string}) {
  const totals = ORDER.map(category => ({
    category,
    ms: parts.filter(p => p.category === category).reduce((n, p) => n + p.ms, 0),
  })).filter(p => p.ms > 0);
  const sum = totals.reduce((n, p) => n + p.ms, 0);
  if (!sum) return null;
  return (
    <div>
      <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label={label}>
        {totals.map(part => (
          <div
            key={part.category}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{width: `${(100 * part.ms) / sum}%`, background: timingCategory(part.category).color, minWidth: 3}}
          />
        ))}
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {totals.map(part => (
          <li key={part.category} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2.5 rounded-sm"
              style={{background: timingCategory(part.category).color}}
            />
            <span>{timingCategory(part.category).label}</span>
            <span className="tabular text-muted">
              {duration(part.ms)} · {Math.round((100 * part.ms) / sum)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const Kind = ({category}: {category: string}) => {
  const kind = timingCategory(category);
  return <Badge tone={kind.tone}>{kind.label}</Badge>;
};

export function ReplySpeed({summary, error}: {summary: TimingSummary | null; error: boolean}) {
  const selected = useParam('reply');
  const [all, setAll] = useState(false);
  const recent = summary?.recent ?? [];
  const shown = all ? recent : recent.slice(0, 8);
  return (
    <Card>
      <CardHeader
        title="Reply speed"
        description={
          summary?.messages
            ? `Across the last ${summary.messages} replies, from the message arriving to the reply being sent.`
            : 'From a message arriving to the reply being sent.'
        }
      />
      <div className="mt-3">
        {error && !summary ? (
          <div className="px-5 pb-5">
            <LoadError what="reply timing" />
          </div>
        ) : !summary ? (
          <LoadingRows rows={3} />
        ) : !summary.messages && !recent.length ? (
          <Empty icon={Timer} title="No replies measured yet">
            Timing appears here after Nocheh answers a message in Telegram.
          </Empty>
        ) : (
          <>
            <div className="grid gap-4 px-5 pb-4 sm:grid-cols-[auto_1fr] sm:gap-8">
              <dl className="flex gap-6">
                <div>
                  <dt className="text-[13px] text-muted">Typical</dt>
                  <dd className="tabular text-2xl font-semibold tracking-tight">{duration(summary.reply_ms_p50)}</dd>
                </div>
                <div>
                  <dt className="text-[13px] text-muted">Slow replies</dt>
                  <dd className="tabular text-2xl font-semibold tracking-tight">{duration(summary.reply_ms_p95)}</dd>
                  <p className="text-xs text-muted">1 in 20 take longer</p>
                </div>
              </dl>
              <div className="min-w-0">
                <p className="mb-2 text-[13px] text-muted">Where a typical reply’s time goes</p>
                <SplitBar
                  label="Typical reply time by kind"
                  parts={summary.stages.map(stage => ({category: stage.category, ms: stage.ms_p50}))}
                />
              </div>
            </div>

            {summary.stages.length > 0 && (
              <Table aria-label="Reply time by stage">
                <thead>
                  <tr>
                    <Th scope="col">Stage</Th>
                    <Th scope="col" className="hidden sm:table-cell">
                      Kind
                    </Th>
                    <Th scope="col" className="text-right">
                      Typical
                    </Th>
                    <Th scope="col" className="text-right">
                      Slow
                    </Th>
                    <Th scope="col" className="hidden text-right sm:table-cell">
                      Replies
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {summary.stages.map(stage => (
                    <tr key={stage.stage}>
                      <Td className="sm:min-w-44">
                        {stageName(stage.stage)}
                        <span className="mt-1 block sm:hidden">
                          <Kind category={stage.category} />
                        </span>
                      </Td>
                      <Td className="hidden sm:table-cell">
                        <Kind category={stage.category} />
                      </Td>
                      <Td className="tabular text-right whitespace-nowrap">{duration(stage.ms_p50)}</Td>
                      <Td className="tabular text-right whitespace-nowrap">{duration(stage.ms_p95)}</Td>
                      <Td className="tabular hidden text-right text-muted sm:table-cell">{stage.messages}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <p className="px-5 pt-3 text-xs text-muted">
              {Object.entries(timingCategories)
                .filter(([id]) => id !== 'unmeasured')
                .map(([id, kind]) => `${kind.label}: ${kindNote[id]}`)
                .join(' · ')}
            </p>

            {recent.length > 0 && (
              <div className="mt-4 border-t border-line">
                <h3 className="px-5 pt-4 text-sm font-semibold">Recent replies</h3>
                <ul className="mt-2">
                  {shown.map(item => (
                    <li key={item.event_id}>
                      <button
                        type="button"
                        onClick={() => setParams({reply: item.event_id})}
                        className="flex w-full items-center gap-3 border-t border-line px-5 py-2.5 text-left text-sm first:border-t-0 hover:bg-subtle"
                      >
                        <span className="min-w-0 flex-1 truncate">{dateTime(item.started_at)}</span>
                        {item.complete === false && <Badge>Incomplete</Badge>}
                        <span
                          className={cn(
                            'tabular w-20 text-right font-medium',
                            slow(item.reply_ms, summary) && 'text-warn',
                          )}
                        >
                          {duration(item.reply_ms)}
                        </span>
                        <span aria-hidden className="text-muted">
                          ›
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {recent.length > 8 && (
                  <div className="px-5 py-3">
                    <Button variant="link" size="sm" onClick={() => setAll(!all)}>
                      {all ? 'Show fewer' : `Show all ${recent.length}`}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <ReplyDrawer id={selected} />
    </Card>
  );
}

const kindNote: Record<string, string> = {
  internal: 'Nocheh’s own work',
  workflow: 'waiting in line',
  third_party: 'Telegram, memory and transcription',
  llm: 'waiting for the model provider',
};

const slow = (ms: number | null, summary: TimingSummary) =>
  ms != null && summary.reply_ms_p95 != null && ms >= summary.reply_ms_p95;

function ReplyDrawer({id}: {id: string | null}) {
  const valid = !!id && /^[a-f0-9]{64}$/.test(id);
  const {data, error} = useResource<Breakdown>(valid ? '/workflows/timings/' + id : null);
  const max = Math.max(1, ...(data?.stages ?? []).map(stage => stage.ms));
  return (
    <Drawer
      open={!!id}
      onOpenChange={open => !open && setParams({reply: null})}
      title="Reply timing"
      description={data?.started_at ? dateTime(data.started_at) : undefined}
      footer={
        valid && (
          <LinkButton href={href('messages', {source: id})} variant="secondary">
            Open the message <ArrowUpRight aria-hidden />
          </LinkButton>
        )
      }
    >
      {!valid ? (
        <Notice tone="warn" title="This reply can’t be found">
          The link may be incomplete.
        </Notice>
      ) : error && !data ? (
        <LoadError what="this reply’s timing" />
      ) : !data ? (
        <LoadingRows rows={4} />
      ) : (
        <div className="space-y-5">
          <dl className="grid grid-cols-2 gap-4">
            <div>
              <dt className="text-[13px] text-muted">Reply time</dt>
              <dd className="tabular text-2xl font-semibold">{duration(data.reply_ms)}</dd>
            </div>
            <div>
              <dt className="text-[13px] text-muted">Attempts</dt>
              <dd className="tabular text-2xl font-semibold">{data.attempts}</dd>
            </div>
          </dl>
          {!data.complete && (
            <Notice tone="info">No delivery time was recorded, so this reply’s total may be short.</Notice>
          )}
          <SplitBar label="This reply’s time by kind" parts={data.stages} />
          {!data.stages.length ? (
            <p className="text-sm text-muted">No stage timing was recorded for this message.</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {data.stages.map(stage => (
                <li key={stage.stage} className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 text-sm">
                      {stageName(stage.stage)}
                      {stage.calls > 1 && <span className="text-muted"> · {stage.calls} calls</span>}
                    </span>
                    <span className="tabular text-sm font-medium">{duration(stage.ms)}</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="h-1.5 flex-1 rounded-full bg-subtle">
                      <div
                        className="h-full rounded-full"
                        style={{width: `${(100 * stage.ms) / max}%`, background: timingCategory(stage.category).color}}
                      />
                    </div>
                    <span className="w-28 text-right text-xs text-muted">{timingCategory(stage.category).label}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Drawer>
  );
}

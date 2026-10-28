/**
 * Usage: what Nocheh costs and how fast it answers. Counts come from Nocheh's
 * own usage tracker (counts only, never content); a cost it can't price is
 * shown as unknown, never as zero.
 */
import {lazy, Suspense, useState, type ComponentProps} from 'react';
import {Gauge} from 'lucide-react';
import {useParam} from '../lib/navigation';
import {useResource} from '../lib/resource';
import {setParams} from '../lib/routes';
import {compact, cost, count, duration, partName} from '../lib/system-format';
import {cn} from '../lib/utils';
import {Card, CardHeader, Empty, LoadError, Notice, Segmented, Skeleton, Stat, Table, Td, Th} from '../ui/core';
import {Page} from '../ui/page';
import {addRow, emptyTotal, failures, groupRows as group, type Usage, type UsageRow} from '../lib/system-usage';
import {ReplySpeed, type TimingSummary} from './usage/reply-speed';

const DailyChart = lazy(() => import('./usage/daily-chart'));

const periods = [
  {value: '1', label: 'Today'},
  {value: '7', label: '7 days'},
  {value: '30', label: '30 days'},
] as const;
type Period = (typeof periods)[number]['value'];

export default function UsagePage() {
  const param = useParam('days');
  const days: Period = periods.some(p => p.value === param) ? (param as Period) : '7';
  const usage = useResource<Usage>('/usage?days=' + days, 60000);
  const timings = useResource<TimingSummary>('/workflows/timings', 30000);
  const data = usage.data?.days === Number(days) ? usage.data : null;
  const rows = data?.rows ?? [];
  const all = rows.reduce(addRow, emptyTotal());

  const notes: string[] = [];
  if (data?.sources.hermes === 'empty') notes.push('The assistant hasn’t recorded any use yet.');
  if (data?.sources.honcho === 'empty') notes.push('Long-term memory hasn’t recorded any use yet.');
  if (data?.sources.pricing === 'unavailable')
    notes.push('Long-term memory costs are unknown right now because the price check didn’t answer.');
  if (all.unknown && data?.sources.pricing !== 'unavailable')
    notes.push('Some models have no published price, for example a custom provider, so part of the cost is unknown.');

  if (all.refused || all.hidden)
    notes.push(
      'Refused means the model declined to answer. A text the secret check’s model refuses twice is hidden whole, so nothing unchecked is kept or sent. Try another model for that part in Settings › Models.',
    );

  const median = timings.data?.reply_ms_p50;
  return (
    <Page
      title="Usage"
      description="What Nocheh costs and how fast it answers."
      actions={
        <Segmented
          label="Period"
          value={days}
          options={periods.map(p => ({value: p.value, label: p.label}))}
          onChange={value => setParams({days: value === '7' ? null : value}, true)}
        />
      }
    >
      {usage.error && <LoadError what="usage" onRetry={() => location.reload()} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {data ? (
          <>
            <Stat
              label="Cost"
              value={all.calls ? cost(all) : '$0.00'}
              hint={all.unknown ? 'Some calls can’t be priced' : 'Estimated from list prices'}
            />
            <Stat label="Model calls" value={count(all.calls)} hint={failures(all) || 'None failed'} />
            <Stat
              label="Tokens"
              value={compact(all.input + all.output)}
              hint={`${compact(all.input)} in · ${compact(all.output)} out`}
            />
          </>
        ) : (
          [0, 1, 2].map(i => <Skeleton key={i} className="h-[92px] rounded-xl" />)
        )}
        {timings.data || timings.error ? (
          <Stat
            label="Median reply time"
            value={timings.data ? duration(median) : '—'}
            hint={
              timings.data
                ? timings.data.messages
                  ? `Last ${timings.data.messages} replies`
                  : 'No replies measured yet'
                : 'Couldn’t be measured'
            }
          />
        ) : (
          <Skeleton className="h-[92px] rounded-xl" />
        )}
      </div>

      {notes.length > 0 && (
        <Notice tone="info" title="About these numbers">
          <ul className="list-disc space-y-0.5 pl-4">
            {notes.map(note => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Notice>
      )}

      {data && days !== '1' && rows.length > 0 && (
        <Card>
          <CardHeader title="Calls per day" description="Days are counted in UTC." />
          <div className="px-2 pt-2 pb-3 sm:px-4">
            <Suspense fallback={<Skeleton className="h-48 w-full" />}>
              <DailyChart rows={rows} since={data.since} today={data.today} />
            </Suspense>
          </div>
        </Card>
      )}

      <Breakdown data={data} loading={!data && !usage.error} />

      <ReplySpeed summary={timings.data} error={!!timings.error} />
    </Page>
  );
}

function Breakdown({data, loading}: {data: Usage | null; loading: boolean}) {
  const [by, setBy] = useState<'part' | 'model'>('part');
  const rows = data?.rows ?? [];
  return (
    <Card>
      <CardHeader
        title="Where it goes"
        description={
          by === 'part' ? 'Each part of Nocheh that calls a model.' : 'Each provider and model that was called.'
        }
        action={
          <Segmented
            size="sm"
            label="Group by"
            value={by}
            onChange={setBy}
            options={[
              {value: 'part', label: 'By part'},
              {value: 'model', label: 'By model'},
            ]}
          />
        }
      />
      <div className="mt-3">
        {loading ? (
          <div className="space-y-2 px-5 pb-5">
            {[0, 1, 2, 3].map(i => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : !data ? (
          <Empty title="Usage isn’t available">It will appear here once the usage tracker answers.</Empty>
        ) : !rows.length ? (
          <Empty icon={Gauge} title="No model calls in this period">
            Calls appear here as Nocheh replies, checks messages for secrets and builds memory.
          </Empty>
        ) : by === 'part' ? (
          <PartTable data={data} />
        ) : (
          <ModelTable rows={rows} />
        )}
      </div>
    </Card>
  );
}

const Num = ({className, ...props}: ComponentProps<'td'>) => (
  <Td className={cn('tabular text-right whitespace-nowrap', className)} {...props} />
);
const NumTh = ({className, ...props}: ComponentProps<'th'>) => (
  <Th className={cn('text-right', className)} {...props} />
);

function PartTable({data}: {data: Usage}) {
  const byPart = group(data.rows, row => row.part);
  const lines = group(data.rows, row => [row.part, row.provider, row.model].join('\u0000'));
  const names = new Map(data.rows.map(row => [row.provider + '\u0000' + row.model, row.provider_name || row.provider]));
  const ids = [...data.parts.map(p => p.id), ...[...byPart.keys()].filter(id => !data.parts.some(p => p.id === id))];
  const used = ids.filter(id => byPart.has(id));
  const unused = ids.filter(id => !byPart.has(id));
  return (
    <>
      <Table aria-label="Usage by part">
        <thead>
          <tr>
            <Th scope="col">Part</Th>
            <Th scope="col">Provider and model</Th>
            <NumTh scope="col">Calls</NumTh>
            <NumTh scope="col">Tokens in</NumTh>
            <NumTh scope="col">Tokens out</NumTh>
            <NumTh scope="col">Cost</NumTh>
          </tr>
        </thead>
        {used.map(id => {
          const total = byPart.get(id)!;
          const models = [...lines].filter(([key]) => key.startsWith(id + '\u0000'));
          const label = (key: string) => {
            const [, provider = '', model = ''] = key.split('\u0000');
            return (names.get(provider + '\u0000' + model) ?? provider) + ' · ' + model;
          };
          return (
            <tbody key={id}>
              <tr>
                <Td className="font-medium whitespace-nowrap">
                  {partName(id, data.parts.find(p => p.id === id)?.label)}
                </Td>
                <Td className={cn('min-w-48', models.length > 1 && 'text-muted')}>
                  {models.length === 1 ? label(models[0]![0]) : `${models.length} models`}
                </Td>
                <Num>
                  {count(total.calls)}
                  {failures(total) && <span className="block text-xs text-bad">{failures(total)}</span>}
                </Num>
                <Num>{compact(total.input)}</Num>
                <Num>{compact(total.output)}</Num>
                <Num className={cn(total.unknown && 'text-warn')}>{cost(total)}</Num>
              </tr>
              {models.length > 1 &&
                models.map(([key, line]) => (
                  <tr key={key} className="text-[13px] text-muted">
                    <Td className="border-b-0 py-1.5" />
                    <Td className="py-1.5">{label(key)}</Td>
                    <Num className="py-1.5">{count(line.calls)}</Num>
                    <Num className="py-1.5">{compact(line.input)}</Num>
                    <Num className="py-1.5">{compact(line.output)}</Num>
                    <Num className="py-1.5">{cost(line)}</Num>
                  </tr>
                ))}
            </tbody>
          );
        })}
      </Table>
      {unused.length > 0 && (
        <p className="px-5 py-3 text-xs text-muted">
          Not used in this period: {unused.map(id => partName(id, data.parts.find(p => p.id === id)?.label)).join(', ')}
          .
        </p>
      )}
    </>
  );
}

function ModelTable({rows}: {rows: UsageRow[]}) {
  const byModel = group(rows, row => row.provider + '\u0000' + row.model);
  const info = new Map<string, {provider: string; model: string; parts: Set<string>}>();
  for (const row of rows) {
    const key = row.provider + '\u0000' + row.model;
    const entry = info.get(key) ?? {provider: row.provider_name || row.provider, model: row.model, parts: new Set()};
    entry.parts.add(partName(row.part, row.label));
    info.set(key, entry);
  }
  const sorted = [...byModel].sort((a, b) => b[1].calls - a[1].calls);
  return (
    <Table aria-label="Usage by provider and model">
      <thead>
        <tr>
          <Th scope="col">Provider</Th>
          <Th scope="col">Model</Th>
          <Th scope="col">Used for</Th>
          <NumTh scope="col">Calls</NumTh>
          <NumTh scope="col">Tokens</NumTh>
          <NumTh scope="col">Cost</NumTh>
        </tr>
      </thead>
      <tbody>
        {sorted.map(([key, total]) => {
          const entry = info.get(key)!;
          return (
            <tr key={key}>
              <Td className="font-medium whitespace-nowrap">{entry.provider}</Td>
              <Td className="whitespace-nowrap">{entry.model || '—'}</Td>
              <Td className="min-w-40 text-muted">{[...entry.parts].join(', ')}</Td>
              <Num>
                {count(total.calls)}
                {failures(total) && <span className="block text-xs text-bad">{failures(total)}</span>}
              </Num>
              <Num>{compact(total.input + total.output)}</Num>
              <Num className={cn(total.unknown && 'text-warn')}>{cost(total)}</Num>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

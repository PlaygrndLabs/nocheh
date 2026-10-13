/** Background work history charts. Loaded on its own so the chart library stays out of the first page load. */
import type {ReactNode} from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {count, dateTime, duration, families, familyName} from '../../lib/system-format';
import {Details, Table, Td, Th} from '../../ui/core';

export type Bucket = {
  start: string;
  end: string;
  admitted: number;
  completed: number;
  terminal_failed: number;
  completion_ms_p50: number | null;
  completion_ms_p95: number | null;
  completion_samples: number;
};
export type Metrics = {
  range: '24h' | '7d';
  family: string | null;
  from: string;
  to: string;
  observed_at: string;
  bucket_seconds: number;
  buckets: Bucket[];
};

const axis = {tick: {fill: 'var(--muted)', fontSize: 11}, tickLine: false, axisLine: false} as const;
const legend = (
  <Legend iconType="plainline" iconSize={14} itemSorter={null} wrapperStyle={{fontSize: 12, color: 'var(--muted)'}} />
);

function Tip({
  active,
  payload,
  label,
  format = count,
}: {
  active?: boolean;
  payload?: any[];
  label?: any;
  format?: (v: any) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium">{dateTime(String(label))}</p>
      {payload.map(item => (
        <p key={item.dataKey} className="flex items-center gap-2">
          <span aria-hidden className="size-2 rounded-sm" style={{background: item.color}} />
          <span className="text-muted">{item.name}</span>
          <span className="tabular ml-auto pl-3 font-medium">{item.value == null ? '—' : format(item.value)}</span>
        </p>
      ))}
    </div>
  );
}

function Panel({title, note, children, wide}: {title: string; note: string; children: ReactNode; wide?: boolean}) {
  return (
    <section className={wide ? 'lg:col-span-2' : undefined}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-xs text-muted">{note}</p>
      <div className="mt-2 h-52" role="img" aria-label={title}>
        {children}
      </div>
    </section>
  );
}

export default function WorkCharts({
  metrics,
  counts,
}: {
  metrics: Metrics;
  counts: {family: string; state: string; count: number}[] | null;
}) {
  const data = metrics.buckets;
  const tick = (value: string) =>
    new Date(value).toLocaleString(
      undefined,
      metrics.range === '24h' ? {hour: 'numeric'} : {weekday: 'short', hour: 'numeric'},
    );
  const x = <XAxis dataKey="start" tickFormatter={tick} minTickGap={36} {...axis} />;
  const grid = <CartesianGrid stroke="var(--border)" vertical={false} />;
  const hasActivity = data.some(b => b.admitted || b.completed || b.terminal_failed);
  const hasSamples = data.some(b => b.completion_samples > 0);
  const workload = Object.keys(families)
    .map(family => {
      const sum = (...states: string[]) =>
        (counts ?? []).filter(c => c.family === family && states.includes(c.state)).reduce((n, c) => n + c.count, 0);
      return {
        name: familyName(family),
        running: sum('running'),
        waiting: sum('queued', 'waiting'),
        failed: sum('failed', 'retryable_failed'),
        uncertain: sum('ambiguous'),
      };
    })
    .filter(row => row.running + row.waiting + row.failed + row.uncertain > 0);
  return (
    <>
      <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
        <Panel
          wide
          title="Activity"
          note={
            hasActivity ? 'Tasks started and finished in each period.' : 'Nothing started or finished in this period.'
          }
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{top: 8, right: 8, bottom: 0, left: 0}}>
              {grid}
              {x}
              <YAxis allowDecimals={false} width={34} {...axis} />
              <Tooltip content={<Tip />} />
              {legend}
              <Line
                dataKey="admitted"
                name="Started"
                stroke="var(--info)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                dataKey="completed"
                name="Finished"
                stroke="var(--good)"
                strokeWidth={2}
                strokeDasharray="5 3"
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </Panel>
        <Panel title="Outcomes" note="Finished tasks and final failures. Retries show in the table below.">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{top: 8, right: 8, bottom: 0, left: 0}} barGap={2}>
              {grid}
              {x}
              <YAxis allowDecimals={false} width={34} {...axis} />
              <Tooltip content={<Tip />} cursor={{fill: 'var(--subtle)'}} />
              {legend}
              <Bar dataKey="completed" name="Done" fill="var(--good)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
              <Bar
                dataKey="terminal_failed"
                name="Failed"
                fill="var(--bad)"
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
        <Panel
          title="Time to finish"
          note={
            hasSamples
              ? 'From start to done, including waits and retries.'
              : 'No task finished in this period, so there is no time to show.'
          }
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{top: 8, right: 8, bottom: 0, left: 0}}>
              {grid}
              {x}
              <YAxis tickFormatter={v => duration(Number(v))} width={56} {...axis} />
              <Tooltip content={<Tip format={v => duration(Number(v))} />} />
              {legend}
              <Line
                dataKey="completion_ms_p50"
                name="Typical"
                stroke="var(--accent)"
                strokeWidth={2}
                dot={{r: 2}}
                isAnimationActive={false}
              />
              <Line
                dataKey="completion_ms_p95"
                name="Slow (1 in 20)"
                stroke="var(--accent)"
                strokeOpacity={0.55}
                strokeWidth={2}
                strokeDasharray="4 4"
                dot={{r: 2}}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </Panel>
        {counts && (
          <section className="lg:col-span-2">
            <h3 className="text-sm font-semibold">Right now, by kind</h3>
            <p className="text-xs text-muted">
              {workload.length
                ? 'Tasks that are running, waiting or failed.'
                : 'Nothing is running, waiting or failed.'}
            </p>
            {workload.length > 0 && (
              <div
                className="mt-2"
                style={{height: 40 + workload.length * 30}}
                role="img"
                aria-label="Current work by kind"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={workload}
                    layout="vertical"
                    margin={{top: 0, right: 8, bottom: 0, left: 0}}
                    barCategoryGap={6}
                  >
                    <CartesianGrid stroke="var(--border)" horizontal={false} />
                    <XAxis type="number" allowDecimals={false} {...axis} />
                    <YAxis type="category" dataKey="name" width={140} {...axis} />
                    <Tooltip
                      cursor={{fill: 'var(--subtle)'}}
                      content={({active, payload, label}) =>
                        active && payload?.length ? (
                          <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
                            <p className="mb-1 font-medium">{label}</p>
                            {payload.map(item => (
                              <p key={String(item.dataKey)} className="flex gap-3">
                                <span className="text-muted">{item.name}</span>
                                <span className="tabular ml-auto font-medium">{String(item.value)}</span>
                              </p>
                            ))}
                          </div>
                        ) : null
                      }
                    />
                    {legend}
                    <Bar
                      dataKey="running"
                      name="Running"
                      stackId="now"
                      fill="var(--info)"
                      stroke="var(--surface)"
                      strokeWidth={2}
                      isAnimationActive={false}
                    />
                    <Bar
                      dataKey="waiting"
                      name="Waiting"
                      stackId="now"
                      fill="var(--warn)"
                      stroke="var(--surface)"
                      strokeWidth={2}
                      isAnimationActive={false}
                    />
                    <Bar
                      dataKey="failed"
                      name="Failed"
                      stackId="now"
                      fill="var(--bad)"
                      stroke="var(--surface)"
                      strokeWidth={2}
                      isAnimationActive={false}
                    />
                    <Bar
                      dataKey="uncertain"
                      name="Uncertain"
                      stackId="now"
                      fill="var(--muted)"
                      stroke="var(--surface)"
                      strokeWidth={2}
                      isAnimationActive={false}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>
        )}
      </div>
      <Details summary="Show as a table" className="mt-5">
        <Table aria-label="Background work history">
          <thead>
            <tr>
              <Th scope="col">From</Th>
              <Th scope="col" className="text-right">
                Started
              </Th>
              <Th scope="col" className="text-right">
                Done
              </Th>
              <Th scope="col" className="text-right">
                Failed
              </Th>
              <Th scope="col" className="text-right">
                Typical time
              </Th>
              <Th scope="col" className="text-right">
                Slow time
              </Th>
              <Th scope="col" className="text-right">
                Samples
              </Th>
            </tr>
          </thead>
          <tbody>
            {data.map(row => (
              <tr key={row.start}>
                <Td className="whitespace-nowrap">
                  <time dateTime={row.start} title={'Until ' + dateTime(row.end)}>
                    {dateTime(row.start)}
                  </time>
                </Td>
                <Td className="tabular text-right">{row.admitted}</Td>
                <Td className="tabular text-right">{row.completed}</Td>
                <Td className="tabular text-right">{row.terminal_failed}</Td>
                <Td className="tabular text-right">{duration(row.completion_ms_p50)}</Td>
                <Td className="tabular text-right">{duration(row.completion_ms_p95)}</Td>
                <Td className="tabular text-right">{row.completion_samples}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Details>
    </>
  );
}

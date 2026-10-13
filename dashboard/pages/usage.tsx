import {useState} from 'react';
import {useResource} from '../lib/resource';
import {Alert, Skeleton} from '../components/ui/primitives';
import {Panel} from '../lib/page-helpers';

type Row = {
  day: string;
  part: string;
  label: string;
  service: string;
  provider: string;
  provider_name: string;
  model: string;
  runs: number;
  calls: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
  cost_complete: boolean;
};
type Usage = {
  since: string;
  today: string;
  days: number;
  rows: Row[];
  parts: {id: string; label: string; service: string}[];
  sources: {hermes: string; honcho: string; pricing: string};
};
type Total = Omit<Row, 'day' | 'cost_usd'> & {cost: number; unknown: boolean};

const periods: [number, string][] = [
  [1, 'Today'],
  [7, '7 days'],
  [30, '30 days'],
];
const count = new Intl.NumberFormat();

function add(total: Total | undefined, row: Row): Total {
  const base: Total = total ?? {
    ...row,
    runs: 0,
    calls: 0,
    failed: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cost: 0,
    unknown: false,
    cost_complete: true,
  };
  return {
    ...base,
    runs: base.runs + row.runs,
    calls: base.calls + row.calls,
    failed: base.failed + row.failed,
    input_tokens: base.input_tokens + row.input_tokens,
    output_tokens: base.output_tokens + row.output_tokens,
    cache_read_tokens: base.cache_read_tokens + row.cache_read_tokens,
    cache_write_tokens: base.cache_write_tokens + row.cache_write_tokens,
    reasoning_tokens: base.reasoning_tokens + row.reasoning_tokens,
    cost: base.cost + (row.cost_usd ?? 0),
    unknown: base.unknown || row.cost_usd === null || !row.cost_complete,
  };
}

function money(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return '< $0.01';
  return '$' + value.toFixed(2);
}

function cost(total: {cost: number; unknown: boolean; calls: number}): string {
  if (!total.calls) return '—';
  if (total.unknown && total.cost === 0) return 'Unknown';
  return total.unknown ? 'At least ' + money(total.cost) : money(total.cost);
}

/** Model use of every part (Hermes, Honcho and Nocheh's own checks) in one place. */
export function UsageView() {
  const [days, setDays] = useState(30);
  const {data, error} = useResource<Usage>('/usage?days=' + days, 60000);
  const lines = new Map<string, Total>();
  const totals = new Map<string, Total>();
  let all: Total | undefined;
  for (const row of data?.rows ?? []) {
    const key = [row.part, row.provider, row.model].join('\u0000');
    lines.set(key, add(lines.get(key), row));
    totals.set(row.part, add(totals.get(row.part), row));
    all = add(all, row);
  }
  const tokens = all ? all.input_tokens + all.output_tokens : 0;
  const notes: string[] = [];
  if (data?.sources.hermes === 'empty') notes.push('Hermes has not recorded any use yet.');
  if (data?.sources.honcho === 'empty') notes.push('Honcho memory has not recorded any use yet.');
  if (data?.sources.pricing === 'unavailable')
    notes.push('Memory costs are unknown right now because Hermes, which prices them, did not answer.');
  if (all?.unknown)
    notes.push(
      'Some costs are unknown. Hermes only prices models it knows; a custom provider such as my-gateway may not publish prices.',
    );
  return (
    <div className="n-usage">
      <section className="n-panel n-usage-head">
        <div>
          <h2>Model usage</h2>
          <p className="n-muted">
            Every part that calls a model, counted by Nocheh. Days are UTC
            {data ? ', from ' + data.since + ' to ' + data.today : ''}.
          </p>
        </div>
        <div className="n-access-choice" role="group" aria-label="Usage period">
          {periods.map(([value, label]) => (
            <button type="button" key={value} aria-pressed={days === value} onClick={() => setDays(value)}>
              {label}
            </button>
          ))}
        </div>
      </section>
      {error && <Alert>{data ? 'Usage may be out of date: ' + error : 'Usage is unavailable: ' + error}</Alert>}
      {!data && !error && (
        <div role="status" aria-label="Loading usage">
          <Skeleton className="chart-skeleton" />
        </div>
      )}
      {data && (
        <>
          <div className="n-metrics" aria-label="Usage totals">
            <section className="n-panel">
              <h2>Model calls</h2>
              <strong className="n-usage-value">{count.format(all?.calls ?? 0)}</strong>
              <p className="n-muted">{all?.failed ? count.format(all.failed) + ' failed' : 'None failed'}</p>
            </section>
            <section className="n-panel">
              <h2>Tokens</h2>
              <strong className="n-usage-value">{count.format(tokens)}</strong>
              <p className="n-muted">
                {count.format(all?.input_tokens ?? 0)} in · {count.format(all?.output_tokens ?? 0)} out
              </p>
            </section>
            <section className="n-panel">
              <h2>Estimated cost</h2>
              <strong className="n-usage-value">{all ? cost(all) : '$0.00'}</strong>
              <p className="n-muted">Hermes's price list; subscriptions show as $0.</p>
            </section>
          </div>
          {notes.length > 0 && (
            <Alert role="note" aria-label="About these numbers">
              {notes.map(note => (
                <p key={note}>{note}</p>
              ))}
            </Alert>
          )}
          <Panel title="By part" note="Each part, the provider it used and the model.">
            <div className="n-usage-scroll">
              <table className="n-timing-table n-usage-table">
                <thead>
                  <tr>
                    <th scope="col">Part</th>
                    <th scope="col">Provider and model</th>
                    <th scope="col" className="n-number">
                      Calls
                    </th>
                    <th scope="col" className="n-number">
                      Failed
                    </th>
                    <th scope="col" className="n-number">
                      Input tokens
                    </th>
                    <th scope="col" className="n-number">
                      Output tokens
                    </th>
                    <th scope="col" className="n-number">
                      Cost
                    </th>
                  </tr>
                </thead>
                {data.parts.map(part => {
                  const used = [...lines.values()].filter(line => line.part === part.id);
                  const total = totals.get(part.id);
                  return (
                    <tbody key={part.id} aria-label={part.label}>
                      <tr className="n-usage-part">
                        <th scope="row">
                          {part.label}
                          <small>{part.service}</small>
                        </th>
                        <td className={used.length === 1 ? '' : 'n-muted'}>
                          {used.length === 0
                            ? 'Not used in this period'
                            : used.length === 1
                              ? used[0]!.provider_name + ' · ' + used[0]!.model
                              : used.length + ' models'}
                        </td>
                        <td className="n-number">{count.format(total?.calls ?? 0)}</td>
                        <td className="n-number">{count.format(total?.failed ?? 0)}</td>
                        <td className="n-number">{count.format(total?.input_tokens ?? 0)}</td>
                        <td className="n-number">{count.format(total?.output_tokens ?? 0)}</td>
                        <td className="n-number">{total ? cost(total) : '—'}</td>
                      </tr>
                      {used.length > 1 &&
                        used.map(line => (
                          <tr key={line.provider + line.model} className="n-usage-line">
                            <td />
                            <td>
                              {line.provider_name} · {line.model}
                            </td>
                            <td className="n-number">{count.format(line.calls)}</td>
                            <td className="n-number">{count.format(line.failed)}</td>
                            <td className="n-number">{count.format(line.input_tokens)}</td>
                            <td className="n-number">{count.format(line.output_tokens)}</td>
                            <td className="n-number">{cost(line)}</td>
                          </tr>
                        ))}
                    </tbody>
                  );
                })}
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

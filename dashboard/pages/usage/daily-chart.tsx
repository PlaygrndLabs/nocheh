/** Model calls per UTC day. Loaded on its own so the chart library stays out of the first page load. */
import {Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis} from 'recharts';
import {cost, count} from '../../lib/system-format';
import {Details, Table, Td, Th} from '../../ui/core';
import {addRow, emptyTotal, type UsageRow} from '../../lib/system-usage';

const label = (day: string) =>
  new Date(day + 'T00:00:00Z').toLocaleDateString(undefined, {month: 'short', day: 'numeric', timeZone: 'UTC'});

export default function DailyChart({rows, since, today}: {rows: UsageRow[]; since: string; today: string}) {
  const days: string[] = [];
  for (
    let day = new Date(since + 'T00:00:00Z');
    day.toISOString().slice(0, 10) <= today;
    day.setUTCDate(day.getUTCDate() + 1)
  )
    days.push(day.toISOString().slice(0, 10));
  const data = days.map(day => {
    const total = rows.filter(row => row.day === day).reduce(addRow, emptyTotal());
    return {day, label: label(day), calls: total.calls, total};
  });
  return (
    <>
      <div className="h-48" role="img" aria-label="Model calls per day">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{top: 8, right: 8, bottom: 0, left: 0}}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{fill: 'var(--muted)', fontSize: 11}}
              tickLine={false}
              axisLine={false}
              minTickGap={16}
            />
            <YAxis
              allowDecimals={false}
              tick={{fill: 'var(--muted)', fontSize: 11}}
              tickLine={false}
              axisLine={false}
              width={36}
            />
            <Tooltip
              cursor={{fill: 'var(--subtle)'}}
              content={({active, payload}) => {
                const point = active && payload?.[0]?.payload;
                if (!point) return null;
                return (
                  <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
                    <p className="font-medium">{point.label}</p>
                    <p className="tabular mt-0.5 text-muted">
                      {count(point.calls)} calls · {point.calls ? cost(point.total) : '$0.00'}
                    </p>
                  </div>
                );
              }}
            />
            <Bar
              dataKey="calls"
              name="Model calls"
              fill="var(--accent)"
              radius={[4, 4, 0, 0]}
              maxBarSize={28}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <Details summary="Show as a table" className="px-3 pt-2">
        <Table aria-label="Model calls per day">
          <thead>
            <tr>
              <Th scope="col">Day (UTC)</Th>
              <Th scope="col" className="text-right">
                Calls
              </Th>
              <Th scope="col" className="text-right">
                Cost
              </Th>
            </tr>
          </thead>
          <tbody>
            {data.map(point => (
              <tr key={point.day}>
                <Td>{point.label}</Td>
                <Td className="tabular text-right">{count(point.calls)}</Td>
                <Td className="tabular text-right">{point.calls ? cost(point.total) : '—'}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Details>
    </>
  );
}

import {useState} from 'react';
import {useResource} from '../lib/resource';

const seconds = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : (value / 1000).toFixed(1) + ' s';
const categories: Record<string, string> = {
  internal: 'Internal',
  workflow: 'Workflow wait',
  third_party: 'Third-party',
  llm: 'LLM',
  unmeasured: 'Unmeasured',
};
const time = (value: string | null | undefined) => (value ? new Date(value).toLocaleString() : 'Not observed');

/** One message: where its reply time went, stage by stage. Stages never overlap. */
function Breakdown({id}: {id: string}) {
  const {data, error} = useResource<any>('/workflows/timings/' + id);
  if (error) return <p role="alert">Timing for this message is unavailable.</p>;
  if (!data) return <p role="status">Loading stage timing…</p>;
  return (
    <div className="n-timing-breakdown">
      <p>
        <b>{'Reply ' + seconds(data.reply_ms)}</b>
        {' · attempts ' + data.attempts + (data.complete ? '' : ' · incomplete: no delivery timing recorded')}
      </p>
      {!data.stages.length && <p className="n-empty">No stage timing was recorded for this message.</p>}
      {data.stages.length > 0 && (
        <table className="n-timing-table">
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Stage</th>
              <th scope="col" className="n-number">
                Time
              </th>
            </tr>
          </thead>
          <tbody>
            {data.stages.map((stage: any) => (
              <tr key={stage.stage}>
                <td>{categories[stage.category] || stage.category}</td>
                <td>{stage.label + (stage.calls > 1 ? ' (' + stage.calls + ' calls)' : '')}</td>
                <td className="n-number">{seconds(stage.ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Per-stage p50/p95 across recent replies, and each recent reply's breakdown on request. */
export function ReplyTimings() {
  const {data, error} = useResource<any>('/workflows/timings', 30000),
    [selected, setSelected] = useState<string | null>(null);
  if (error) return <p role="alert">Reply timing is unavailable. The running installation may predate stage timing.</p>;
  if (!data) return <p role="status">Loading reply timing…</p>;
  return (
    <div>
      <p className="n-muted">
        Measured from Telegram’s message time to the delivered reply. Overlapping measurements are never added together;
        time no measurement explains is shown as unmeasured.
      </p>
      {!data.messages && <p className="n-empty">No replied message has stage timing yet.</p>}
      {data.messages > 0 && (
        <section>
          <h3>{'Across the last ' + data.messages + ' replies'}</h3>
          <p>{'Reply time p50 ' + seconds(data.reply_ms_p50) + ' · p95 ' + seconds(data.reply_ms_p95)}</p>
          <table className="n-timing-table">
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Stage</th>
                <th scope="col" className="n-number">
                  p50
                </th>
                <th scope="col" className="n-number">
                  p95
                </th>
                <th scope="col" className="n-number">
                  Messages
                </th>
              </tr>
            </thead>
            <tbody>
              {data.stages.map((stage: any) => (
                <tr key={stage.stage}>
                  <td>{categories[stage.category] || stage.category}</td>
                  <td>{stage.label}</td>
                  <td className="n-number">{seconds(stage.ms_p50)}</td>
                  <td className="n-number">{seconds(stage.ms_p95)}</td>
                  <td className="n-number">{stage.messages}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {data.recent?.length > 0 && (
        <section>
          <h3>Recent replies</h3>
          {data.recent.map((item: any) => (
            <div key={item.event_id}>
              <div className="n-row">
                <div>
                  <b>{time(item.started_at)}</b>
                  <span>{' · reply ' + seconds(item.reply_ms) + ' · unmeasured ' + seconds(item.unmeasured_ms)}</span>
                </div>
                <button
                  type="button"
                  aria-expanded={selected === item.event_id}
                  onClick={() => setSelected(selected === item.event_id ? null : item.event_id)}
                >
                  {selected === item.event_id ? 'Hide stages' : 'Show stages'}
                </button>
              </div>
              {selected === item.event_id && <Breakdown id={item.event_id} />}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

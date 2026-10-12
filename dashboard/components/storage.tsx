import {useResource} from '../lib/resource';

export function size(bytes: unknown) {
  if (typeof bytes !== 'number') return '—';
  let value = bytes;
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (value < 1024 || unit === 'GB') return unit === 'B' ? value + ' B' : value.toFixed(1) + ' ' + unit;
    value /= 1024;
  }
}

/** Where disk is used, read-only. Owned originals grow by design; everything else is bounded. */
export function StorageUsage() {
  const {data, error} = useResource<any>('/storage');
  if (error) return <p role="alert">Storage usage is unavailable. The database services may be stopped.</p>;
  if (!data) return <p role="status">Measuring storage…</p>;
  const retention = data.retention_days,
    logs = data.docker_logs || {};
  return (
    <div className="n-storage">
      <p className="n-muted">
        Owned originals are kept without a limit by design. Workflow history, operational records and logs are bounded.
      </p>
      {(data.databases || []).map((row: any) => (
        <section key={row.database}>
          <h3>
            {row.database + ' · ' + row.role + ' · ' + (row.state === 'measured' ? size(row.bytes) : 'not running')}
          </h3>
          {row.state === 'measured' && row.largest_tables?.length > 0 && (
            <table className="n-timing-table">
              <thead>
                <tr>
                  <th scope="col">Largest tables</th>
                  <th scope="col" className="n-number">
                    Size
                  </th>
                  <th scope="col" className="n-number">
                    About rows
                  </th>
                </tr>
              </thead>
              <tbody>
                {row.largest_tables.map((table: any) => (
                  <tr key={table.table}>
                    <td>{table.table}</td>
                    <td className="n-number">{size(table.bytes)}</td>
                    <td className="n-number">{table.estimated_rows.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
      <section>
        <h3>Local state folders</h3>
        {!(data.state_folders || []).length && <p className="n-empty">No local state folders were found.</p>}
        {(data.state_folders || []).map((row: any) => (
          <div className="n-row" key={row.path}>
            <b>{row.path}</b>
            <span>{(row.complete === false ? 'at least ' : '') + size(row.bytes)}</span>
          </div>
        ))}
      </section>
      <p>
        {'Docker logs: at most ' +
          (logs.max_files_per_container ?? '—') +
          ' × ' +
          (logs.max_size_per_file ?? '—') +
          ' per container.'}
      </p>
      <p>{'Workflow history retention: ' + (retention ? retention + ' days' : 'off') + '.'}</p>
    </div>
  );
}

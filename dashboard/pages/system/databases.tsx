/** System › Databases: a read-only look inside Nocheh's databases. No SQL, no editing. */
import {useState, type FormEvent} from 'react';
import {ArrowDown, ArrowUp, ArrowUpDown, Database, RefreshCw, Search, X} from 'lucide-react';
import {useParam} from '../../lib/navigation';
import {refreshResources, useLiveResources, useResource} from '../../lib/resource';
import {setParams} from '../../lib/routes';
import {bytes, count, databaseName} from '../../lib/system-format';
import {cn} from '../../lib/utils';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  Field,
  Input,
  LoadError,
  LoadingRows,
  Pager,
  Select,
  Skeleton,
  type Tone,
} from '../../ui/core';

type Entry = {id: string; name: string; engine: 'postgres' | 'sqlite'};
type Status = Entry & {
  identifier: string;
  service: string | null;
  state: 'available' | 'unavailable' | 'missing';
  detail?: string;
  size_bytes?: number;
  table_count?: number;
  version?: string;
};
type TableEntry = {schema: string; name: string; estimated_rows: number | null};
type Rows = {
  columns: {name: string; type: string}[];
  rows: Record<string, string | null>[];
  next_offset: number | null;
  offset: number;
  cell_limit: number;
};

const PAGE = 50;
const path = (params: Record<string, string>) => '/database-browser?' + new URLSearchParams(params);
const states: Record<string, {label: string; tone: Tone}> = {
  available: {label: 'Available', tone: 'good'},
  unavailable: {label: 'Can’t be reached', tone: 'bad'},
  missing: {label: 'Not created yet', tone: 'neutral'},
};
const stateOf = (status?: Status) =>
  status
    ? (states[status.state] ?? {label: status.state, tone: 'neutral' as Tone})
    : {label: 'Checking…', tone: 'neutral' as Tone};

export function DatabasesView() {
  const catalog = useResource<{databases: Entry[]}>(path({action: 'databases'}));
  // Server change events refresh every open database view in place, keeping the chosen table, sort, filter and page.
  const live = useLiveResources([], ['/database-browser?']);
  const status = useResource<{databases: Status[]}>(path({action: 'status'}), 30000);
  const databases = catalog.data?.databases ?? [];
  const wanted = useParam('db');
  const current = databases.find(d => d.id === wanted) ?? databases.find(d => d.id === 'archive') ?? databases[0];
  const currentStatus = status.data?.databases.find(d => d.id === current?.id);
  const tables = useResource<{tables: TableEntry[]}>(current ? path({action: 'tables', database: current.id}) : null);
  const all = tables.data?.tables ?? [];
  const wantedTable = useParam('table');
  const [search, setSearch] = useState('');
  const key = (t: TableEntry) => t.schema + '.' + t.name;
  const selected =
    all.find(t => key(t) === wantedTable) ?? all.find(t => current?.id === 'archive' && t.name === 'events') ?? all[0];
  const matching = all.filter(t => key(t).toLowerCase().includes(search.trim().toLowerCase()));
  const options = selected && !matching.includes(selected) ? [selected, ...matching] : matching;

  if (catalog.error && !catalog.data)
    return <LoadError what="the database list" onRetry={() => void refreshResources()} />;
  if (!catalog.data)
    return (
      <Card>
        <LoadingRows rows={3} />
      </Card>
    );
  if (!databases.length)
    return (
      <Card>
        <Empty icon={Database} title="No databases found">
          Databases appear here once Nocheh’s services have started.
        </Empty>
      </Card>
    );

  const showName = (t: TableEntry) => (t.schema === 'public' || t.schema === 'main' ? t.name : key(t));
  return (
    <>
      <Card>
        <div className="grid gap-4 px-5 py-4 md:grid-cols-3">
          <Field label="Database" htmlFor="db-select">
            <Select
              id="db-select"
              value={current?.id ?? ''}
              onChange={e => {
                setSearch('');
                setParams({db: e.target.value, table: null}, true);
              }}
            >
              {databases.map(db => (
                <option key={db.id} value={db.id}>
                  {databaseName(db)} · {stateOf(status.data?.databases.find(s => s.id === db.id)).label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Find a table" htmlFor="db-search">
            <Input
              id="db-search"
              type="search"
              placeholder="Table name"
              value={search}
              disabled={!all.length}
              onChange={e => setSearch(e.target.value)}
            />
          </Field>
          <Field
            label="Table"
            htmlFor="db-table"
            hint={tables.data && all.length && !matching.length ? 'No table matches that name.' : undefined}
          >
            <Select
              id="db-table"
              value={selected ? key(selected) : ''}
              disabled={!all.length}
              onChange={e => setParams({table: e.target.value}, true)}
            >
              {!all.length && (
                <option value="">{tables.data ? 'No tables' : tables.error ? 'Tables unavailable' : 'Loading…'}</option>
              )}
              {options.map(t => (
                <option key={key(t)} value={key(t)}>
                  {showName(t)}
                  {t.estimated_rows != null ? ` · ~${count(t.estimated_rows)} rows` : ''}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {current && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line px-5 py-3 text-[13px]">
            <Badge tone={stateOf(currentStatus).tone} dot>
              {stateOf(currentStatus).label}
            </Badge>
            <Badge>Read only</Badge>
            {[
              ['Engine', current.engine === 'sqlite' ? 'SQLite' : 'PostgreSQL'],
              ['Name', currentStatus?.identifier],
              ['Runs in', currentStatus ? currentStatus.service || 'Local file' : undefined],
              ['Tables', currentStatus?.table_count != null ? count(currentStatus.table_count) : undefined],
              ['Size', currentStatus?.size_bytes != null ? bytes(currentStatus.size_bytes) : undefined],
              ['Version', currentStatus?.version],
            ].map(([label, value]) => (
              <span key={label} className="min-w-0">
                <span className="text-muted">{label} </span>
                <span className="break-all">{value ?? '—'}</span>
              </span>
            ))}
            {currentStatus?.detail && currentStatus.state !== 'available' && (
              <span className="w-full text-muted">{currentStatus.detail}.</span>
            )}
          </div>
        )}
        {status.error && !status.data && (
          <p className="border-t border-line px-5 py-3 text-[13px] text-muted">Database status couldn’t be checked.</p>
        )}
      </Card>
      {tables.error && !tables.data ? (
        <LoadError what="tables" />
      ) : tables.data && !all.length ? (
        <Card>
          <Empty icon={Database} title="This database has no tables yet">
            Tables appear once the service using it has started.
          </Empty>
        </Card>
      ) : current && selected ? (
        <RowsCard
          key={current.id + ':' + key(selected)}
          database={current.id}
          table={selected}
          title={showName(selected)}
          live={live}
        />
      ) : (
        <Card>
          <LoadingRows rows={4} />
        </Card>
      )}
    </>
  );
}

function RowsCard({
  database,
  table,
  title,
  live,
}: {
  database: string;
  table: TableEntry;
  title: string;
  live: 'connecting' | 'live' | 'reconnecting';
}) {
  const [sort, setSort] = useState<{column: string; direction: 'asc' | 'desc'} | null>(null);
  const [column, setColumn] = useState('');
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const resource = path({
    action: 'rows',
    database,
    schema: table.schema,
    table: table.name,
    ...(sort ? {sort: sort.column, direction: sort.direction} : {}),
    ...(filter && column ? {filter_column: column, filter} : {}),
    offset: String(offset),
  });
  const {data, error, loading} = useResource<Rows>(resource);
  const columns = data?.columns ?? [];
  const sortBy = (name: string) => {
    setSort(
      sort?.column === name && sort.direction === 'asc'
        ? {column: name, direction: 'desc'}
        : {column: name, direction: 'asc'},
    );
    setOffset(0);
  };
  const apply = (event: FormEvent) => {
    event.preventDefault();
    setFilter(draft.trim());
    setOffset(0);
  };
  const clear = () => {
    setFilter('');
    setDraft('');
    setOffset(0);
  };
  return (
    <Card>
      <CardHeader
        title={<span className="font-mono text-sm">{title}</span>}
        description={
          data
            ? `Showing rows ${count(data.rows.length ? offset + 1 : 0)}–${count(offset + data.rows.length)}${filter ? ' that match' : ''}.`
            : 'Loading rows…'
        }
        action={
          <div className="flex items-center gap-2">
            <Badge tone={live === 'live' ? 'good' : 'warn'} dot>
              {live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting…' : 'Live updates paused'}
            </Badge>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Reload"
              busy={loading && !!data}
              onClick={() => void refreshResources()}
            >
              {!(loading && data) && <RefreshCw aria-hidden />}
            </Button>
          </div>
        }
      />
      <form onSubmit={apply} className="flex flex-wrap items-end gap-2 px-5 pt-3">
        <Field label="Column" htmlFor="db-filter-column" className="w-full sm:w-52">
          <Select
            id="db-filter-column"
            value={column}
            onChange={e => {
              setColumn(e.target.value);
              if (!e.target.value) clear();
              else if (filter) setOffset(0);
            }}
          >
            <option value="">Choose a column</option>
            {columns.map(c => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Contains" htmlFor="db-filter-text" className="min-w-0 flex-1 basis-48">
          <Input
            id="db-filter-text"
            type="search"
            value={draft}
            disabled={!column}
            placeholder="Text in that column"
            onChange={e => setDraft(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={!column}>
          <Search aria-hidden /> Filter
        </Button>
        {filter && (
          <Button variant="ghost" onClick={clear}>
            <X aria-hidden /> Clear
          </Button>
        )}
      </form>
      <div className="mt-4">
        {error && (
          <div className="px-5 pb-3">
            <LoadError what="rows" />
          </div>
        )}
        {!data ? (
          error ? null : (
            <div className="space-y-2 px-5 pb-5">
              {[0, 1, 2, 3, 4].map(i => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          )
        ) : !data.rows.length ? (
          <Empty title={filter ? 'No rows match' : 'This table is empty'}>
            {filter ? 'Try other text or another column.' : undefined}
          </Empty>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-[13px]" aria-label={'Rows in ' + title}>
                <thead>
                  <tr>
                    {columns.map(c => {
                      const active = sort?.column === c.name;
                      const Icon = !active ? ArrowUpDown : sort!.direction === 'asc' ? ArrowUp : ArrowDown;
                      return (
                        <th
                          key={c.name}
                          scope="col"
                          aria-sort={active ? (sort!.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                          className="border-b border-line bg-subtle/60 px-3 py-2 align-bottom font-medium whitespace-nowrap"
                        >
                          <button
                            type="button"
                            onClick={() => sortBy(c.name)}
                            className="inline-flex items-center gap-1 text-xs hover:text-accent-text"
                            title={'Sort by ' + c.name}
                          >
                            {c.name}
                            <Icon className={cn('size-3.5', !active && 'text-muted/60')} aria-hidden />
                          </button>
                          <span className="block text-[11px] font-normal text-muted">{c.type}</span>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, index) => (
                    <tr key={offset + index} className="hover:bg-subtle/50">
                      {columns.map(c => (
                        <td
                          key={c.name}
                          title={row[c.name] ?? 'NULL'}
                          className="max-w-72 truncate border-b border-line px-3 py-1.5 align-top font-mono text-xs"
                        >
                          {row[c.name] ?? <span className="text-muted/70 italic">NULL</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              page={offset / PAGE}
              hasNext={data.next_offset !== null}
              onPage={page => setOffset(page * PAGE)}
              summary={`Long values are cut at ${count(data.cell_limit)} characters.`}
            />
          </>
        )}
      </div>
    </Card>
  );
}

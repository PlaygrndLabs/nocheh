import {useState,type FormEvent} from 'react';
import {ArrowDown,ArrowUp,Database,Search} from 'lucide-react';
import {useResource} from '../lib/resource';
import {Alert,Badge,Button,EmptyState,Skeleton,Table} from '../components/ui/primitives';

type DatabaseEntry={id:string;name:string;engine:'postgres'|'sqlite'};
type DatabaseStatus=DatabaseEntry&{identifier:string;service:string|null;state:'available'|'unavailable'|'missing';detail?:string;size_bytes?:number;table_count?:number;version?:string};
type TableEntry={schema:string;name:string;estimated_rows:number|null};
type Column={name:string;type:string};
type Page={columns:Column[];rows:Record<string,string|null>[];next_offset:number|null;offset:number;cell_limit:number};

function path(parameters:Record<string,string>){return '/database-browser?'+new URLSearchParams(parameters);}
function formatBytes(value:number){return new Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(value/1024/1024)+' MiB';}

export function DatabaseBrowser(){
 const [database,setDatabase]=useState('archive'),[chosen,setChosen]=useState<TableEntry|null>(null),[tableSearch,setTableSearch]=useState('');
 const [sort,setSort]=useState(''),[direction,setDirection]=useState<'asc'|'desc'>('asc');
 const [filterColumn,setFilterColumn]=useState(''),[draftFilter,setDraftFilter]=useState(''),[filter,setFilter]=useState(''),[offset,setOffset]=useState(0);
 const catalog=useResource<{databases:DatabaseEntry[]}>(path({action:'databases'}));
 const status=useResource<{databases:DatabaseStatus[]}>(path({action:'status'}));
 const databases=catalog.data?.databases||[],current=databases.find(item=>item.id===database)||databases[0];
 const currentStatus=status.data?.databases.find(item=>item.id===current?.id);
 const tables=useResource<{tables:TableEntry[]}>(current?path({action:'tables',database:current.id}):null);
 const allTables=tables.data?.tables||[];
 const selected=chosen&&allTables.some(item=>item.schema===chosen.schema&&item.name===chosen.name)?chosen:
  allTables.find(item=>current?.id==='archive'&&item.name==='events')||allTables[0];
 const rowPath=current&&selected?path({action:'rows',database:current.id,schema:selected.schema,table:selected.name,
  ...(sort?{sort,direction}:{}),...(filter&&filterColumn?{filter_column:filterColumn,filter}:{}),offset:String(offset)}):null;
 const page=useResource<Page>(rowPath);
 const matchingTables=allTables.filter(item=>(item.schema+'.'+item.name).toLowerCase().includes(tableSearch.toLowerCase()));
 const chooseDatabase=(id:string)=>{setDatabase(id);setChosen(null);setTableSearch('');setSort('');setFilterColumn('');setDraftFilter('');setFilter('');setOffset(0);};
 const chooseTable=(table:TableEntry)=>{setChosen(table);setSort('');setFilterColumn('');setDraftFilter('');setFilter('');setOffset(0);};
 const sortBy=(column:string)=>{setDirection(sort===column&&direction==='asc'?'desc':'asc');setSort(column);setOffset(0);};
 const applyFilter=(event:FormEvent)=>{event.preventDefault();setFilter(draftFilter.trim());setOffset(0);};
 return <div className="db-browser">
  <section className="n-panel db-browser-intro"><div><p className="archive-kicker">Read only</p><h2>Browse database tables</h2><p>Select a database and table to inspect stored rows. Sort a column or filter its text. Changes to data use the regular owner controls.</p></div><Database size={28} aria-hidden="true"/></section>
  {catalog.error&&<Alert>Database list is unavailable. Refresh to try again.</Alert>}
  {!catalog.data&&catalog.loading&&<Skeleton className="chart-skeleton"/>}
  {status.error&&<Alert>Database status could not be checked. Refresh to try again.</Alert>}
  {!!databases.length&&<section className="db-browser-overview" aria-label="Database status">{databases.map(item=>{
   const itemStatus=status.data?.databases.find(entry=>entry.id===item.id);
   return <button key={item.id} type="button" className={'db-browser-database'+(current?.id===item.id?' selected':'')} aria-current={current?.id===item.id?'true':undefined} onClick={()=>chooseDatabase(item.id)}>
    <span className="db-browser-database-top"><strong>{item.name}</strong><span className={'db-browser-state '+(itemStatus?.state||'checking')}>{itemStatus?.state==='available'?'Available':itemStatus?.state==='missing'?'Not created':itemStatus?.state==='unavailable'?'Unavailable':'Checking…'}</span></span>
    <span className="db-browser-database-meta">{item.engine==='sqlite'?'SQLite':'PostgreSQL'}{itemStatus?.table_count!==undefined?' · '+itemStatus.table_count+(itemStatus.table_count===1?' table':' tables'):''}</span>
   </button>;
  })}</section>}
  {current&&<section className="n-panel db-browser-detail" aria-label="Selected database details"><div><p className="archive-kicker">Database details</p><h2>{current.name}</h2></div>
   <dl><div><dt>Status</dt><dd>{currentStatus?.state==='available'?'Available':currentStatus?.state==='missing'?'Not created':currentStatus?.state==='unavailable'?'Unavailable':'Checking…'}</dd></div><div><dt>Engine</dt><dd>{current.engine==='sqlite'?'SQLite':'PostgreSQL'}</dd></div><div><dt>Database</dt><dd>{currentStatus?.identifier||'—'}</dd></div><div><dt>Service</dt><dd>{currentStatus?.service||'Local file'}</dd></div><div><dt>Tables</dt><dd>{currentStatus?.table_count??'—'}</dd></div><div><dt>{current.engine==='sqlite'?'File size':'Database size'}</dt><dd>{currentStatus?.size_bytes===undefined?'—':formatBytes(currentStatus.size_bytes)}</dd></div><div><dt>Version</dt><dd>{currentStatus?.version||'—'}</dd></div></dl>
   {currentStatus?.detail&&<p className="db-browser-detail-error">{currentStatus.detail}</p>}
  </section>}
  {!!databases.length&&<div className="db-browser-workspace">
   <aside className="n-panel db-browser-sidebar" aria-label="Database tables">
    <label className="db-browser-label">Database<select value={current?.id} onChange={event=>chooseDatabase(event.target.value)}>{databases.map(item=><option key={item.id} value={item.id}>{item.name} · {item.engine==='sqlite'?'SQLite':'PostgreSQL'}</option>)}</select></label>
    <label className="db-browser-label">Find a table<input type="search" value={tableSearch} onChange={event=>setTableSearch(event.target.value)} placeholder="Filter table names…"/></label>
    {tables.error&&<Alert>Tables are unavailable. This database may be stopped.</Alert>}
    {!tables.data&&tables.loading&&<Skeleton className="chart-skeleton"/>}
    {tables.data&&!matchingTables.length&&<EmptyState title={allTables.length?'No matching tables':'No tables'}>{allTables.length?'Try another table name.':'This database has no tables yet.'}</EmptyState>}
    {!!matchingTables.length&&<div className="db-browser-table-list">{matchingTables.map(item=><button key={item.schema+'.'+item.name} type="button" className={selected?.schema===item.schema&&selected.name===item.name?'selected':undefined} aria-current={selected?.schema===item.schema&&selected.name===item.name?'true':undefined} onClick={()=>chooseTable(item)}><span>{item.schema}.{item.name}</span>{item.estimated_rows!==null&&<small>~{item.estimated_rows}</small>}</button>)}</div>}
   </aside>
   <section className="n-panel db-browser-rows" aria-labelledby="db-browser-title">
    <div className="db-browser-heading"><div><p className="archive-kicker">{current?.name}</p><h2 id="db-browser-title">{selected?selected.schema+'.'+selected.name:'Choose a table'}</h2></div>{page.data&&<Badge>{page.data.rows.length} rows on this page</Badge>}</div>
    {selected&&<form className="db-browser-filter" onSubmit={applyFilter}><label>Filter column<select value={filterColumn} onChange={event=>{setFilterColumn(event.target.value);setOffset(0);if(!event.target.value){setFilter('');setDraftFilter('');}}}><option value="">Choose a column</option>{page.data?.columns.map(column=><option key={column.name} value={column.name}>{column.name}</option>)}</select></label><label>Contains<input type="search" value={draftFilter} onChange={event=>setDraftFilter(event.target.value)} disabled={!filterColumn} placeholder="Text in column…"/></label><Button type="submit" disabled={!filterColumn}><Search size={14} aria-hidden="true"/>Filter</Button>{!!filter&&<Button onClick={()=>{setFilter('');setDraftFilter('');setOffset(0);}}>Clear</Button>}</form>}
    {page.error&&<Alert>Rows are unavailable. Try another table or refresh.</Alert>}
    {!page.data&&page.loading&&<Skeleton className="chart-skeleton"/>}
    {page.data&&!page.data.rows.length&&<EmptyState title="No rows match">Try another filter or table.</EmptyState>}
    {!!page.data?.rows.length&&<><Table className="db-browser-data" aria-label={'Rows in '+selected?.name}><thead><tr>{page.data.columns.map(column=><th key={column.name} aria-sort={sort===column.name?direction==='asc'?'ascending':'descending':'none'}><button type="button" onClick={()=>sortBy(column.name)} title={'Sort by '+column.name}>{column.name}{sort===column.name?(direction==='asc'?<ArrowUp size={13} aria-hidden="true"/>:<ArrowDown size={13} aria-hidden="true"/>):null}</button><small>{column.type}</small></th>)}</tr></thead><tbody>{page.data.rows.map((row,index)=><tr key={index}>{page.data!.columns.map(column=><td key={column.name} title={row[column.name]??undefined}>{row[column.name]??<span className="db-browser-null">NULL</span>}</td>)}</tr>)}</tbody></Table><div className="db-browser-pagination"><span>Rows {offset+1}–{offset+page.data.rows.length}. Cell previews are limited to {page.data.cell_limit} characters.</span><div><Button size="sm" disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-50))}>Previous</Button><Button size="sm" disabled={page.data.next_offset===null} onClick={()=>setOffset(page.data!.next_offset!)}>Next</Button></div></div></>}
   </section>
  </div>}
 </div>;
}

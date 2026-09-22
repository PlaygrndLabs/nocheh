import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Check,PencilLine,Search} from 'lucide-react';
import {useResource} from '../lib/resource';
import {CursorButtons} from '../lib/owner-controls';
import {Button,Badge,EmptyState,Alert,Skeleton,Table} from '../components/ui/primitives';
import {Source} from './source.js';

type RecordRow={id?:string;event_id?:string;derived_id?:string;scope:string;text?:string;snippet?:string;preview?:string;total?:number;ready?:number;channel?:string;kind?:string;received_at?:string};
type Records={records?:RecordRow[];results?:RecordRow[];items?:RecordRow[];next?:string}|RecordRow[];

const sourceFromHash=()=>new URLSearchParams(location.hash.split('?')[1]||'').get('source');
const recordText=(row:RecordRow)=>row.text||row.snippet||row.preview||'(No message text)';
const recordType=(row:RecordRow)=>row.kind?.replaceAll('_',' ')||row.channel?.replaceAll('_',' ')||'Message';

export function Archive({notify}:{notify:(message:string,error?:boolean)=>void}){
 const [draft,setDraft]=useState(''),[query,setQuery]=useState(''),[pages,setPages]=useState(['']),[selected,setSelected]=useState<string|null>(sourceFromHash);
 const detail=useRef<HTMLElement>(null);
 useEffect(()=>{const changed=()=>setSelected(sourceFromHash());addEventListener('hashchange',changed);return()=>removeEventListener('hashchange',changed);},[]);
 const after=pages.at(-1)||'',path=query?'/search?q='+encodeURIComponent(query):'/data'+(after?'?after='+encodeURIComponent(after):'');
 const {data,error,loading}=useResource<Records>(path),source=useResource<any>(selected?'/events/'+selected:null);
 const rows=Array.isArray(data)?data:data?.records||data?.results||data?.items||[],visible=rows.filter(row=>!row.derived_id);
 const next=!Array.isArray(data)?data?.next:null;
 const choose=(id:string|null,scroll=false)=>{
  setSelected(id);
  const suffix=id?'?source='+encodeURIComponent(id):'';
  if(location.hash!=='#archive'+suffix)location.hash='archive'+suffix;
  if(scroll)requestAnimationFrame(()=>detail.current?.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}));
 };
 const resetSelection=()=>choose(null);
 const submit=(event:FormEvent)=>{event.preventDefault();setQuery(draft.trim());setPages(['']);resetSelection();};
 const changePage=(value:string[])=>{setPages(value);resetSelection();};
 return <div>
  <section className="n-panel archive-search" aria-labelledby="archive-search-title">
   <div className="archive-search-copy"><h2 id="archive-search-title">Find a message</h2><p>Search the exact words you remember, or browse every original below.</p></div>
   <form className="search-toolbar" onSubmit={submit}>
    <label className="n-grow"><span className="n-sr-only">Search original messages</span><div className="search-input"><Search size={16} aria-hidden="true"/><input type="search" placeholder="Search original message text…" value={draft} onChange={event=>setDraft(event.target.value)}/></div></label>
    <Button type="submit" disabled={loading} variant="default">Search</Button>
    {query&&<Button onClick={()=>{setDraft('');setQuery('');setPages(['']);resetSelection();}}>Show all</Button>}
   </form>
  </section>
  <div className={'archive-workspace archive-table-workspace'+(selected?' has-selection':'')}>
   <section className="n-panel archive-list" aria-labelledby="archive-results-title">
    <div className="list-heading"><div><p className="archive-kicker">{query?'Search results':'Browse archive'}</p><h2 id="archive-results-title">Original messages</h2><p className="archive-table-help">Originals are read-only. Select View / edit to change the separate guarded copy used by agents.</p></div>{data&&<Badge>{visible.length} {visible.length===1?'message':'messages'}</Badge>}</div>
    {query&&<p className="archive-query-summary">Matching “{query}”</p>}
    {error&&<Alert>{data?'Results may be stale.':'Archive results are unavailable.'}</Alert>}
    {!data&&loading&&<Skeleton className="chart-skeleton"/>}
    {data&&!visible.length&&<EmptyState title={query?'No matching messages':'No archived messages'}>{query?'Try fewer words or show all messages.':'Original messages will appear here after they are captured.'}</EmptyState>}
    {!!visible.length&&<Table aria-label="Archive records"><thead><tr><th>Record</th><th>Type</th><th>Scope</th><th>Received</th><th>Agent copy</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
     {visible.map((row,index)=>{const id=row.event_id||row.id,isSelected=selected===id,ready=row.total!==undefined&&row.total>0&&row.ready===row.total;return <tr key={id||index} className={isSelected?'selected':undefined}>
      <td><span className="archive-record-text" dir="auto" title={recordText(row)}>{recordText(row)}</span></td><td>{recordType(row)}</td><td><code>{row.scope}</code></td><td>{row.received_at?<time dateTime={row.received_at}>{new Date(row.received_at).toLocaleString()}</time>:'—'}</td><td>{ready?<span className="archive-ready"><Check size={13} aria-hidden="true"/>Ready</span>:row.total!==undefined?<span>{row.ready} / {row.total} ready</span>:'—'}</td><td><Button size="sm" onClick={()=>id&&choose(id,true)} disabled={!id} aria-pressed={isSelected} aria-label={'View and edit record '+(id||index)}><PencilLine size={13} aria-hidden="true"/>View / edit</Button></td>
     </tr>;})}
    </tbody></Table>}
    {!query&&<CursorButtons pages={pages} next={next} onChange={changePage}/>}
   </section>
   <section ref={detail} className="archive-detail" aria-labelledby={selected?'archive-detail-title':undefined} aria-label={selected?undefined:'Message details'}>
    {selected?<>
     <div className="detail-heading"><div><p className="archive-kicker">Selected message</p><h2 id="archive-detail-title">Review and control</h2></div><Button size="sm" onClick={resetSelection}>Close</Button></div>
     <ol className="archive-flow" aria-label="How archived data is used"><li><span>1</span><div><strong>Original</strong><small>Permanent evidence</small></div></li><li><span>2</span><div><strong>Agent copy</strong><small>Editable and guarded</small></div></li><li><span>3</span><div><strong>Used by agents</strong><small>When guarding is on</small></div></li></ol>
     {source.error&&<Alert>The message is unavailable. Choose it again or refresh to retry.</Alert>}
     {!source.data&&!source.error&&<Skeleton className="chart-skeleton"/>}
     {source.data&&<Source record={source.data} notify={notify}/>}
    </>:<div className="n-panel archive-empty-detail"><EmptyState title="Choose a message">Select View / edit in the table to see original evidence, change the guarded agent copy, and inspect where each version is used.</EmptyState></div>}
   </section>
  </div>
 </div>;
}

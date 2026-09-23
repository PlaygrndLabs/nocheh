import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Check,Eye,Paperclip,Search,X} from 'lucide-react';
import {sourceContentLabel} from '../../src/source-content.js';
import {useResource} from '../lib/resource';
import {CursorButtons} from '../lib/owner-controls';
import {Button,Badge,EmptyState,Alert,Skeleton,Table} from '../components/ui/primitives';
import {StatusBadge} from '../components/status';
import {Source} from './source.js';

type RecordRow={id?:string;event_id?:string;derived_id?:string;scope:string;text?:string;snippet?:string;preview?:string;content_types?:string[];total?:number;ready?:number;channel?:string;kind?:string;received_at?:string;assistant_state?:string;assistant_stage?:string;assistant_error?:string;assistant_attempts?:number;action_review?:{id:string;state:string;count:number}};
type Records={records?:RecordRow[];results?:RecordRow[];items?:RecordRow[];next?:string}|RecordRow[];
type Scopes={scopes?:{scope:string;events:number}[]};

const sourceFromHash=()=>new URLSearchParams(location.hash.split('?')[1]||'').get('source');
const recordText=(row:RecordRow)=>[row.text,row.snippet,row.preview].find(value=>value?.trim())?.trim()||row.content_types?.map(sourceContentLabel).join(' · ')||'Message without text';
const recordType=(row:RecordRow)=>row.kind==='telegram_update'?'Incoming Telegram':row.kind==='browser_input'?'Browser message':row.kind?.endsWith('_delivered_message')?'Assistant reply':row.kind?.replaceAll('_',' ')||row.channel?.replaceAll('_',' ')||'Source record';
const replyState=(row:RecordRow)=>{
 if(row.kind!=='telegram_update')return null;
 const values:Record<string,{label:string;state:string;note?:string}>={done:{label:'Reply sent',state:'ready'},running:{label:'Processing',state:'running'},pending:{label:'Waiting',state:'queued'},failed:{label:'Retry scheduled',state:'retryable_failed',note:'Inngest will retry'},ambiguous:{label:'Delivery uncertain',state:'ambiguous',note:'Not auto-retried'},suppressed:{label:'No reply needed',state:'skipped'},cancelled:{label:'Cancelled',state:'cancelled'}};
 return values[row.assistant_state||'']||{label:'Not queued',state:'unknown'};
};
const actionLabels:Record<string,string>={proposed:'Approval pending',approved:'Approved · awaiting send',running:'Sending approved action',ambiguous:'Action delivery uncertain',done:'Action sent',rejected:'Action denied',cancelled:'Action cancelled'};

export function Archive({notify}:{notify:(message:string,error?:boolean)=>void}){
 const [draft,setDraft]=useState(''),[query,setQuery]=useState(''),[pages,setPages]=useState(['']),[selected,setSelected]=useState<string|null>(sourceFromHash);
 const [direction,setDirection]=useState('all'),[scope,setScope]=useState(''),[replyFilter,setReplyFilter]=useState('');
 const detail=useRef<HTMLElement>(null);
 useEffect(()=>{const changed=()=>setSelected(sourceFromHash());addEventListener('hashchange',changed);return()=>removeEventListener('hashchange',changed);},[]);
 const after=pages.at(-1)||'',parameters=new URLSearchParams({...(query?{q:query}:{}),...(after&&!query?{after}:{}),...(direction!=='all'?{kind:direction}:{}),...(scope?{scope}:{}),...(replyFilter?{reply:replyFilter}:{})});
 const path=(query?'/search':'/data')+(parameters.size?'?'+parameters:'');
 const {data,error,loading}=useResource<Records>(path),source=useResource<any>(selected?'/events/'+selected:null),scopes=useResource<Scopes>('/scopes');
 const rows=Array.isArray(data)?data:data?.records||data?.results||data?.items||[],visible=rows.filter(row=>!row.derived_id);
 const next=!Array.isArray(data)?data?.next:null;
 const filtersActive=direction!=='all'||!!scope||!!replyFilter;
 const choose=(id:string|null,scroll=false)=>{
  setSelected(id);
  const suffix=id?'?source='+encodeURIComponent(id):'';
  if(location.hash!=='#archive'+suffix)location.hash='archive'+suffix;
  if(scroll)requestAnimationFrame(()=>detail.current?.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}));
 };
 const resetSelection=()=>choose(null);
 const submit=(event:FormEvent)=>{event.preventDefault();setQuery(draft.trim());setPages(['']);resetSelection();};
 const changePage=(value:string[])=>{setPages(value);resetSelection();};
 const changeFilter=(setter:(value:string)=>void,value:string)=>{setter(value);setPages(['']);resetSelection();};
 const clearFilters=()=>{setDirection('all');setScope('');setReplyFilter('');setPages(['']);resetSelection();};
 return <div>
  <section className="n-panel archive-search" aria-labelledby="archive-search-title">
   <div className="archive-search-copy"><h2 id="archive-search-title">Find a message</h2><p>Search the exact words you remember, or browse every original below.</p><a className="archive-database-link" href="#databases">Browse raw database tables</a></div>
   <form className="search-toolbar" onSubmit={submit}>
    <label className="n-grow"><span className="n-sr-only">Search original messages</span><div className="search-input"><Search size={16} aria-hidden="true"/><input type="search" placeholder="Search original message text…" value={draft} onChange={event=>setDraft(event.target.value)}/></div></label>
    <Button type="submit" disabled={loading} variant="default">Search</Button>
    {query&&<Button onClick={()=>{setDraft('');setQuery('');setPages(['']);resetSelection();}}>Show all</Button>}
   </form>
  </section>
  <section className="archive-filters" aria-label="Archive filters">
   <div><strong>Showing source records</strong><span>Operational attempts and receipts stay in Monitoring.</span></div>
   <label>Record type<select value={direction} onChange={event=>changeFilter(setDirection,event.target.value)}><option value="all">All source records</option><option value="incoming">Incoming messages</option><option value="assistant">Assistant replies</option></select></label>
   <label>Conversation<select value={scope} onChange={event=>changeFilter(setScope,event.target.value)}><option value="">All conversations</option>{(scopes.data?.scopes||[]).map(item=><option key={item.scope} value={item.scope}>{item.scope} · {item.events}</option>)}</select></label>
   <label>Reply and action status<select value={replyFilter} onChange={event=>changeFilter(setReplyFilter,event.target.value)}><option value="">All states</option><option value="approval_pending">Approval pending</option><option value="pending">Waiting</option><option value="running">Processing</option><option value="failed">Retry scheduled</option><option value="done">Reply sent</option><option value="ambiguous">Delivery uncertain</option><option value="suppressed">No reply needed</option><option value="cancelled">Cancelled</option><option value="not_started">Not queued</option></select></label>
   <Button size="sm" onClick={clearFilters} disabled={!filtersActive}><X size={13} aria-hidden="true"/>Clear filters</Button>
  </section>
  <div className={'archive-workspace archive-table-workspace'+(selected?' has-selection':'')}>
   <section className="n-panel archive-list" aria-labelledby="archive-results-title">
    <div className="list-heading"><div><p className="archive-kicker">{query?'Search results':'Browse archive'}</p><h2 id="archive-results-title">Source records</h2><p className="archive-table-help">Original messages and other captured source evidence. Use the filters above to narrow this view.</p></div>{data&&<Badge>{visible.length} {visible.length===1?'record':'records'}</Badge>}</div>
    {query&&<p className="archive-query-summary">Matching “{query}”</p>}
    {error&&<Alert>{data?'Results may be stale.':'Archive results are unavailable.'}</Alert>}
    {!data&&loading&&<Skeleton className="chart-skeleton"/>}
    {data&&!visible.length&&<EmptyState title={filtersActive?'No messages match these filters':query?'No matching messages':'No archived messages'}>{filtersActive?'Clear or change a filter to see more source messages.':query?'Try fewer words or show all messages.':'Original messages will appear here after they are captured.'}</EmptyState>}
    {!!visible.length&&<Table aria-label="Archive records"><thead><tr><th>Record</th><th>Type</th><th>Scope</th><th>Received</th><th>Reply / action</th><th>Agent copy</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
     {visible.map((row,index)=>{const id=row.event_id||row.id,isSelected=selected===id,ready=row.total!==undefined&&row.total>0&&row.ready===row.total,reply=replyState(row);return <tr key={id||index} className={isSelected?'selected':undefined}>
      <td><div className="archive-record-content"><span className="archive-record-text" dir="auto" title={recordText(row)}>{recordText(row)}</span>{!!row.content_types?.length&&!![row.text,row.snippet,row.preview].find(value=>value?.trim())&&<span className="archive-content-types"><Paperclip size={13} aria-hidden="true"/>{row.content_types.map(sourceContentLabel).join(' · ')}</span>}</div></td><td>{recordType(row)}</td><td><code>{row.scope}</code></td><td>{row.received_at?<time dateTime={row.received_at}>{new Date(row.received_at).toLocaleString()}</time>:'—'}</td><td title={[row.assistant_stage,row.assistant_error,row.assistant_attempts?`attempt ${row.assistant_attempts}`:''].filter(Boolean).join(' · ')||undefined}>{reply||row.action_review?<span className="archive-reply-state">{row.action_review&&<><a href={'#activity?action='+encodeURIComponent(row.action_review.id)} className="archive-action-link"><StatusBadge state={row.action_review.state} label={actionLabels[row.action_review.state]||row.action_review.state}/></a>{row.action_review.state==='proposed'&&<small>Requested action not sent</small>}{row.action_review.count>1&&<small>{row.action_review.count} actions from this message</small>}</>}{reply&&<><StatusBadge state={reply.state} label={reply.label}/>{reply.note&&<small>{reply.note}</small>}</>}</span>:'—'}</td><td>{ready?<span className="archive-ready"><Check size={13} aria-hidden="true"/>Ready</span>:row.total!==undefined?<span>{row.ready} / {row.total} ready</span>:'—'}</td><td><Button size="sm" onClick={()=>id&&choose(id,true)} disabled={!id} aria-pressed={isSelected} aria-label={'Open message '+(id||index)}><Eye size={13} aria-hidden="true"/>Open</Button></td>
     </tr>;})}
    </tbody></Table>}
    {!query&&<CursorButtons pages={pages} next={next} onChange={changePage}/>}
   </section>
   <section ref={detail} className="archive-detail" aria-labelledby={selected?'archive-detail-title':undefined} aria-label={selected?undefined:'Message details'}>
    {selected?<>
     <div className="detail-heading"><div><p className="archive-kicker">Selected message</p><h2 id="archive-detail-title">Message details</h2><p>Read the original or edit the separate copy agents use.</p></div><Button size="sm" onClick={resetSelection}>Close</Button></div>
     {source.error&&<Alert>The message is unavailable. Choose it again or refresh to retry.</Alert>}
     {!source.data&&!source.error&&<Skeleton className="chart-skeleton"/>}
     {source.data&&<Source record={source.data} notify={notify}/>}
    </>:<div className="n-panel archive-empty-detail"><EmptyState title="Choose a message">Select Open to read the original message and, when needed, edit the separate agent copy.</EmptyState></div>}
   </section>
  </div>
 </div>;
}

import {useEffect,useState} from 'react';
import {Badge,Button,Alert,EmptyState,Sheet} from '../components/ui/primitives';
import {useResource} from '../lib/resource';
import {CursorButtons,EvidenceLinks,Provenance,ResourceState,useOwnerCommand} from '../lib/owner-controls';

type Entry={id:string;subject:string;kind:string;scope_kind:string;scope_id:string;active_revision:number;text:string;author:string;retired:boolean;revised_at:string;
 provenance:{learning:{uncertainty:string;evidence:{id:string}[];conflicts:string[]};native?:unknown}};
type Version={revision:number;text:string;author:string;retired:boolean;created_at:string;evidence:{id:string}[];provenance:unknown};
function MemoryEditor({entry,onSaved}:{entry:Entry;onSaved:()=>void}){
 const [base]=useState(entry),[text,setText]=useState(entry.text),command=useOwnerCommand();
 const save=async(retired:boolean)=>{const result=await command.run('/learned/'+base.id+'/correct',{expected_revision:base.active_revision,retired,...(!retired?{text}:{})});if(result)onSaved();};
 return <form className="owner-form" onSubmit={e=>{e.preventDefault();void save(false);}}>
  <h3>Owner correction</h3><p className="n-muted">Your correction takes precedence when this interpretation is used. Dependent memory is refreshed before reuse.</p>
  {entry.active_revision!==base.active_revision&&<Alert>A newer version is available. This draft still refers to revision {base.active_revision}. <Button onClick={onSaved}>Discard draft and load latest</Button></Alert>}
  <label>Corrected interpretation<textarea rows={5} value={text} onChange={e=>setText(e.target.value)} maxLength={8000} required disabled={command.busy}/></label>
  {command.error&&<Alert>{command.error}</Alert>}
  <div className="n-actions"><Button variant="default" type="submit" disabled={command.busy||!text.trim()}>{command.busy?'Saving…':base.retired?'Restore with correction':'Save correction'}</Button>
   {!base.retired&&<Button variant="destructive" disabled={command.busy} onClick={()=>void save(true)}>Retire interpretation</Button>}</div>
 </form>;
}
function MemoryDetail({entry}:{entry:Entry}){
 const [before,setBefore]=useState<number|null>(null),[edit,setEdit]=useState(0),history=useResource<{versions:Version[];next:number|null}>('/learned/'+entry.id+'/history'+(before?'?before='+before:''));
 const metadata=entry.provenance.learning;
 return <><p className="n-muted">{entry.scope_kind==='project'?'Project':'Conversation'} · <span className="owner-identifier">{entry.scope_id}</span></p>
 <p className="memory-prose">{entry.text}</p><div className="n-actions"><Badge>{entry.author==='owner'?'Owner corrected':metadata.uncertainty}</Badge><Badge>Revision {entry.active_revision}</Badge>{entry.retired&&<Badge>Retired</Badge>}</div>
 <h3>Supporting evidence</h3><EvidenceLinks sources={metadata.evidence}/>
 {metadata.conflicts.length>0&&<Alert>This interpretation conflicts with other learned versions. It is not a settled rule.<ul>{metadata.conflicts.map(id=><li key={id}><a href={'#learned?entry='+id}>Inspect conflicting interpretation</a></li>)}</ul></Alert>}
 <Provenance value={entry.provenance} label="Producer, evidence, and citation limits"/>
 <MemoryEditor key={entry.id+':'+edit} entry={entry} onSaved={()=>setEdit(v=>v+1)}/>
 <section><h3>Revision history</h3><ResourceState {...history} hasData={!!history.data}/>{history.data?.versions.map(version=><article className="owner-history" key={version.revision}>
  <div className="list-heading"><strong>Revision {version.revision}</strong><Badge>{version.retired?'Retired':version.author==='owner'?'Owner correction':version.author}</Badge></div>
  <small>{new Date(version.created_at).toLocaleString()}</small><p className="memory-prose">{version.text}</p><EvidenceLinks sources={version.evidence}/><Provenance value={version.provenance}/>
 </article>)}<div className="n-actions">{before&&<Button onClick={()=>setBefore(null)}>Latest history</Button>}<Button disabled={!history.data?.next} onClick={()=>setBefore(history.data!.next!)}>Older revisions</Button></div></section></>;
}
const selection=()=>new URLSearchParams(location.hash.split('?')[1]||'').get('entry')||'';
export function LearnedMemory(){
 const project=new URLSearchParams(location.hash.split('?')[1]||'').get('project');
 const [scopeKind,setScopeKind]=useState(project?'project':''),[scopeId,setScopeId]=useState(project||''),[filter,setFilter]=useState(''),[pages,setPages]=useState(['']),[selected,setSelected]=useState(selection),[trigger,setTrigger]=useState<HTMLElement|null>(null);
 const params=new URLSearchParams({after:pages.at(-1)!});if(scopeKind&&scopeId.trim()){params.set('scope_kind',scopeKind);params.set('scope_id',scopeId.trim());}
 const entries=useResource<{entries:Entry[];next:string|null}>('/learned?'+params),selectedData=useResource<{active_revision:number;versions:Version[];entry:Entry|null}> (selected?'/learned/'+selected:null);
 useEffect(()=>{const changed=()=>{setSelected(selection());const project=new URLSearchParams(location.hash.split('?')[1]||'').get('project');if(project){setScopeKind('project');setScopeId(project);setPages(['']);}};addEventListener('hashchange',changed);return()=>removeEventListener('hashchange',changed);},[]);
 const row=entries.data?.entries.find(e=>e.id===selected),version=selectedData.data?.versions.find(v=>v.revision===selectedData.data?.active_revision),metadata=(version?.provenance as any)?.learning;
 const detail:Entry|null=selectedData.data?.entry??(version&&metadata?{...row,id:selected,subject:metadata.subject,kind:metadata.kind,scope_kind:metadata.scope.kind,scope_id:metadata.scope.id,
  text:version.text,author:version.author,retired:version.retired,active_revision:version.revision,revised_at:version.created_at,provenance:version.provenance as Entry['provenance']}:row??null);
 const visible=entries.data?.entries.filter(e=>!filter?true:filter==='retired'?e.retired:!e.retired&&(filter==='conflicts'?e.provenance.learning.conflicts.length>0:e.provenance.learning.uncertainty===filter))??[];
 return <><section className="n-panel"><div className="search-toolbar"><label>Scope<select value={scopeKind} onChange={e=>{setScopeKind(e.target.value);setPages(['']);}}><option value="">All scopes</option><option value="conversation">Conversation</option><option value="project">Project</option></select></label>
 {scopeKind&&<label className="n-grow">{scopeKind==='project'?'Project identifier':'Chat or topic identifier'}<input value={scopeId} onChange={e=>{setScopeId(e.target.value);setPages(['']);}} placeholder={scopeKind==='project'?'Copy from Projects':'Chat ID or chat/topic/ID'}/></label>}
 <label>Show on this page<select value={filter} onChange={e=>setFilter(e.target.value)}><option value="">All interpretations</option><option value="uncertain">Uncertain</option><option value="supported">Supported</option><option value="explicit">Explicit conventions</option><option value="conflicts">Conflicts</option><option value="retired">Retired</option></select></label></div>
 <p className="n-muted">Meanings and states learned from permitted conversations. Learning does not send messages or perform actions.</p></section>
 <ResourceState {...entries} hasData={!!entries.data}/><section className="n-panel"><div className="list-heading"><h2>Learned interpretations</h2><Badge>{visible.length} on this page</Badge></div>
 {entries.data&&!visible.length&&<EmptyState title="No interpretations in this view">Choose another scope or filter. New learning appears after permitted evidence is processed.</EmptyState>}
 <div className="owner-records">{visible.map(entry=><article key={entry.id}><div className="list-heading"><h3>{entry.subject}</h3><Badge>{entry.retired?'Retired':entry.author==='owner'?'Owner corrected':entry.provenance.learning.uncertainty}</Badge></div>
  <small>{entry.kind} · {entry.scope_kind} <span className="owner-identifier">{entry.scope_id}</span></small><p className="memory-prose">{entry.text}</p>
  {entry.provenance.learning.conflicts.length>0&&<p className="owner-conflict">Conflicting interpretations need review</p>}
  <Button onClick={e=>{setTrigger(e.currentTarget);setSelected(entry.id);}}>Inspect and correct</Button></article>)}</div>
 <CursorButtons pages={pages} next={entries.data?.next} onChange={setPages}/></section>
 <Sheet open={!!selected} onOpenChange={open=>{if(!open){setSelected('');if(selection())history.replaceState(null,'','#learned');}}} title={detail?.subject||'Learned interpretation'} returnFocus={trigger}>
  <ResourceState {...selectedData} hasData={!!detail}/>{detail&&<MemoryDetail key={selected} entry={detail}/>}</Sheet></>;
}

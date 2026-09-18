import {useEffect,useState} from 'react';
import {Alert,Badge,Button,EmptyState} from '../components/ui/primitives';
import {refreshResources,useResource} from '../lib/resource';
import {CursorButtons,Provenance,ResourceState,useOwnerCommand} from '../lib/owner-controls';
import {replaceRepeated} from '../guarded-editor.js';

type Version={id:string;artifact_id:string|null;kind:string;created_at:string;producer:string;producer_version:string;guard_revision:number|null;selection_revision:number|null;active:boolean;provenance:unknown};
function GuardForm({path,latest,onSaved}:{path:string;latest:any;onSaved:()=>void}){
 const [base]=useState(latest),initial=base.content??base.input,[text,setText]=useState(initial.text??''),[fields,setFields]=useState(JSON.stringify(Object.fromEntries(Object.entries(initial).filter(([key])=>key!=='text')),null,2));
 const [history,setHistory]=useState(false),[before,setBefore]=useState<number|null>(null),[selected,setSelected]=useState<number|null>(null),[parseError,setParseError]=useState(''),command=useOwnerCommand();
 const versions=useResource<{revisions:{revision:number;author:string;created_at:string}[];next:number|null}>(history?path+'/history'+(before?'?before='+before:''):null),old=useResource<any>(selected?path+'/revisions/'+selected:null);
 const save=async(restore?:number)=>{
  setParseError('');let body:Record<string,unknown>={expected_revision:base.active_revision};
  if(restore)body.restore_revision=restore;
  else try {const parsed=JSON.parse(fields);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();body.content=replaceRepeated({...parsed,...('text' in initial?{text}:{})},initial.text??null,text);}
  catch {setParseError('Other guarded fields must contain a JSON object. Your text is retained.');return;}
  if(await command.run(path,body))onSaved();
 };
 return <div className="owner-form"><div className="n-actions"><Badge>{base.active_revision?'Revision '+base.active_revision:'First guarded version'}</Badge><Badge>{base.author==='owner'?'Owner edited':'Automatic'}</Badge></div>
 {latest.active_revision!==base.active_revision&&<Alert>A newer version is available. This draft keeps revision {base.active_revision}. <Button onClick={onSaved}>Discard draft and load latest</Button></Alert>}
 <details><summary>Read the immutable input</summary><pre className="n-data" dir="auto">{'text' in initial?base.input.text:JSON.stringify(base.input,null,2)}</pre></details>
 {'text' in initial&&<label>Guarded text<textarea rows={6} dir="auto" value={text} onChange={e=>setText(e.target.value)} disabled={command.busy}/></label>}
 <details><summary>Other guarded fields</summary><label>Fields as JSON<textarea rows={8} value={fields} onChange={e=>setFields(e.target.value)} disabled={command.busy}/></label></details>
 <p className="n-muted">Saved owner wording is authoritative. Later engines create separate versions and do not carry this edit onto different text.</p>
 {(command.error||parseError)&&<Alert>{command.error||parseError}</Alert>}
 <div className="n-actions"><Button variant="default" disabled={command.busy} onClick={()=>void save()}>{command.busy?'Saving…':'Save guarded version'}</Button><Button onClick={()=>setHistory(v=>!v)} aria-expanded={history}>Revision history</Button></div>
 {history&&<section><h4>Guarded history</h4><ResourceState {...versions} hasData={!!versions.data}/>{versions.data?.revisions.map(v=><div className="owner-history list-heading" key={v.revision}><span>Revision {v.revision} · {v.author}<small>{new Date(v.created_at).toLocaleString()}</small></span><Button onClick={()=>setSelected(v.revision)}>View revision {v.revision}</Button></div>)}
 <div className="n-actions">{before&&<Button onClick={()=>setBefore(null)}>Latest history</Button>}<Button disabled={!versions.data?.next} onClick={()=>setBefore(versions.data!.next)}>Older revisions</Button></div>
 {selected&&<section><ResourceState {...old} hasData={!!old.data}/>{old.data&&<><h4>Revision {selected}</h4><pre className="n-data" dir="auto">{old.data.content.text??JSON.stringify(old.data.content,null,2)}</pre><Button disabled={command.busy||selected===base.active_revision} onClick={()=>void save(selected)}>Restore as new revision</Button></>}</section>}</section>}</div>;
}
export function GuardVersion({kind,id,label}:{kind:string;id:string;label:string}){
 const path='/guards/'+kind+'/'+id,guard=useResource<any>(path),[form,setForm]=useState(0);
 return <section className="owner-guard"><h3>{label}</h3><ResourceState {...guard} hasData={!!guard.data}/>{guard.data?.input?<GuardForm key={path+':'+form} path={path} latest={guard.data} onSaved={()=>setForm(v=>v+1)}/>:guard.data&&<p className="n-muted">Preparation has not saved an input for this record yet.</p>}</section>;
}
function VersionDetail({version}:{version:Version}){
 const data=useResource<any>('/derivatives/'+version.id),command=useOwnerCommand(),activatable=['transcript','extracted_text','extraction_status'].includes(version.kind);
 return <div className="owner-form"><ResourceState {...data} hasData={!!data.data}/>{data.data&&<><h4>Generated output</h4><pre className="n-data" dir="auto">{new TextDecoder().decode(Uint8Array.from(atob(data.data.content_base64),c=>c.charCodeAt(0)))}</pre><Provenance value={{producer:data.data.producer,version:data.data.producer_version,source_revision:data.data.source_revision,input_hash:data.data.input_hash,configuration_fingerprint:data.data.configuration_hash,...data.data.provenance}}/>
 <GuardVersion kind="derived_artifacts" id={version.id} label="Guarded derivative"/>
 {command.error&&<Alert>{command.error}</Alert>}{activatable&&<Button variant="default" disabled={command.busy||version.active||!version.guard_revision} onClick={()=>void command.run('/derivatives/'+version.id+'/activate',{expected_revision:version.selection_revision})}>{version.active?'Active version':command.busy?'Activating…':'Activate prepared version'}</Button>}
 {activatable&&<p className="n-muted">Activation refreshes dependent memory. Previous outputs and their owner edits stay in history.</p>}</>}</div>;
}
export function SourceVersions({record}:{record:any}){
 const [view,setView]=useState('readings'),[pages,setPages]=useState(['']),[selected,setSelected]=useState(''),[file,setFile]=useState(''),[engine,setEngine]=useState(''),[job,setJob]=useState(''),[polling,setPolling]=useState(false),command=useOwnerCommand();
 const versions=useResource<{versions:Version[];next:string|null}>('/sources/'+record.id+'/derivatives?view='+view+'&after='+pages.at(-1)),engines=useResource<{engines:{producer:string;producer_version:string;kind:string}[]}>('/derivation-engines');
 const reprocess=useResource<{state:string;error_code?:string;result_id?:string}>(job?'/reprocessing/'+job:null,job&&polling?3000:0);
 useEffect(()=>{if(polling&&['done','failed'].includes(reprocess.data?.state??'')){setPolling(false);void refreshResources();}},[polling,reprocess.data?.state]);
 const choice=versions.data?.versions.find(v=>v.id===selected),original=record.artifacts.find((a:any)=>a.id===file),producer=engines.data?.engines.find(e=>e.producer+'@'+e.producer_version===engine);
 return <><section className="n-panel"><div className="list-heading"><h2>Guarded representations</h2><Button disabled={command.busy} onClick={()=>void command.run('/sources/'+record.id+'/prepare',{},false)}>Prepare source</Button></div>
 <p className="n-muted">Original evidence is immutable. Agents use the current guarded representations when guarding is enabled.</p><GuardVersion kind="events" id={record.id} label="Message"/>
 {record.artifacts.filter((a:any)=>a.state==='ready').map((a:any)=><details key={a.id}><summary>Guarded file information · {a.metadata?.file_name||a.kind}</summary><GuardVersion kind="artifacts" id={a.id} label="File information"/></details>)}</section>
 <section className="n-panel"><h2>Generated versions</h2><label>Version view<select value={view} onChange={e=>{setView(e.target.value);setPages(['']);setSelected('');}}><option value="readings">File readings</option><option value="all">All derivatives, including internal preparation</option></select></label><p className="n-muted">Transcripts and extracted text are replaceable readings of the original file.</p><ResourceState {...versions} hasData={!!versions.data}/>
 {versions.data&&!versions.data.versions.length&&<EmptyState title="No generated versions">Reprocess an original file to create a version.</EmptyState>}
 <div className="owner-records">{versions.data?.versions.map(version=><article key={version.id}><div className="list-heading"><h3>{version.kind.replaceAll('_',' ')}</h3><Badge>{version.active?'Active':version.guard_revision?'Prepared':'Guard preparation pending'}</Badge></div><p>{version.producer} · {version.producer_version}</p><small>{new Date(version.created_at).toLocaleString()}</small><Button onClick={()=>setSelected(selected===version.id?'':version.id)} aria-expanded={selected===version.id}>Inspect version and history</Button>{selected===version.id&&choice&&<VersionDetail key={choice.id} version={choice}/>}</article>)}</div>
 <CursorButtons pages={pages} next={versions.data?.next} onChange={setPages}/></section>
 {record.artifacts.length>0&&<section className="n-panel"><h2>Reprocess an original file</h2><form className="owner-form" onSubmit={e=>{e.preventDefault();if(!original||!producer)return;void command.run('/sources/'+record.id+'/reprocess',{artifact_id:original.id,input_hash:original.file_hash,producer:producer.producer,producer_version:producer.producer_version,configuration:{}}).then(result=>{if(result){setPolling(true);setJob(result.id);}});}}>
 <label>Original file<select value={file} required onChange={e=>setFile(e.target.value)} disabled={command.busy}><option value="">Choose a file</option>{record.artifacts.map((a:any)=><option key={a.id} value={a.id} disabled={!a.file_hash}>{a.metadata?.file_name||a.kind}{!a.file_hash?' (waiting for original bytes)':''}</option>)}</select></label>
 <ResourceState {...engines} hasData={!!engines.data}/><label>Engine and version<select value={engine} required onChange={e=>setEngine(e.target.value)} disabled={command.busy}><option value="">Choose an engine</option>{engines.data?.engines.map(e=><option key={e.producer+'@'+e.producer_version} value={e.producer+'@'+e.producer_version}>{e.producer} · {e.producer_version}</option>)}</select></label>
 <Button variant="default" type="submit" disabled={command.busy||!original?.file_hash||!producer}>{command.busy?'Submitting…':'Create a new version'}</Button></form>
 {job&&<div role="status"><ResourceState {...reprocess} hasData={!!reprocess.data}/><p>Reprocessing: {reprocess.data?.state?.replaceAll('_',' ')??'Loading status'}</p>{reprocess.data?.state==='done'&&<p>The version is saved. Review its guarded text above before activating it.</p>}</div>}</section>}
 {command.error&&<Alert>{command.error}</Alert>}</>;
}

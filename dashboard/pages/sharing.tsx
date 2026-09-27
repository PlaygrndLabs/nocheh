import {useRef,useState} from 'react';
import {Badge,Button,Alert,EmptyState,Sheet,Tabs,TabsList,TabsTrigger,TabsContent} from '../components/ui/primitives';
import {useResource} from '../lib/resource';
import {CursorButtons,EvidenceLinks,Provenance,ResourceState,useOwnerCommand} from '../lib/owner-controls';
import {sourceContentLabel} from '../../src/source-content.js';

type Rule={id:string;name:string;sources:string[];destination:string;enabled:boolean;mode:'approved'|'filtered';instructions:string;revision:number};
type Preview={id:string;rule_id:string;rule_revision:number;state:string;created_at:string;text?:string;current?:boolean;guard_revision?:number|null;text_hash?:string;
 input?:{rule:Rule;sources:{id:string}[]};output_provenance?:unknown};
type Release={id:string;preview_id:string;rule_id:string;state:string;mode:string;revision:number;expires_at:string|null;created_at:string};
const values=(text:string)=>[...new Set(text.split(/[\n,]/).map(v=>v.trim()).filter(Boolean))];
const sourceLabel=(row:{text?:string;preview?:string;content_types?:string[]})=>row.text?.trim()||row.preview?.trim()||row.content_types?.map(sourceContentLabel).join(' · ')||'Message without text';
function RuleEditor({rule,onSaved}:{rule:Rule|null;onSaved:()=>void}){
 const [name,setName]=useState(rule?.name||''),[sources,setSources]=useState(rule?.sources.join('\n')||''),[destination,setDestination]=useState(rule?.destination||''),[enabled,setEnabled]=useState(rule?.enabled??false),[mode,setMode]=useState(rule?.mode??'approved'),[instructions,setInstructions]=useState(rule?.instructions||''),command=useOwnerCommand();
 return <form className="owner-form" onSubmit={e=>{e.preventDefault();void command.run('/sharing/rules',{...(rule?{id:rule.id}:{}),name,sources:values(sources),destination,enabled,mode,instructions,expected_revision:rule?.revision??0}).then(result=>{if(result)onSaved();});}}>
 <label>Rule name<input value={name} required maxLength={200} onChange={e=>setName(e.target.value)} disabled={command.busy}/></label>
 <label>Source conversations<textarea rows={3} value={sources} onChange={e=>setSources(e.target.value)} placeholder="One chat ID or chat/topic/ID per line" required disabled={command.busy}/><small>Only these exact chats or topics may contribute. Projects do not expand this selection.</small></label>
 <label>Destination conversation<input value={destination} required onChange={e=>setDestination(e.target.value)} placeholder="Chat ID or chat/topic/ID" disabled={command.busy}/></label>
 <label>Sharing mode<select value={mode} onChange={e=>setMode(e.target.value as Rule['mode'])} disabled={command.busy}><option value="approved">Owner approves exact text</option><option value="filtered">Filter permitted knowledge automatically</option></select></label>
 <p className="n-muted">{mode==='approved'?'Prepare a preview and approve its exact wording before the destination can retrieve it.':'Relevant selected sources pass through the privacy filter. Uncertain or private information is withheld.'}</p>
 <label>Additional privacy instructions<textarea rows={4} value={instructions} maxLength={4000} onChange={e=>setInstructions(e.target.value)} disabled={command.busy}/></label>
 <label className="owner-check"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)} disabled={command.busy}/>Enable this rule</label>
 <p className="n-muted">Changes revoke affected contexts. Disabling a rule immediately withholds its shares.</p>
 {command.error&&<Alert>{command.error}</Alert>}<Button type="submit" variant="default" disabled={command.busy||!name.trim()||!sources.trim()||!destination.trim()}>{command.busy?'Saving…':'Save sharing rule'}</Button></form>;
}
function PreviewForm({rule,onPreview}:{rule:Rule;onPreview:(id:string,trigger:HTMLElement)=>void}){
 const [draft,setDraft]=useState(''),[query,setQuery]=useState(''),[chosen,setChosen]=useState<{id:string;text:string}[]>([]),[text,setText]=useState(''),command=useOwnerCommand();
 const originals=useResource<any>(query?'/search?q='+encodeURIComponent(query):'/data');
 const rows=(Array.isArray(originals.data)?originals.data:originals.data?.records??[]).filter((r:any)=>!r.derived_id);
 const preview=async(trigger:HTMLElement)=>{const result=await command.run('/sharing/preview',{rule_id:rule.id,expected_revision:rule.revision,source_ids:chosen.map(c=>c.id),query,
  ...(rule.mode==='approved'?{content:text}:{})});if(result)onPreview(result.id,trigger);};
 return <div className="owner-form"><p><strong>{rule.name}</strong> · {rule.mode==='approved'?'Exact owner approval':'Privacy filtered'} · destination <span className="owner-identifier">{rule.destination}</span></p>
 <form className="search-toolbar" onSubmit={e=>{e.preventDefault();setQuery(draft.trim());}}><label className="n-grow">Find original evidence<input type="search" value={draft} onChange={e=>setDraft(e.target.value)} placeholder="Search original messages…"/></label><Button type="submit">Find sources</Button></form>
 <ResourceState {...originals} hasData={!!originals.data}/><div className="source-picker" role="group" aria-label="Select original evidence">{rows.slice(0,40).map((row:any)=>{
  const id=row.event_id||row.id,checked=chosen.some(c=>c.id===id);return <label key={id} className="owner-check"><input type="checkbox" checked={checked} disabled={command.busy||!checked&&chosen.length>=10}
   onChange={e=>setChosen(current=>e.target.checked?[...current,{id,text:sourceLabel(row)}]:current.filter(c=>c.id!==id))}/><span>{sourceLabel(row)}<small>Conversation {row.space||row.scope}</small></span></label>;
 })}</div>{originals.data&&!rows.length&&<EmptyState title="No originals found">Try different source text. Select sources from the conversations allowed by this rule.</EmptyState>}
 <div className="n-actions"><Badge>{chosen.length} of 10 selected</Badge>{chosen.length>0&&<Button size="sm" onClick={()=>setChosen([])}>Clear selection</Button>}</div>
 {chosen.length>0&&<details><summary>Selected evidence</summary><ul>{chosen.map(c=><li key={c.id}><span>{c.text}</span> <Button size="sm" onClick={()=>setChosen(v=>v.filter(s=>s.id!==c.id))}>Remove</Button></li>)}</ul></details>}
 {rule.mode==='approved'&&<label>Text to share<textarea rows={6} value={text} maxLength={12000} onChange={e=>setText(e.target.value)} disabled={command.busy}/><small>You will review the prepared wording before approving it.</small></label>}
 {!rule.enabled&&<p className="n-muted">This rule is disabled. You can inspect a preview; enable the rule and prepare a fresh preview before publishing.</p>}
 {command.error&&<Alert>{command.error}</Alert>}<Button variant="default" disabled={command.busy||!chosen.length||rule.mode==='approved'&&!text.trim()} onClick={e=>void preview(e.currentTarget)}>{command.busy?'Preparing preview…':'Prepare preview'}</Button></div>;
}
function PreviewDetail({id,onApproved}:{id:string;onApproved:()=>void}){
 const resource=useResource<Preview>('/sharing/previews/'+id),command=useOwnerCommand(),preview=resource.data;
 return <><ResourceState {...resource} hasData={!!preview}/>{preview&&<div className="owner-form"><div className="n-actions"><Badge>{preview.input?.rule.mode==='approved'?'Owner approval':'Filtered inference'}</Badge><Badge>{preview.current?'Current inputs':'Inputs changed'}</Badge></div>
 <p>Destination <strong className="owner-identifier">{preview.input?.rule.destination}</strong></p>
 {preview.state!=='ready'?<Alert>This preview is not prepared. Retry its original request to finish preparation.</Alert>:<><h3>Exact prepared text</h3><pre className="n-source memory-prose" dir="auto">{preview.text||'(Nothing can be shared)'}</pre>
 <p className="n-muted">The destination receives this representation. Original evidence and private provenance remain owner-only.</p></>}
 <EvidenceLinks sources={preview.input?.sources??[]}/><Provenance value={preview.output_provenance} label="Version and producer provenance"/>
 {command.error&&<Alert>{command.error}</Alert>}{preview.input?.rule.mode==='approved'&&<Button variant="default" disabled={command.busy||!preview.current||preview.state!=='ready'||!preview.input.rule.enabled||!preview.text?.trim()}
 onClick={()=>void command.run('/sharing/previews/'+id+'/approve',{expected_revision:preview.rule_revision,guard_revision:preview.guard_revision,text_hash:preview.text_hash}).then(result=>{if(result)onApproved();})}>{command.busy?'Approving…':'Approve this exact text'}</Button>}
 {preview.input?.rule.mode==='filtered'&&<p className="n-muted">This is an inspection preview. Enabled filtered rules prepare short-lived representations when the destination asks for relevant knowledge.</p>}
 </div>}</>;
}
export function Sharing(){
 const releasesTab=useRef<HTMLButtonElement>(null);
 const [pages,setPages]=useState(['']),[previewPages,setPreviewPages]=useState(['']),[releasePages,setReleasePages]=useState(['']),[editor,setEditor]=useState<Rule|'new'|null>(null),[selectedRule,setSelectedRule]=useState(''),[preview,setPreview]=useState(''),[trigger,setTrigger]=useState<HTMLElement|null>(null),[tab,setTab]=useState('rules'),command=useOwnerCommand();
 const rules=useResource<{rules:Rule[];next:string|null}>('/sharing/rules?after='+pages.at(-1)),previews=useResource<{previews:Preview[];next:string|null}>('/sharing/previews?after='+previewPages.at(-1)),releases=useResource<{releases:Release[];next:string|null}>('/sharing/releases?after='+releasePages.at(-1));
 const rule=rules.data?.rules.find(r=>r.id===selectedRule),name=(id:string)=>rules.data?.rules.find(r=>r.id===id)?.name??'Sharing rule';
 return <><section className="n-panel"><div className="list-heading"><div><h2>Explicit sharing</h2><p className="n-muted">Choose what other conversations can retrieve. Creating a project does not grant access.</p></div><Button variant="default" onClick={e=>{setTrigger(e.currentTarget);setEditor('new');}}>New sharing rule</Button></div></section>
 <Tabs value={tab} onValueChange={setTab}><TabsList aria-label="Sharing views"><TabsTrigger value="rules">Rules</TabsTrigger><TabsTrigger value="previews">Previews</TabsTrigger><TabsTrigger ref={releasesTab} value="releases">Released text</TabsTrigger></TabsList>
 <TabsContent value="rules"><section className="n-panel"><ResourceState {...rules} hasData={!!rules.data}/>{rules.data&&!rules.data.rules.length&&<EmptyState title="No sharing rules">Create a rule with explicit sources and a destination.</EmptyState>}
 <div className="owner-records">{rules.data?.rules.map(r=><article key={r.id}><div className="list-heading"><h3>{r.name}</h3><Badge>{r.enabled?'Enabled':'Disabled'}</Badge></div><p>{r.mode==='approved'?'Owner approves exact text':'Automatic privacy filter'} · {r.sources.length} source conversations</p><p>Destination <span className="owner-identifier">{r.destination}</span></p>
 <div className="n-actions"><Button onClick={e=>{setTrigger(e.currentTarget);setEditor(r);}}>Edit rule</Button><Button onClick={()=>setSelectedRule(r.id)}>Prepare a preview</Button></div></article>)}</div><CursorButtons pages={pages} next={rules.data?.next} onChange={setPages}/></section>
 {rule&&<section className="n-panel"><div className="list-heading"><h2>Prepare shared text</h2><Button onClick={()=>setSelectedRule('')}>Close preview form</Button></div><PreviewForm key={rule.id+':'+rule.revision} rule={rule} onPreview={(id,button)=>{setTrigger(button);setPreview(id);}}/></section>}</TabsContent>
 <TabsContent value="previews"><section className="n-panel"><h2>Preview history</h2><ResourceState {...previews} hasData={!!previews.data}/>{previews.data&&!previews.data.previews.length&&<EmptyState title="No previews yet">Prepare a preview from a sharing rule.</EmptyState>}
 <div className="owner-records">{previews.data?.previews.map(p=><article key={p.id}><div className="list-heading"><h3>{name(p.rule_id)}</h3><Badge>{p.state==='ready'?'Prepared':'Preparation pending'}</Badge></div><p>Rule revision {p.rule_revision} · {new Date(p.created_at).toLocaleString()}</p><Button onClick={e=>{setTrigger(e.currentTarget);setPreview(p.id);}}>Inspect preview</Button></article>)}</div><CursorButtons pages={previewPages} next={previews.data?.next} onChange={setPreviewPages}/></section></TabsContent>
 <TabsContent value="releases"><section className="n-panel"><h2>Released representations</h2><ResourceState {...releases} hasData={!!releases.data}/>{command.error&&<Alert>{command.error}</Alert>}{releases.data&&!releases.data.releases.length&&<EmptyState title="Nothing has been released">Approve a prepared preview or enable a filtered sharing rule.</EmptyState>}
 <div className="owner-records">{releases.data?.releases.map(r=><article key={r.id}><div className="list-heading"><h3>{name(r.rule_id)}</h3><Badge>{r.state==='revoked'?'Revoked':r.expires_at&&Date.parse(r.expires_at)<Date.now()?'Expired':'Released'}</Badge></div><p>{r.mode==='approved'?'Owner approved':'Privacy filtered'} · {new Date(r.created_at).toLocaleString()}</p>
 <small>Availability also depends on current rules, guards, and source versions.</small><div className="n-actions"><Button onClick={e=>{setTrigger(e.currentTarget);setPreview(r.preview_id);}}>Inspect text and provenance</Button><Button variant="destructive" disabled={r.state!=='active'||command.busy} onClick={()=>void command.run('/sharing/releases/'+r.id+'/revoke',{expected_revision:r.revision})}>Revoke access</Button></div></article>)}</div><CursorButtons pages={releasePages} next={releases.data?.next} onChange={setReleasePages}/></section></TabsContent></Tabs>
 <Sheet open={!!editor} onOpenChange={open=>{if(!open)setEditor(null);}} title={editor==='new'?'Create sharing rule':'Edit sharing rule'} returnFocus={trigger}>{editor&&<RuleEditor key={editor==='new'?'new':editor.id} rule={editor==='new'?null:editor} onSaved={()=>setEditor(null)}/>}</Sheet>
 <Sheet open={!!preview} onOpenChange={open=>{if(!open)setPreview('');}} title="Sharing preview" returnFocus={trigger}>{preview&&<PreviewDetail key={preview} id={preview} onApproved={()=>{setTrigger(releasesTab.current);setPreview('');setTab('releases');}}/>}</Sheet></>;
}

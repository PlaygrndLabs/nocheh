import {useState} from 'react';
import {Alert,Badge,Button,EmptyState,Sheet} from '../components/ui/primitives';
import {CursorButtons,EvidenceLinks,Provenance,ResourceState,useOwnerCommand} from '../lib/owner-controls';
import {useResource} from '../lib/resource';

type Entity={id:string;kind:'person'|'project';name:string;state:'active'|'merged'|'rejected';project_id:string|null;merged_into:string|null;revision:number};
type Claim={id:string;subject_entity_id:string;object_entity_id:string|null;predicate:string;revision:number;content:string;relationship_kind:string|null;
 attribution:'direct'|'reported'|'inferred';speaker_entity_id:string|null;uncertainty:string;author:string;retired:boolean;evidence:{id:string}[];created_at:string};
type Detail={entity:Entity;bindings:unknown[];claims:Claim[];partial:boolean};
type Suggestion={id:string;kind:'person'|'project'|'binding';name:string;candidate_entity_id:string|null;reason:string;revision:number;source_reference:{id:string}};

function ClaimHistory({id}:{id:string}){
 const history=useResource<{versions:Claim[];next:number|null}>('/entities/claims/'+id+'/history');
 return <details><summary>Correction history</summary><ResourceState {...history} hasData={!!history.data}/><div className="owner-records">{history.data?.versions.map(version=><article key={version.revision}><div className="list-heading"><strong>Revision {version.revision}</strong><Badge>{version.retired?'Retired':version.author==='owner'?'Owner correction':version.attribution}</Badge></div><p>{version.content}</p><EvidenceLinks sources={version.evidence}/></article>)}</div></details>;
}

function ClaimEditor({claim,onSaved}:{claim:Claim;onSaved:()=>void}){
 const [base]=useState(claim),[content,setContent]=useState(claim.content),[attribution,setAttribution]=useState(claim.attribution),[uncertainty,setUncertainty]=useState(claim.uncertainty),command=useOwnerCommand();
 const save=async(retired:boolean)=>{const result=await command.run('/entities/claims/'+base.id+'/correct',{content,attribution,uncertainty,retired,expected_revision:base.revision});if(result)onSaved();};
 return <form className="owner-form" onSubmit={event=>{event.preventDefault();void save(false);}}><label>Corrected memory<textarea rows={4} maxLength={8000} value={content} onChange={event=>setContent(event.target.value)} required/></label>
  <div className="search-toolbar"><label>Attribution<select value={attribution} onChange={event=>setAttribution(event.target.value as Claim['attribution'])}><option value="direct">Direct statement</option><option value="reported">Reported by someone else</option><option value="inferred">Model inference</option></select></label>
  <label>Certainty<select value={uncertainty} onChange={event=>setUncertainty(event.target.value)}><option value="uncertain">Uncertain</option><option value="supported">Supported</option><option value="explicit">Explicit</option></select></label></div>
  {command.error&&<Alert>{command.error}</Alert>}<div className="n-actions"><Button variant="default" type="submit" disabled={command.busy||!content.trim()}>Save correction</Button>{!base.retired&&<Button variant="destructive" disabled={command.busy} onClick={()=>void save(true)}>Retire memory</Button>}</div></form>;
}
function EntityDetail({id}:{id:string}){
 const [revision,setRevision]=useState(0),detail=useResource<Detail>('/entities/'+id,0,revision),[mergeTarget,setMergeTarget]=useState(''),command=useOwnerCommand();
 const entity=detail.data?.entity;
 const merge=async()=>{if(!entity)return;const result=entity.state==='merged'?await command.run('/entities/'+entity.id+'/unmerge',{expected_revision:entity.revision}):
  await command.run('/entities/'+entity.id+'/merge',{target_id:mergeTarget.trim(),expected_revision:entity.revision});if(result)setRevision(value=>value+1);};
 return <><ResourceState {...detail} hasData={!!detail.data}/>{entity&&<><div className="n-actions"><Badge>{entity.kind}</Badge><Badge>{entity.state}</Badge><Badge>Revision {entity.revision}</Badge></div>
  {entity.state==='merged'?<div className="owner-form"><p>This identity is linked to <span className="owner-identifier">{entity.merged_into}</span>.</p><Button onClick={()=>void merge()} disabled={command.busy}>Undo identity link</Button></div>:
   entity.kind==='person'&&<form className="owner-form" onSubmit={event=>{event.preventDefault();void merge();}}><label>Link to confirmed person ID<input value={mergeTarget} onChange={event=>setMergeTarget(event.target.value)} pattern="[a-f0-9]{64}" required/></label><Button type="submit" disabled={command.busy||mergeTarget.length!==64}>Confirm identity link</Button></form>}
  {command.error&&<Alert>{command.error}</Alert>}<h3>Current memory</h3>{!detail.data!.claims.length&&<EmptyState title="No evidence-backed memory yet">Memory appears after permitted evidence is processed.</EmptyState>}
  <div className="owner-records">{detail.data!.claims.map(claim=><article key={claim.id}><div className="list-heading"><strong>{claim.predicate.replaceAll('_',' ')}</strong><Badge>{claim.retired?'Retired':claim.uncertainty}</Badge></div>
   <p className="memory-prose">{claim.content}</p><p className="n-muted">{claim.attribution==='direct'?'Direct statement':claim.attribution==='reported'?'Reported claim':'Model inference'}{claim.relationship_kind?' · '+claim.relationship_kind.replaceAll('_',' '):''}</p>
   <EvidenceLinks sources={claim.evidence}/><ClaimEditor claim={claim} onSaved={()=>setRevision(value=>value+1)}/><ClaimHistory id={claim.id}/><Provenance value={claim} label="Memory provenance"/></article>)}</div>
  <Provenance value={detail.data!.bindings} label="Confirmed identity bindings"/>{detail.data!.partial&&<Alert>Only the first 200 permitted memory records are shown.</Alert>}</>}</>;
}
function Suggestions(){
 const [page,setPage]=useState(['']),data=useResource<{suggestions:Suggestion[];next:string|null}>('/entities/suggestions?after='+page.at(-1));
 return <section className="n-panel"><h2>Identity suggestions</h2><p className="n-muted">Confirm names only when they refer to the same person or a real project. Group conversations cannot make this decision.</p>
  <ResourceState {...data} hasData={!!data.data}/>{data.data&&!data.data.suggestions.length&&<EmptyState title="No suggestions to review">Uncertain names and project references will appear here quietly.</EmptyState>}
  <div className="owner-records">{data.data?.suggestions.map(item=><SuggestionRow key={item.id} item={item}/>)}</div><CursorButtons pages={page} next={data.data?.next} onChange={setPage}/></section>;
}
function SuggestionRow({item}:{item:Suggestion}){
 const [target,setTarget]=useState(item.candidate_entity_id??''),command=useOwnerCommand();
 const decide=(decision:'confirm'|'reject')=>command.run('/entities/'+item.id+'/decide',{decision,expected_revision:item.revision,...(target?{entity_id:target}:{})});
 return <article><div className="list-heading"><h3>{item.name}</h3><Badge>{item.kind}</Badge></div><p>{item.reason}</p>{item.kind==='binding'&&<label>Confirmed person ID<input value={target} onChange={event=>setTarget(event.target.value)} pattern="[a-f0-9]{64}" required/></label>}
  <EvidenceLinks sources={[item.source_reference]}/>{command.error&&<Alert>{command.error}</Alert>}<div className="n-actions"><Button variant="default" disabled={command.busy||item.kind==='binding'&&!target} onClick={()=>void decide('confirm')}>Confirm</Button><Button disabled={command.busy} onClick={()=>void decide('reject')}>Reject</Button></div></article>;
}
export function EntityMemory({kind}:{kind:'person'|'project'}){
 const [query,setQuery]=useState(''),[pages,setPages]=useState(['']),[selected,setSelected]=useState<Entity|null>(null),[trigger,setTrigger]=useState<HTMLElement|null>(null);
 const params=new URLSearchParams({kind,q:query,after:pages.at(-1)!,state:'all'}),data=useResource<{entities:Entity[];next:string|null}>('/entities?'+params);
 return <><section className="n-panel"><div className="list-heading"><div><h2>{kind==='person'?'People':'Project memory'}</h2><p className="n-muted">Evidence-backed memory, relationships, uncertainty, and corrections. A relationship never grants access.</p></div><Badge>{data.data?.entities.length??0} on this page</Badge></div>
   <label>Search this memory type<input type="search" value={query} onChange={event=>{setQuery(event.target.value);setPages(['']);}} placeholder={kind==='person'?'Person name':'Project name'}/></label>
   <ResourceState {...data} hasData={!!data.data}/>{data.data&&!data.data.entities.length&&<EmptyState title={'No '+(kind==='person'?'people':'projects')+' found'}>Confirmed entities appear after permitted evidence or owner review.</EmptyState>}
   <div className="owner-records">{data.data?.entities.map(entity=><article key={entity.id}><div className="list-heading"><h3>{entity.name}</h3><Badge>{entity.state}</Badge></div><p className="n-muted">{entity.kind==='project'?'Project understanding and connected evidence':'Stable identity across permitted conversations'}</p><Button onClick={event=>{setTrigger(event.currentTarget);setSelected(entity);}}>Inspect memory</Button></article>)}</div>
   <CursorButtons pages={pages} next={data.data?.next} onChange={setPages}/></section>
  <Sheet open={!!selected} onOpenChange={open=>{if(!open)setSelected(null);}} title={selected?.name??'Entity memory'} description="Claims remain tied to their original speaker and evidence." returnFocus={trigger}>{selected&&<EntityDetail id={selected.id}/>}</Sheet></>;
}
export function Entities(){return <><EntityMemory kind="person"/><Suggestions/></>;}

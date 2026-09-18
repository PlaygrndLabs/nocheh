import {useRef,useState} from 'react';
import {call} from './page-helpers.js';
import {refreshResources} from './resource';
import {Alert,Button} from '../components/ui/primitives';

export function ownerError(error:unknown):string {
 const code=error instanceof Error?error.message:String(error);
 if(/conflict|changed/.test(code))return 'This version changed elsewhere. Your draft is retained. Refresh and review the latest version before saving.';
 if(/sharing_source_not_selected/.test(code))return 'Choose original sources from the conversations selected in this sharing rule.';
 if(/pending|busy/.test(code))return 'Preparation is still in progress. Wait a moment, then retry the same request.';
 if(/owner_required/.test(code))return 'This operation requires owner access.';
 return code.replaceAll('_',' ')||'This operation could not finish. Your draft is retained.';
}
/** Keep the same operation ID on an uncertain retry with an identical request. */
export function useOwnerCommand(){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),pending=useRef<{request:string;id:string}|null>(null),locked=useRef(false);
 const run=async(path:string,body:Record<string,unknown>,withOperation=true):Promise<any>=>{
  if(locked.current)return null;locked.current=true;setBusy(true);setError('');
  const request=JSON.stringify([path,body]);if(pending.current?.request!==request)pending.current={request,id:crypto.randomUUID()};
  try {const result=await call(path,withOperation?{...body,operation_id:pending.current.id}:body);pending.current=null;await refreshResources();return result;}
  catch(error){setError(ownerError(error));return null;}finally{locked.current=false;setBusy(false);}
 };
 return {busy,error,run,clear:()=>setError('')};
}
export function ResourceState({error,loading,hasData}:{error:string;loading:boolean;hasData:boolean}){
 return error?<Alert>{hasData?'The displayed information may be stale. ':''}{ownerError(error)}</Alert>:loading&&!hasData?<p role="status">Loading…</p>:null;
}
export function CursorButtons({pages,next,onChange}:{pages:string[];next:string|null|undefined;onChange:(pages:string[])=>void}){
 return <div className="n-actions"><Button disabled={pages.length===1} onClick={()=>onChange(pages.slice(0,-1))}>Previous page</Button><span>Page {pages.length}</span><Button disabled={!next} onClick={()=>onChange([...pages,next!])}>Next page</Button></div>;
}
export function EvidenceLinks({sources}:{sources:{id:string}[]}){
 return <ul className="evidence-links">{sources.map((source,index)=><li key={source.id}><a href={'#archive?source='+source.id}>Original evidence {index+1}</a></li>)}</ul>;
}
export function Provenance({value,label='Provenance'}:{value:unknown;label?:string}){
 return <details><summary>{label}</summary><pre className="n-data" dir="auto">{JSON.stringify(value,null,2)}</pre></details>;
}

import {useResource,refreshResources} from './lib/resource';
import {StatusBadge} from './components/status';
import * as React from 'react';
const {createElement:h,useEffect,useState}=React;

// Update repeated copies of the main text in the projection, never the original.
export function replaceRepeated(value,previous,next) {
  if(typeof value==='string')return previous!==null&&value===previous?next:value;
  if(Array.isArray(value))return value.map(v=>replaceRepeated(v,previous,next));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replaceRepeated(v,previous,next)]));
  return value;
}

function Projection({source:latest,original,eventId,call,refresh,notify}) {
  const [source]=useState(latest);
  const initial=source.content??original;
  const [text,setText]=useState(initial?.text??''),[metadata,setMetadata]=useState(JSON.stringify(Object.fromEntries(Object.entries(initial??{}).filter(([key])=>key!=='text')),null,2));
  const [busy,setBusy]=useState(false),[history,setHistory]=useState(null),[preview,setPreview]=useState(null),[problem,setProblem]=useState('');
  const hasText=initial&&'text' in initial;
  async function save(restore) {
    setBusy(true);setProblem('');
    try {
      const content=restore?undefined:replaceRepeated({...JSON.parse(metadata),...(hasText?{text}:{})},initial?.text??null,text);
      await call('/data/'+eventId+'/guarded',{source_id:source.id,expected_revision:source.active_revision,...(restore?{restore_revision:restore}:{content})});
      notify('Agent copy saved. Your original is unchanged.');await refresh();
    }catch(error){setProblem(error.message==='guard_revision_conflict'?'This copy changed elsewhere. Refresh and compare before saving again.':error instanceof SyntaxError?'Check the other fields: they must be valid JSON.':error.message);}
    finally{setBusy(false);}
  }
  async function versions(before) {
    try{const result=await call('/data/'+eventId+'/guarded/history?source_id='+encodeURIComponent(source.id)+(before?'&before='+before:''));setHistory(previous=>({revisions:[...(before?previous?.revisions??[]:[]),...result.revisions],next:result.next}));}
    catch(error){setProblem(error.message);}
  }
  async function view(revision) {
    try{setPreview(await call('/data/'+eventId+'/guarded/history?source_id='+encodeURIComponent(source.id)+'&revision='+revision));}catch(error){setProblem(error.message);}
  }
  return h('article',{className:'n-projection'},
    h('div',{className:'n-projection-heading'},h('div',null,h('p',{className:'archive-kicker'},source.kind==='events'?'Message wording':source.kind==='artifacts'?'File information':'Generated text'),h('h3',null,source.kind==='events'?'Agent copy':source.kind==='artifacts'?'Agent file copy':original?.kind?.replaceAll('_',' ')||'Generated item')),h(StatusBadge,{state:source.active_revision?'ready':source.state||'pending',label:source.active_revision?'Revision '+source.active_revision+' · '+(source.author==='owner'?'Owner edited':'Automatic'):source.state==='failed'?'Preparation failed':'Waiting for preparation'})),
    latest.active_revision!==source.active_revision&&h('p',{role:'alert'},'A newer revision is available. Your edits and original revision are retained. Review the latest copy before saving.'),
    latest.active_revision!==source.active_revision&&h('button',{type:'button',onClick:refresh,disabled:busy},'Discard edits and load latest copy'),
    source.error_code&&h('p',{role:'status'},source.error_code.replaceAll('_',' ')),
    h('section',{className:'n-guard-editable n-agent-copy-editor'},!source.content&&h('p',{className:'n-muted'},'No agent copy exists yet. Editing starts from the original.'),
        hasText&&h('label',null,'Wording for agents',h('textarea',{rows:5,dir:'auto',value:text,disabled:busy,onChange:event=>setText(event.target.value)})),
        h('details',null,h('summary',null,hasText?'Advanced agent-copy fields':'Agent-copy file information'),h('label',null,'Fields (JSON)',h('textarea',{rows:10,value:metadata,disabled:busy,onChange:event=>setMetadata(event.target.value)}))),
        h('p',{className:'n-guard-note'},'Saving changes only the agent copy. The original above remains unchanged.'),
        h('div',{className:'n-actions'},h('button',{type:'button',disabled:busy,onClick:()=>save(),className:'n-primary'},busy?'Saving…':'Save agent copy'),h('button',{type:'button',onClick:()=>versions(),disabled:busy},'Revision history'))),
    problem&&h('p',{role:'alert'},problem),
    history&&h('div',{className:'n-revision-history'},h('h4',null,'Revision history'),...history.revisions.map(revision=>h('div',{className:'n-row',key:revision.revision},h('span',null,'Revision '+revision.revision+' · '+revision.author+' · '+new Date(revision.created_at).toLocaleString()),h('button',{type:'button',onClick:()=>view(revision.revision)},'View revision'))),history.next&&h('button',{type:'button',onClick:()=>versions(history.next)},'Older revisions')),
    preview&&h('section',null,h('h4',null,'Revision '+preview.revision+' · read only'),h('pre',{className:'n-data'},JSON.stringify(preview.content,null,2)),h('button',{type:'button',disabled:busy||preview.revision===source.active_revision,onClick:()=>save(preview.revision)},'Restore as new revision')));
}

export function GuardedEditor({record,call,notify}) {
  const {data,error}=useResource('/data/'+record.id+'/guarded'),[reset,setReset]=useState(0);
  const reload=async()=>{await refreshResources();setReset(v=>v+1);};
  function original(source) {
    if(source.kind==='events')return {text:record.event.text,payload:record.event.payload};
    if(source.kind==='artifacts'){const a=record.artifacts.find(a=>a.id===source.source_id);return {kind:a?.kind,metadata:a?.metadata};}
    const d=record.derived.find(d=>d.id===source.source_id);
    return {text:d?new TextDecoder().decode(Uint8Array.from(atob(d.content_base64),c=>c.charCodeAt(0))):'',kind:d?.kind,provenance:d?.provenance};
  }
  return h('section',{className:'n-panel n-agent-copy'},h('p',{className:'archive-kicker'},'Agent copy'),h('h2',null,'What agents can use'),
    h('p',{className:'n-muted'},'Edit this only when agents should use different wording. Saving never changes the original message above.'),
    error&&h('p',{role:'alert'},error),!data&&!error&&h('p',{role:'status'},'Loading guarded versions…'),
    ...(data?.projections??[]).map(source=>h(Projection,{key:source.id+':'+reset,source,original:original(source),eventId:record.id,call,notify,refresh:reload})));
}

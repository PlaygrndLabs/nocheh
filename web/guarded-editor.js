import * as React from 'react';
const {createElement:h,useEffect,useState}=React;

// Update repeated copies of the main text in the projection, never the original.
export function replaceRepeated(value,previous,next) {
  if(typeof value==='string')return previous!==null&&value===previous?next:value;
  if(Array.isArray(value))return value.map(v=>replaceRepeated(v,previous,next));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replaceRepeated(v,previous,next)]));
  return value;
}

function Projection({source,original,eventId,call,refresh,notify}) {
  const initial=source.content??original;
  const [text,setText]=useState(initial?.text??''),[metadata,setMetadata]=useState(JSON.stringify(Object.fromEntries(Object.entries(initial??{}).filter(([key])=>key!=='text')),null,2));
  const [busy,setBusy]=useState(false),[history,setHistory]=useState(null),[preview,setPreview]=useState(null),[problem,setProblem]=useState('');
  const hasText=initial&&'text' in initial;
  async function save(restore) {
    setBusy(true);setProblem('');
    try {
      const content=restore?undefined:replaceRepeated({...JSON.parse(metadata),...(hasText?{text}:{})},initial?.text??null,text);
      await call('/data/'+eventId+'/guarded',{source_id:source.id,expected_revision:source.active_revision,...(restore?{restore_revision:restore}:{content})});
      notify('Guarded version saved. Your original is unchanged.');refresh();
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
    h('div',{className:'n-row'},h('h3',null,source.kind==='events'?'Message':source.kind==='artifacts'?'File information':original?.kind?.replaceAll('_',' ')||'Generated text'),h('span',{className:'n-badge'},source.active_revision?'Revision '+source.active_revision+' · '+(source.author==='owner'?'Owner edited':'Automatic'):source.state==='failed'?'Preparation failed':'Waiting for preparation')),
    source.error_code&&h('p',{role:'status'},source.error_code.replaceAll('_',' ')),
    h('div',{className:'n-guard-comparison'},
      h('section',null,h('h4',null,'Original · read only'),h('pre',{className:'n-data',dir:'auto'},hasText?original?.text:JSON.stringify(original,null,2)),hasText&&h('details',null,h('summary',null,'Original fields'),h('pre',{className:'n-data'},JSON.stringify(original,null,2)))),
      h('section',null,h('h4',null,'Guarded · editable'),!source.content&&h('p',{className:'n-muted'},'No guarded copy yet. You can prepare an owner-edited copy below; it starts with the original text.'),
        hasText&&h('label',null,'Guarded text',h('textarea',{rows:8,dir:'auto',value:text,disabled:busy,onChange:event=>setText(event.target.value)})),
        h('details',null,h('summary',null,hasText?'Other guarded fields':'Guarded file information'),h('label',null,'Fields (JSON)',h('textarea',{rows:12,value:metadata,disabled:busy,onChange:event=>setMetadata(event.target.value)}))),
        h('p',{className:'n-muted'},'Your saved wording is final. It will not be masked again. Matching copies of the message text are updated together.'),
        h('button',{type:'button',disabled:busy,onClick:()=>save(),className:'n-primary'},busy?'Saving…':'Save guarded version'))),
    problem&&h('p',{role:'alert'},problem),
    h('button',{type:'button',onClick:()=>versions(),disabled:busy},'Revision history'),
    history&&h('div',null,...history.revisions.map(revision=>h('div',{className:'n-row',key:revision.revision},h('span',null,'Revision '+revision.revision+' · '+revision.author+' · '+new Date(revision.created_at).toLocaleString()),h('button',{type:'button',onClick:()=>view(revision.revision)},'View revision'))),history.next&&h('button',{type:'button',onClick:()=>versions(history.next)},'Older revisions')),
    preview&&h('section',null,h('h4',null,'Revision '+preview.revision+' · read only'),h('pre',{className:'n-data'},JSON.stringify(preview.content,null,2)),h('button',{type:'button',disabled:busy||preview.revision===source.active_revision,onClick:()=>save(preview.revision)},'Restore as new revision')));
}

export function GuardedEditor({record,call,notify}) {
  const [data,setData]=useState(null),[error,setError]=useState(''),[tick,setTick]=useState(0);
  useEffect(()=>{let alive=true;setData(null);setError('');call('/data/'+record.id+'/guarded').then(value=>{if(alive)setData(value);}).catch(error=>{if(alive)setError(error.message);});return()=>{alive=false;};},[record.id,tick]);
  function original(source) {
    if(source.kind==='events')return {text:record.event.text,payload:record.event.payload};
    if(source.kind==='artifacts'){const a=record.artifacts.find(a=>a.id===source.source_id);return {kind:a?.kind,metadata:a?.metadata};}
    const d=record.derived.find(d=>d.id===source.source_id);
    return {text:d?new TextDecoder().decode(Uint8Array.from(atob(d.content_base64),c=>c.charCodeAt(0))):'',kind:d?.kind,provenance:d?.provenance};
  }
  return h('section',{className:'n-panel'},h('h2',null,'Original and guarded versions'),
    h('p',{className:'n-muted'},'The original archive is read only. Guarded copies are separate, editable versions for your agents when guarding is on.'),
    error&&h('p',{role:'alert'},error),!data&&!error&&h('p',{role:'status'},'Loading guarded versions…'),
    ...(data?.projections??[]).map(source=>h(Projection,{key:source.id+':'+source.active_revision,source,original:original(source),eventId:record.id,call,notify,refresh:()=>setTick(v=>v+1)})));
}

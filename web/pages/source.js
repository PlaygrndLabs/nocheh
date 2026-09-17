import {React,sdk,h,useState,useEffect,useRef,useMemo,base,call,button,errorText,labels,Panel,Data,friendlyState,jobName,profileName,Details,RouteLink,Steps,download,exportJSON,useLoad,useResource,refreshResources,StatusBadge,Button,Badge,Alert,Progress,Table,Tabs,TabsList,TabsTrigger,TabsContent,Modal,Sheet,EmptyState} from '../lib/page-helpers.js';
import {GuardedEditor} from '../guarded-editor.js';
export function Source({record,notify}){
    return h('div',null,h(GuardedEditor,{key:record.id,record,call,notify}),h(Panel,{title:'Original source and files'},h(Badge,null,'Original · read only'),h('p',{dir:'auto',className:'n-source'},record.event?.text),
      button('Download source JSON',()=>exportJSON(record,'nocheh-source-'+record.id+'.json')),
      ...record.artifacts.map(a=>h('div',{className:'n-row',key:a.id},h('span',null,a.metadata?.relative_path||a.metadata?.file_name||a.kind),h(StatusBadge,{state:a.state}),button('Download original file',()=>download('/artifacts/'+a.id+'/download',a.metadata?.relative_path?.split('/').pop()||a.metadata?.file_name||a.id,notify),a.state!=='ready'))),
      ...record.derived.map(d=>h('article',{key:d.id},h(Badge,null,'Generated · inspect provenance'),h('h3',null,d.kind==='browser_result'?'Assistant result':d.kind==='transcript'?'Voice transcript':'Generated '+d.kind.replaceAll('_',' ')),h(Data,{value:new TextDecoder().decode(Uint8Array.from(atob(d.content_base64),c=>c.charCodeAt(0)))}),h('details',null,h('summary',null,'Generation provenance'),h(Data,{value:d.provenance})))),
      h('details',null,h('summary',null,'Source identity and complete metadata'),h(Data,{value:record}))));
  }

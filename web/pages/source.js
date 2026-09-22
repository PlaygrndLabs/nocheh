import {React,sdk,h,useState,useEffect,useRef,useMemo,base,call,button,errorText,labels,Panel,Data,friendlyState,jobName,profileName,Details,RouteLink,Steps,download,exportJSON,useLoad,useResource,refreshResources,StatusBadge,Button,Badge,Alert,Progress,Table,Tabs,TabsList,TabsTrigger,TabsContent,Modal,Sheet,EmptyState} from '../lib/page-helpers.js';
import {GuardedEditor} from '../guarded-editor.js';
import {SourceVersions} from './source-versions';

export function Source({record,notify}){
 const files=record.artifacts||[],generated=record.derived||[];
 const original=h('section',{className:'n-panel n-original-evidence'},
  h('div',{className:'source-section-heading'},h('div',null,h('p',{className:'archive-kicker'},'Original message'),h('h2',null,'What was received')),h(Badge,null,'Permanent · read only')),
  h('p',{className:'n-muted'},'This is the source of truth and cannot be edited.'),
  h('div',{className:'n-original-message',dir:'auto'},record.event?.text||'(No message text)'),
  files.length>0&&h('section',{className:'source-files'},h('h3',null,files.length===1?'Original file':'Original files'),...files.map(file=>h('div',{className:'n-row',key:file.id},h('span',null,file.metadata?.relative_path||file.metadata?.file_name||file.kind),h(StatusBadge,{state:file.state}),button('Download file',()=>download('/artifacts/'+file.id+'/download',file.metadata?.relative_path?.split('/').pop()||file.metadata?.file_name||file.id,notify),file.state!=='ready')))),
  h('details',{className:'source-technical'},h('summary',null,'Advanced details and export'),
    h('p',{className:'n-muted'},'Generated items, provenance, source identity, and the complete source export.'),
    generated.length>0&&h('section',{className:'source-generated'},h('h3',null,generated.length+' generated '+(generated.length===1?'item':'items')),...generated.map(item=>h('article',{key:item.id},h(Badge,null,'Generated'),h('h3',null,item.kind==='browser_result'?'Assistant result':item.kind==='transcript'?'Voice transcript':'Generated '+item.kind.replaceAll('_',' ')),h(Data,{value:new TextDecoder().decode(Uint8Array.from(atob(item.content_base64),character=>character.charCodeAt(0)))}),h('details',null,h('summary',null,'Generation provenance'),h(Data,{value:item.provenance}))))),
    h('details',null,h('summary',null,'Source identity and technical metadata'),h(Data,{value:record})),
    h('div',{className:'source-utility-actions'},button('Download source JSON',()=>exportJSON({id:record.id,reference:record.reference,event:record.event,artifacts:files},'nocheh-source-'+record.id+'.json')))));
 return h('div',{className:'source-stack'},
  original,
  !record.derivative_versions&&h(GuardedEditor,{key:record.id,record,call,notify}),
  record.derivative_versions&&h(SourceVersions,{key:record.id,record}));
}

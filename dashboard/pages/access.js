import {React,sdk,h,useState,useEffect,useRef,useMemo,base,call,button,errorText,labels,Panel,Data,friendlyState,jobName,profileName,Details,RouteLink,Steps,download,exportJSON,useLoad,useResource,refreshResources,StatusBadge,Button,Badge,Alert,Progress,Table,Tabs,TabsList,TabsTrigger,TabsContent,Modal,Sheet,EmptyState} from '../lib/page-helpers.js';
import {Sharing} from './sharing';
export function SpaceControls() {
    const [status,statusError]=useLoad('/status'),original=status?.storage_layout==='original-only-v1';
    const [Component,setComponent]=useState(null),[error,setError]=useState('');
    useEffect(()=>{if(!status||original)return;let alive=true;import('./access-controls.js').then(m=>{if(alive)setComponent(()=>m.createSpaceControls(sdk.React,call));}).catch(e=>{if(alive)setError(errorText(e));});return()=>{alive=false;};},[!!status,original]);
    if(statusError)return h(Alert,null,statusError);
    if(!status)return h('p',{role:'status'},'Loading memory controls…');
    if(original)return h('div',null,
      h(Panel,{title:'Conversation access'},h('p',null,'Each conversation keeps its own context. Sharing rules select the permitted sources and destination. Project membership does not grant access to another conversation.'),
        h('div',{className:'n-actions'},h('a',{href:'#projects'},'Manage projects'),h('a',{href:'#learned'},'Inspect learned memory'),h('a',{href:'#honcho'},'Inspect memory processing'))),
      h(Sharing));
    return error?h('p',{role:'alert'},error):Component?h(Component):h('p',{role:'status'},'Loading memory controls…');
  }

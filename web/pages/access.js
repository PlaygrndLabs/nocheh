import {React,sdk,h,useState,useEffect,useRef,useMemo,base,call,button,errorText,labels,Panel,Data,friendlyState,jobName,profileName,Details,RouteLink,Steps,download,exportJSON,useLoad,useResource,refreshResources,StatusBadge,Button,Badge,Alert,Progress,Table,Tabs,TabsList,TabsTrigger,TabsContent,Modal,Sheet,EmptyState} from '../lib/page-helpers.js';
export function SpaceControls() {
    const [Component,setComponent]=useState(null),[error,setError]=useState('');
    useEffect(()=>{let alive=true;import('./access-controls.js').then(m=>{if(alive)setComponent(()=>m.createSpaceControls(sdk.React,call));}).catch(e=>{if(alive)setError(errorText(e));});return()=>{alive=false;};},[]);
    return error?h('p',{role:'alert'},error):Component?h(Component):h('p',{role:'status'},'Loading memory controls…');
  }

import {React,sdk,h,useState,useEffect,useRef,useMemo,base,call,button,errorText,labels,Panel,Data,friendlyState,jobName,profileName,Details,RouteLink,Steps,download,exportJSON,useLoad,useResource,refreshResources,StatusBadge,Button,Badge,Alert,Progress,Table,Tabs,TabsList,TabsTrigger,TabsContent,Modal,Sheet,EmptyState} from '../lib/page-helpers.js';
export function Integrations() {
    const {data,error}=useResource('/runtime',10000);
    return h('div',null,h(Panel,{title:'Hermes',note:'Your agent runtime: chat, native tools, profiles, sessions and built-in memory.'},
      error&&h('p',{role:'alert'},error),!data&&!error&&h('p',{role:'status'},'Checking runtime…'),
      data&&h('div',null,h(StatusBadge,{state:data.status?.ok?'connected':'unknown',label:data.status?.ok?'Runtime connected':'Runtime unobserved'}),
        h('p',{className:'n-muted'},data.status?.model||'Check runtime health or restart services in Maintenance.'),
        h('a',{className:'n-text-link',href:'/hermes/nocheh'},'Open native Hermes dashboard →'),
        h('div',{className:'capability-list'},...Object.entries(data.capabilities||{}).filter(([,v])=>typeof v==='boolean').map(([name,value])=>h('div',{className:'n-row',key:name},h('b',null,name.replaceAll('_',' ')),h(StatusBadge,{state:value?'ready':'disabled',label:value?'Available':'Disabled'})))),h(Details,{value:data,label:'Runtime status and capabilities'}))),
      h(Panel,{title:'Honcho',note:'Primary long-term memory with scoped recall, guarded sources and durable ingestion receipts.'},h(RouteLink,{page:'honcho'},'Open Honcho memory →')),
      h(Panel,{title:'Provider monitoring',note:'Request history, usage, latency, failures and subscription account observations from CPA Manager Plus.'},
        h('a',{className:'n-text-link',href:'/providers/management.html'},'Open provider monitoring →')));
  }

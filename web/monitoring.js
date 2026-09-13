import * as React from 'react';
import {Workflows} from './workflows.js';
const {createElement:h,useState,useEffect}=React;
const time=value=>value?new Date(value).toLocaleString():'Not observed';
const names={pending:'Queued',running:'Running',failed:'Failed · will retry',done:'Completed',ambiguous:'Delivery uncertain',suppressed:'Skipped',ready:'Ready',connected:'Receiving',recovering:'Recovering',disabled:'Disabled',starting:'Starting',credentials_missing:'Login missing',connection_failed:'Connection failed',runtime_failed:'Runtime failed'};
const reason=value=>({telegram_network_error:'Telegram polling stopped after network recovery failed.',telegram_polling_conflict:'Another process may be using this bot token.',telegram_adapter_failed:'The Telegram adapter stopped.',telegram_poll_or_capture_failed:'The last Telegram poll or durable capture failed.',telegram_unauthorized:'Telegram rejected the bot token.',telegram_rate_limited:'Telegram requested a pause.',conversation_not_selected:'This chat is outside the selected Telegram conversations.',unsupported_message:'This update did not contain a supported message.',waiting_for_attachments:'Waiting for original files to download.',waiting_for_transcription:'Waiting for voice transcription.',guard_preparation_pending:'Waiting for a guarded copy before calling the model.',awaiting_dispatch_receipt:'Checking the existing run receipt before retrying.',model_unavailable:'The model did not return a successful result.',quota_paused:'Subscription quota is paused.',subscription_unavailable:'The subscription is unavailable. Check its login and quota.',runtime_restart_during_dispatch:'The runtime restarted before the outcome was confirmed. Review before sending again.',delivery_unconfirmed:'Telegram delivery was not confirmed. It will not be resent automatically.'})[value]||String(value||'').replaceAll('_',' ');
function useMonitor(call){
  const [data,setData]=useState(null),[error,setError]=useState('');
  useEffect(()=>{let alive=true,timer;
    const update=async()=>{try{const value=await call('/monitoring');if(alive){setData(value);setError('');}}catch{if(alive)setError('Monitoring is unavailable. The last snapshot may be out of date.');}finally{if(alive)timer=setTimeout(update,10000);}};
    update();return()=>{alive=false;clearTimeout(timer);};
  },[call]);
  return [data,error];
}
export function Monitoring({call,compact=false,renderSource}){
  const [data,error]=useMonitor(call),[filter,setFilter]=useState('all'),[record,setRecord]=useState(null),[sourceError,setSourceError]=useState('');
  const status=data?.runtime?.status||{},archive=data?.archive?.archive||{},provider=data?.provider||{};
  const telegram=status.telegram||'unavailable';
  const needsAttention=!!data&&data.telegram_enabled&&telegram!=='connected';
  const rows=archive.workflows||[];
  const open=async id=>{setRecord(null);setSourceError('');try{setRecord(await call('/events/'+id));}catch{setSourceError('The original source could not be loaded.');}};
  if(!data)return h('section',{className:'n-panel'},h('h2',null,'System monitoring'),h('p',{role:error?'alert':'status'},error||'Checking Telegram, the runtime and queued work…'));
  const banner=h('section',{className:'n-panel n-monitor-banner'+(needsAttention||error?' n-monitor-warning':''),role:needsAttention||error?'alert':undefined},
    h('div',null,h('h2',null,needsAttention?'Telegram needs attention':data.telegram_enabled?'Telegram · '+(names[telegram]||telegram):'Telegram is disabled'),
      h('p',null,reason(status.telegram_details?.error_code)||(needsAttention?'The receive path is not confirmed. Check the incident and services below.':'Last successful poll: '+time(status.telegram_details?.last_poll_at))),
      h('small',null,'Checked '+time(data.checked_at)+' · refreshes every 10 seconds')),
    compact?h('a',{href:'#monitoring',className:'n-text-link'},'Open system monitoring →'):h('a',{href:'#operations',className:'n-text-link'},'Open Maintenance →'));
  if(compact)return h('div',null,banner,error&&h('p',{role:'alert'},error));
  const workflowAvailable=Array.isArray(archive.telegram)&&Array.isArray(archive.workflows);
  const counts=(archive.telegram||[]).reduce((all,row)=>({...all,[row.state]:row.count}),{});
  const visible=rows.filter(row=>filter==='all'||filter==='attention'&&['pending','running','failed','ambiguous'].includes(row.state)||row.state===filter);
  return h('div',{className:'n-monitor'},banner,error&&h('p',{role:'alert'},error),
    h(Workflows,{call,health:data.workflows,onSource:open}),
    h('div',{className:'n-metrics'},...[
      ['Completed',counts.done||0,'Completed Telegram turns; some may intentionally be silent.'],
      ['Waiting or running',(counts.pending||0)+(counts.running||0),'Captured work waiting for its next stage.'],
      ['Failed or uncertain',(counts.failed||0)+(counts.ambiguous||0),'Failures retry; uncertain delivery requires review.']
    ].map(([title,count,note])=>h('section',{className:'n-panel',key:title},h('h2',null,title),h('strong',null,workflowAvailable?count:'—'),h('p',null,note)))),
    !workflowAvailable&&h('p',{role:'alert'},'Archive status is unavailable. Queue counts and workflow history cannot be checked.'),
    data.telegram_incident&&h('section',{className:'n-panel'},h('h2',null,'Last Telegram incident'),h('p',null,reason(data.telegram_incident.error_code)),h('small',null,time(data.telegram_incident.at)),telegram==='connected'&&h('p',{className:'n-afterword'},'Polling is active again. This incident is retained for inspection.')),
    h('section',{className:'n-panel'},h('h2',null,'Telegram workflows'),h('p',{className:'n-muted'},'The latest 50 captured updates, including successes, failures and intentional skips. Original message text stays in Archive.'),
      h('label',null,'Show',h('select',{value:filter,onChange:e=>setFilter(e.target.value)},...Object.entries({all:'All updates',attention:'Needs attention',done:'Completed',suppressed:'Skipped'}).map(([value,label])=>h('option',{key:value,value},label)))),
      !visible.length&&h('p',{className:'n-empty'},!workflowAvailable?'Workflow history is unavailable.':rows.length?'No updates match this filter.':'No Telegram updates have been captured yet.'),
      ...visible.map(row=>h('article',{className:'n-workflow',key:row.event_id},
        h('div',{className:'n-result-heading'},h('h3',null,time(row.received_at)),h('span',{className:'n-badge '+(['failed','ambiguous'].includes(row.state)?'n-monitor-bad':'')},names[row.state]||row.state)),
        h('p',null,reason(row.error_code)||({done:'Processing completed.',suppressed:'No assistant turn was needed.',pending:'Waiting to start.',running:'A turn is in progress.'})[row.state]),
        h('ol',{className:'n-workflow-stages','aria-label':'Workflow stages'},h('li',null,'Captured'),h('li',null,row.files?`${row.files-row.files_waiting}/${row.files} files ready`:'No files'),h('li',null,data.archive?.guard_mode==='off'?'Guard off':row.guard_waiting?row.guard_waiting+' guarded copies waiting':'Guarded copies ready'),h('li',null,names[row.state]||row.state)),
        (row.guard_error||row.transcription_error)&&h('p',{role:'status'},reason(row.guard_error||row.transcription_error)),
        h('small',null,row.attempts+' attempt'+(row.attempts===1?'':'s')+' · Updated '+time(row.updated_at)),
        ['pending','running','failed'].includes(row.state)&&h('small',null,'Next check: '+time(row.next_attempt)),
        h('button',{type:'button',onClick:()=>open(row.event_id)},'Inspect original')))),
    sourceError&&h('p',{role:'alert'},sourceError),record&&h('section',null,h('button',{type:'button',onClick:()=>setRecord(null)},'Close original'),renderSource?.(record)),
    h('section',{className:'n-panel'},h('h2',null,'Provider connection'),
      h('p',null,'Active reasoning route: '+(status.reasoning_route==='shared'?'Shared subscription proxy':status.reasoning_route==='native'?'Native Hermes subscription':'Unavailable')),
      h('p',null,provider.unavailable?'Shared provider status unavailable.':provider.login_present?'Shared subscription login is present.':'Shared subscription login is missing. Complete OAuth before switching the active route.'),
      h('a',{href:'/providers/management.html#/oauth',className:'n-text-link'},'Open subscription OAuth →'),
      status.reasoning_route==='native'&&h('p',{className:'n-muted'},'Provider monitoring records shared-proxy traffic. Your current native Hermes requests do not pass through that proxy.'),
      h('h3',{className:'n-afterword'},'Where the three API keys come from'),
      h('p',null,'Nocheh generates three local access credentials: Hermes for chat, Honcho for memory reasoning, and Preparation for guarded text. They authenticate these services to your local proxy. They are not OpenAI billing keys and do not sign you into ChatGPT.'),
      h('p',{className:'n-muted'},'The management key protects the local proxy’s administration API. Nocheh manages these credentials automatically.'),
      h('a',{href:'/providers/management.html',className:'n-text-link'},'Open provider requests and usage →')),
    h('section',{className:'n-panel'},h('h2',null,'Background work'),...['preparation','artifacts','transcriptions','actions'].map(kind=>h('div',{className:'n-row',key:kind},h('b',null,({preparation:'Guarded copies',artifacts:'Files',transcriptions:'Transcriptions',actions:'Approved actions'})[kind]),h('span',null,archive[kind]?.map(row=>row.count+' '+(names[row.state]||row.state)).join(' · ')||'None recorded'))),
      archive.spool_failures?.length>0&&h('p',{role:'alert'},archive.spool_failures.length+' archive spool failures require attention.'),
      h('a',{href:'#activity'},'Open browser runs and approvals →')),
    h('section',{className:'n-panel'},h('h2',null,'Services'),h('p',{className:'n-muted'},'Container health reports availability. Telegram polling and workflow outcomes above show whether useful work is progressing.'),
      Array.isArray(data.containers)?data.containers.map(row=>h('div',{className:'n-row',key:row.service},h('b',null,row.service),h('span',null,row.state+' · '+(row.health||'No health check')))):h('p',{role:'alert'},'Container status is unavailable.')));
}

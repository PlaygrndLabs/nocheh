import * as React from 'react';
const {createElement:h,useEffect,useState,useRef}=React;
const time=value=>value?new Date(value).toLocaleString():'—';
const families={preparation:'Source preparation',telegram:'Telegram',imports:'Imports',memory_review:'Memory review',honcho:'Honcho',browser:'Browser turns',schedules:'Schedules',actions:'Approved messages',tools:'Controlled tools'};
const states={queued:'Queued',waiting:'Waiting',running:'Running',retryable_failed:'Failed · retry scheduled',completed:'Completed',failed:'Terminal failure',skipped:'Intentionally skipped',cancelled:'Cancelled',ambiguous:'Effect uncertain',denied:'Denied'};
const reasons={approval_required:'Waiting for owner approval',owner_paused:'Paused by owner',prerequisite:'Waiting for a prerequisite',guard_pending:'Waiting for guarded preparation',receipt_pending:'Reconciling the existing execution receipt',provider_unavailable:'Provider unavailable',runtime_unavailable:'Runtime unavailable',workflow_execution_failed:'Execution unavailable',legacy_owner:'Managed by the existing runner',closed:'This outcome is closed',native_schedule_control:'Pause or edit this schedule in Schedules',source_policy_control:'Manage this work through its source or memory policy',execution_in_progress:'Execution is in progress; reconcile its receipt before another effect'};
const readable=value=>reasons[value]||String(value||'').replaceAll('_',' ');
const bad=state=>['retryable_failed','failed','ambiguous','denied'].includes(state);

export function WorkflowSummary({health,stale=false}){
  const available=!!health&&!health.unavailable&&Array.isArray(health.counts);
  const counts={};
  for(const row of available?health.counts:[])counts[row.state]=(counts[row.state]||0)+row.count;
  const failed=(counts.failed||0)+(counts.retryable_failed||0);
  const uncertain=counts.ambiguous||0,denied=counts.denied||0;
  const workers=health?.workers||[],disconnected=workers.filter(worker=>!worker.connected).length;
  const staleServices=(health?.services||[]).filter(service=>!service.fresh).length;
  const metrics=[
    ['Running',counts.running||0,'Executing now'],
    ['Waiting',(counts.queued||0)+(counts.waiting||0),'Queued or awaiting a prerequisite'],
    ['Failed',failed,`${counts.retryable_failed||0} retry scheduled · ${counts.failed||0} terminal`],
    ['Last success',health?.last_success_at?time(health.last_success_at):'None recorded','Last confirmed workflow completion'],
    ['Backlog',health?.outbox?.pending??'—','Requests awaiting publication']
  ];
  return h('section',{className:'n-panel n-workflow-summary','aria-label':'Workflow summary'},
    h('div',{className:'n-summary-line'},h('div',null,h('h2',null,'Workflows'),h('p',{className:'n-muted'},'All workflow families · refreshes every 10 seconds')),
      h('a',{href:'/inngest/runs',className:'n-primary n-inngest-link'},'Open Inngest ↗')),
    !available&&h('p',{role:'alert'},'Workflow status is unavailable. Counts and the last success cannot be checked.'),
    stale&&h('p',{role:'alert'},'These are the last known workflow observations and may be out of date.'),
    h('dl',{className:'n-workflow-metrics'},...metrics.map(([label,value,note])=>h('div',{key:label},
      h('dt',null,label),h('dd',{className:label==='Last success'?'n-workflow-time':undefined},available?value:'—'),h('small',null,available?note:'Unavailable')))),
    available&&(failed>0||uncertain>0||denied>0)&&h('p',{className:'n-monitor-attention',role:'status'},
      [failed>0?`${failed} failed (${counts.retryable_failed||0} retry scheduled)`:null,uncertain>0?`${uncertain} uncertain — review before another effect`:null,denied>0?`${denied} denied`:null].filter(Boolean).join(' · ')),
    available&&h('p',{className:disconnected||staleServices?'n-monitor-attention':'n-muted',role:disconnected||staleServices?'status':undefined},
      `${workers.length-disconnected}/${workers.length} workflow workers observed`,disconnected?` · ${disconnected} stale or disconnected`:null,staleServices?` · ${staleServices} stale service heartbeat${staleServices===1?'':'s'}`:null),
    h('small',null,'Observed '+time(health?.observed_at)+' · Inngest history is read-only. Retry and cancel are in Workflow details.'));
}

export function Workflows({call,health,onSource}){
  const [family,setFamily]=useState(''),[state,setState]=useState(''),[pages,setPages]=useState([null]),[page,setPage]=useState(null);
  const [selected,setSelected]=useState(null),[detail,setDetail]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
  const [controlError,setControlError]=useState(''),inspector=useRef(null);
  useEffect(()=>{if(selected){inspector.current?.scrollIntoView({block:'start'});inspector.current?.focus();}},[selected]);
  const after=pages.at(-1);
  useEffect(()=>{
    let alive=true,timer;
    const update=async()=>{
      try {
        const query=new URLSearchParams({family,state,limit:'25',...(after?{after}:{})});
        const [list,item]=await Promise.all([call('/workflows?'+query),selected?call('/workflows/'+selected):null]);
        if(alive){setPage(list);setDetail(item);setError('');}
      }catch{if(alive)setError('Workflow observations are unavailable. The last snapshot may be out of date.');}
      finally{if(alive)timer=setTimeout(update,10000);}
    };
    update();return()=>{alive=false;clearTimeout(timer);};
  },[call,family,state,after,selected,refresh]);
  const filter=(setter,value)=>{setter(value);setPages([null]);setPage(null);};
  const control=async action=>{
    setBusy(true);setControlError('');
    try{setDetail(await call('/workflows/'+detail.id+'/'+action,{revision:detail.revision}));setRefresh(n=>n+1);}
    catch{setControlError('The workflow changed or cannot accept this action. Check its current receipt before trying again.');setRefresh(n=>n+1);}
    finally{setBusy(false);}
  };
  const row=item=>h('article',{className:'n-workflow',key:item.id},
    h('div',{className:'n-result-heading'},h('h3',null,families[item.family]),h('span',{className:'n-badge '+(bad(item.state)?'n-monitor-bad':'')},states[item.state]||item.state)),
    h('p',null,'Stage: '+readable(item.stage)),item.waiting_reason&&h('p',null,readable(item.waiting_reason)),
    h('small',null,`${item.attempts} attempt${item.attempts===1?'':'s'} · Created ${time(item.created_at)} · Updated ${time(item.updated_at)}`),
    !['completed','failed','skipped','cancelled','ambiguous','denied'].includes(item.state)&&item.next_attempt&&h('small',null,'Next check: '+time(item.next_attempt)),
    item.total!=null&&h('small',null,`${item.completed}/${item.total} records · ${item.duplicates} duplicates · ${item.learning_after} reviewed`),
    h('div',{className:'n-actions'},h('button',{type:'button',onClick:()=>{setSelected(item.id);setDetail(null);}},'Execution details'),item.source_event_id&&h('button',{type:'button',onClick:()=>onSource(item.source_event_id)},'Inspect original')));
  return h(React.Fragment,null,
    h('section',{className:'n-panel'},h('h2',null,'Workflow history'),
      h('p',{className:'n-muted'},'Source data and receipts stay in Nocheh. Detailed Inngest history is available for inspection; execution controls stay here.'),
      h('div',{className:'n-form'},h('label',null,'Workflow family',h('select',{value:family,onChange:e=>filter(setFamily,e.target.value)},h('option',{value:''},'All families'),...Object.entries(families).map(([value,label])=>h('option',{key:value,value},label)))),
        h('label',null,'Status',h('select',{value:state,onChange:e=>filter(setState,e.target.value)},h('option',{value:''},'All statuses'),...Object.entries(states).map(([value,label])=>h('option',{key:value,value},label))))),
      error&&h('p',{role:'alert'},error),!page&&h('p',{role:'status'},error?'No current observation.':'Loading workflows…'),
      page&&!page.workflows.length&&h('p',{className:'n-empty'},'No workflows match these filters.'),...((page?.workflows||[]).map(row)),
      h('div',{className:'n-actions'},h('button',{type:'button',disabled:pages.length===1,onClick:()=>{setPages(p=>p.slice(0,-1));setPage(null);}},'Previous'),h('button',{type:'button',disabled:!page?.next,onClick:()=>{setPages(p=>[...p,page.next]);setPage(null);}},'Next'),h('small',null,'Observed '+time(page?.observed_at)+' · refreshes every 10 seconds'))),
    selected&&h('section',{className:'n-panel','aria-label':'Workflow execution details',tabIndex:-1,ref:inspector},h('div',{className:'n-result-heading'},h('h2',null,'Execution details'),h('button',{type:'button',onClick:()=>{setSelected(null);setDetail(null);setControlError('');}},'Close details')),
      controlError&&h('p',{role:'alert'},controlError),
      !detail?h('p',{role:'status'},'Loading execution receipt…'):h(React.Fragment,null,
        h('p',null,(families[detail.family]||detail.family)+' · '+states[detail.state]),h('small',{className:'n-workflow-id'},'Workflow '+detail.id),h('small',{className:'n-workflow-id'},'Job '+detail.job_id),
        h('p',null,`Version ${detail.version} · generation ${detail.generation} · revision ${detail.revision}`),
        detail.control_reason&&h('p',{className:'n-muted'},readable(detail.control_reason)),
        h('div',{className:'n-actions'},h('button',{type:'button',disabled:busy||!detail.can_retry,onClick:()=>control('retry')},'Retry now'),h('button',{type:'button',disabled:busy||!detail.can_cancel,onClick:()=>control('cancel')},'Cancel workflow')),
        h('h3',{className:'n-afterword'},'Execution receipts'),!detail.receipts.length&&h('p',{className:'n-muted'},'No external effect receipt has been recorded.'),
        ...detail.receipts.map(r=>h('div',{className:'n-row',key:r.step+':'+r.attempt},h('b',null,readable(r.step)+' · attempt '+r.attempt),h('span',null,readable(r.state)+' · '+time(r.updated_at)))),
        h('h3',{className:'n-afterword'},'Inngest runs'),!detail.runs.length&&h('p',{className:'n-muted'},'No Inngest run has been observed.'),
        ...detail.runs.map(r=>h('div',{className:'n-row',key:r.run_id},h('a',{href:'/inngest/run?runID='+encodeURIComponent(r.run_id)},'Inspect run '+r.run_id),h('span',null,'Dispatch '+r.dispatch+' · '+time(r.seen_at)))),
        h('h3',{className:'n-afterword'},'Publication and controls'),...detail.outbox.map(r=>h('div',{className:'n-row',key:r.dispatch},h('b',null,'Dispatch '+r.dispatch),h('span',null,r.published_at?'Published '+time(r.published_at):r.dispatch!==detail.dispatch?'Superseded':['completed','failed','skipped','cancelled','ambiguous','denied'].includes(detail.state)?'Closed without publication':'Awaiting publication · next '+time(r.next_attempt)))),
        ...detail.controls.map(r=>h('div',{className:'n-row',key:r.revision+':'+r.action},h('b',null,readable(r.action)+' · revision '+r.revision),h('span',null,time(r.created_at)))))),
    h('section',{className:'n-panel'},h('h2',null,'Workflow delivery and workers'),
      !health||health.unavailable?h('p',{role:'alert'},'Workflow health is unavailable. Worker observations may be stale.'):h(React.Fragment,null,
        h('p',null,`${health.outbox.pending} unpublished requests · ${health.outbox.admitted} eligible for delivery`),h('small',null,'Oldest unpublished: '+time(health.outbox.oldest)),h('small',null,'Oldest waiting work: '+time(health.oldest_waiting)),
        ...health.workers.map(worker=>h('div',{className:'n-row',key:worker.family},h('b',null,families[worker.family]),h('span',null,worker.owner==='legacy'?'Existing runner':worker.connected?'Inngest worker connected':'Inngest worker not observed · stale or disconnected'),h('small',null,(worker.admission?'Admission open':'Admission paused')+' · last seen '+time(worker.seen_at)))),
        ...health.services.map(service=>h('div',{className:'n-row',key:service.service},h('b',null,service.service),h('span',null,service.fresh?'Heartbeat current':'Heartbeat stale'),h('small',null,time(service.seen_at)))),
        h('small',null,'Observed '+time(health.observed_at)))),
    h('p',{className:'n-muted'},'Backup, restore and shutdown progress remain in ',h('a',{href:'#operations'},'Maintenance'),'.'));
}

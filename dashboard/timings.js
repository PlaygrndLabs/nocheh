import * as React from 'react';
import {useResource} from './lib/resource';
const {createElement:h,useState}=React;
const seconds=value=>value===null||value===undefined?'—':(value/1000).toFixed(1)+' s';
const categories={internal:'Internal',workflow:'Workflow wait',third_party:'Third-party',llm:'LLM',unmeasured:'Unmeasured'};
const time=value=>value?new Date(value).toLocaleString():'Not observed';

/** One message: where its reply time went, stage by stage. Stages never overlap. */
function Breakdown({id}){
  const {data,error}=useResource('/workflows/timings/'+id);
  if(error)return h('p',{role:'alert'},'Timing for this message is unavailable.');
  if(!data)return h('p',{role:'status'},'Loading stage timing…');
  return h('div',{className:'n-timing-breakdown'},
    h('p',null,h('b',null,'Reply '+seconds(data.reply_ms)),' · attempts '+data.attempts+(data.complete?'':' · incomplete: no delivery timing recorded')),
    !data.stages.length&&h('p',{className:'n-empty'},'No stage timing was recorded for this message.'),
    data.stages.length>0&&h('table',{className:'n-timing-table'},
      h('thead',null,h('tr',null,h('th',{scope:'col'},'Category'),h('th',{scope:'col'},'Stage'),h('th',{scope:'col',className:'n-number'},'Time'))),
      h('tbody',null,...data.stages.map(stage=>h('tr',{key:stage.stage},h('td',null,categories[stage.category]||stage.category),
        h('td',null,stage.label+(stage.calls>1?' ('+stage.calls+' calls)':'')),h('td',{className:'n-number'},seconds(stage.ms)))))));
}

/** Per-stage p50/p95 across recent replies, and each recent reply's breakdown on request. */
export function ReplyTimings(){
  const {data,error}=useResource('/workflows/timings',30000),[selected,setSelected]=useState(null);
  if(error)return h('p',{role:'alert'},'Reply timing is unavailable. The running installation may predate stage timing.');
  if(!data)return h('p',{role:'status'},'Loading reply timing…');
  return h('div',null,
    h('p',{className:'n-muted'},'Measured from Telegram’s message time to the delivered reply. Overlapping measurements are never added together; time no measurement explains is shown as unmeasured.'),
    !data.messages&&h('p',{className:'n-empty'},'No replied message has stage timing yet.'),
    data.messages>0&&h('section',null,h('h3',null,'Across the last '+data.messages+' replies'),
      h('p',null,'Reply time p50 '+seconds(data.reply_ms_p50)+' · p95 '+seconds(data.reply_ms_p95)),
      h('table',{className:'n-timing-table'},
        h('thead',null,h('tr',null,h('th',{scope:'col'},'Category'),h('th',{scope:'col'},'Stage'),h('th',{scope:'col',className:'n-number'},'p50'),
          h('th',{scope:'col',className:'n-number'},'p95'),h('th',{scope:'col',className:'n-number'},'Messages'))),
        h('tbody',null,...data.stages.map(stage=>h('tr',{key:stage.stage},h('td',null,categories[stage.category]||stage.category),h('td',null,stage.label),
          h('td',{className:'n-number'},seconds(stage.ms_p50)),h('td',{className:'n-number'},seconds(stage.ms_p95)),h('td',{className:'n-number'},stage.messages)))))),
    data.recent?.length>0&&h('section',null,h('h3',null,'Recent replies'),
      ...data.recent.map(item=>h('div',{key:item.event_id},
        h('div',{className:'n-row'},h('div',null,h('b',null,time(item.started_at)),h('span',null,' · reply '+seconds(item.reply_ms)+' · unmeasured '+seconds(item.unmeasured_ms))),
          h('button',{type:'button','aria-expanded':selected===item.event_id,onClick:()=>setSelected(selected===item.event_id?null:item.event_id)},selected===item.event_id?'Hide stages':'Show stages')),
        selected===item.event_id&&h(Breakdown,{id:item.event_id})))));
}

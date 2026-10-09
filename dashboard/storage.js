import * as React from 'react';
import {useResource} from './lib/resource';
const {createElement:h}=React;

export function size(bytes){
  if(typeof bytes!=='number')return '—';
  let value=bytes;
  for(const unit of ['B','KB','MB','GB']){if(value<1024||unit==='GB')return unit==='B'?value+' B':value.toFixed(1)+' '+unit;value/=1024;}
}

/** Where disk is used, read-only. Owned originals grow by design; everything else is bounded. */
export function StorageUsage(){
  const {data,error}=useResource('/storage');
  if(error)return h('p',{role:'alert'},'Storage usage is unavailable. The database services may be stopped.');
  if(!data)return h('p',{role:'status'},'Measuring storage…');
  const retention=data.retention_days,logs=data.docker_logs||{};
  return h('div',{className:'n-storage'},
    h('p',{className:'n-muted'},'Owned originals are kept without a limit by design. Workflow history, operational records and logs are bounded.'),
    ...(data.databases||[]).map(row=>h('section',{key:row.database},
      h('h3',null,row.database+' · '+row.role+' · '+(row.state==='measured'?size(row.bytes):'not running')),
      row.state==='measured'&&row.largest_tables?.length>0&&h('table',{className:'n-timing-table'},
        h('thead',null,h('tr',null,h('th',{scope:'col'},'Largest tables'),h('th',{scope:'col',className:'n-number'},'Size'),h('th',{scope:'col',className:'n-number'},'About rows'))),
        h('tbody',null,...row.largest_tables.map(table=>h('tr',{key:table.table},h('td',null,table.table),
          h('td',{className:'n-number'},size(table.bytes)),h('td',{className:'n-number'},table.estimated_rows.toLocaleString()))))))),
    h('section',null,h('h3',null,'Local state folders'),
      !(data.state_folders||[]).length&&h('p',{className:'n-empty'},'No local state folders were found.'),
      ...(data.state_folders||[]).map(row=>h('div',{className:'n-row',key:row.path},h('b',null,row.path),
        h('span',null,(row.complete===false?'at least ':'')+size(row.bytes))))),
    h('p',null,'Docker logs: at most '+(logs.max_files_per_container??'—')+' × '+(logs.max_size_per_file??'—')+' per container.'),
    h('p',null,'Workflow history retention: '+(retention?retention+' days':'off')+'.'));
}

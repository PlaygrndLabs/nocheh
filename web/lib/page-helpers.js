import * as React from 'react';
import {fetchJSON,authedFetch} from '../client.js';
import {Button} from '../components/ui/primitives';
const sdk = {React,fetchJSON,authedFetch};
  const {createElement: h, useState, useEffect, useRef, useMemo} = React;
  const base = '/api/nocheh';
  const call = (path, body, options = {}) => fetchJSON(base + path, body === undefined ? options : {
    ...options,
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
  });
  const button = (label, onClick, disabled = false, className = '') => h(Button, {type: 'button', onClick, disabled, className,variant:className.includes('n-primary')?'default':'outline'}, label);
  const errorText = e => ({configuration_conflict:'These settings changed elsewhere. Refresh this page and review your changes again.', operation_in_progress:'Another maintenance task is running. Wait for it to finish and try again.'})[e.message] || e.message || 'The operation could not finish. Try again.';
  const labels = {NOCHEH_PORT:'Archive port', NOCHEH_MODEL:'ChatGPT model', NOCHEH_GUARD_MODE:'Secret guarding',
    NOCHEH_GUARD_TRUSTED_ENDPOINTS:'Trusted destinations (JSON)', TELEGRAM_ENABLED:'Telegram enabled',
    TELEGRAM_BOT_TOKEN:'Telegram bot token', TELEGRAM_OWNER_ID:'Owner user ID', TELEGRAM_GROUP_IDS:'Selected group IDs',
    POSTGRES_PASSWORD:'Database credential', SERVICE_TOKEN:'Service credential', NOCHEH_CONFIG_VERSION:'Configuration version'};
  function Panel({title, children, note}) { return h('section', {className:'n-panel'}, h('h2', null, title), note && h('p', {className:'n-muted'}, note), children); }
  function Data({value}) { return h('pre', {className:'n-data', dir:'auto'}, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }
  const friendlyState = value => ({ready:'Ready',running:'In progress',complete:'Complete',failed:'Needs attention',cancelled:'Stopped',interrupted:'Interrupted',uploading:'Uploading',pending:'Waiting'})[value] || String(value||'Unknown').replaceAll('_',' ');
  const jobName = value => ({import:'Chat import','settings.apply':'Apply settings','operations.diagnose':'Service diagnostics','operations.export':'Archive export','operations.portable-export':'Archive and memory export','operations.backup':'Full backup','operations.restart':'Service restart','operations.restore':'Inactive restore'})[value] || value;
  const profileName = p => (p.owner?'Owner · private DM':'Group')+' · '+p.scope;
  function Details({value,label='Technical details'}) { return h('details',null,h('summary',null,label),h(Data,{value})); }
  function RouteLink({page,children}) { return h('a',{href:'#'+page,className:'n-text-link'},children); }
  function Steps({items,current}) { return h('ol',{className:'n-steps'},...items.map((item,i)=>h('li',{key:item,'aria-current':current===i?'step':undefined,className:current===i?'active-step':current>i?'complete-step':''},h('span',{'aria-hidden':true},current>i?'✓':i+1),item))); }

  function download(path,name) {
    const a=document.createElement('a');a.href=base+path+'?name='+encodeURIComponent(name);a.download=name;document.body.appendChild(a);a.click();a.remove();
  }
  function exportJSON(value,name){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}

export {React,sdk,h,useState,useEffect,useRef,useMemo,base,call,button,errorText,labels,Panel,Data,friendlyState,jobName,profileName,Details,RouteLink,Steps,download,exportJSON};
export {useLoad,useResource,refreshResources} from './resource';
export {StatusBadge} from '../components/status';
export {Button,Badge,Alert,Progress,Table,Tabs,TabsList,TabsTrigger,TabsContent,Modal,Sheet,EmptyState} from '../components/ui/primitives';

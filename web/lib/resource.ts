import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {fetchJSON} from '../client.js';
import {createResourceStore,type Snapshot} from './resource-store';
export type {Snapshot} from './resource-store';
const store=createResourceStore((path,options)=>fetchJSON('/api/nocheh'+path,options));
export async function refreshResources(){const request=store.refresh();window.dispatchEvent(new Event('nocheh:refresh'));await request;}
const empty:Snapshot<any>={data:null,error:'',loading:false,receivedAt:null};
export function useResource<T=any>(path:string|null,interval=0,revision=0):Snapshot<T>{
 const value=path?store.get(path):null;
 const subscribe=useCallback((listener:()=>void)=>value?store.subscribe(value,listener):()=>{},[value]);
 const snapshot=useSyncExternalStore(subscribe,useCallback(()=>value?.snapshot||empty,[value]));
 useEffect(()=>value?store.observe(value,interval):undefined,[value,interval,revision]);
 return snapshot;
}
export function useLoad(path:string|null,revision=0):[any,string]{const {data,error}=useResource(path,0,revision);return [data,error];}

/** Refreshes only the resources visible on this page when the owner stream ticks. */
export function useLiveResources(paths:(string|null)[],prefixes:string[]=[]):'connecting'|'live'|'reconnecting'{
 const current=useRef({paths,prefixes});current.current={paths,prefixes};
 const [state,setState]=useState<'connecting'|'live'|'reconnecting'>('connecting');
 useEffect(()=>{
  let stream:EventSource|undefined,fallback:ReturnType<typeof setInterval>|undefined;
  const refresh=()=>{void store.refreshPaths(current.current.paths,current.current.prefixes);};
  const startFallback=()=>{if(!fallback)fallback=setInterval(()=>{if(document.visibilityState==='visible')refresh();},10000);};
  const stopFallback=()=>{if(fallback)clearInterval(fallback);fallback=undefined;};
  const connect=()=>{
   if(document.visibilityState==='hidden')return;
   if(typeof EventSource==='undefined'){setState('reconnecting');startFallback();return;}
   stream=new EventSource('/api/nocheh/changes');
   stream.addEventListener('refresh',refresh);
   stream.onopen=()=>{setState('live');stopFallback();refresh();};
   stream.onerror=()=>{setState('reconnecting');startFallback();};
  };
  const visibility=()=>{if(document.visibilityState==='hidden'){stream?.close();stream=undefined;stopFallback();setState('connecting');}else{connect();refresh();}};
  document.addEventListener('visibilitychange',visibility);connect();
  return()=>{document.removeEventListener('visibilitychange',visibility);stream?.close();stopFallback();};
 },[]);
 return state;
}

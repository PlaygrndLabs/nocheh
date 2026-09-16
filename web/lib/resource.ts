import {useCallback,useEffect,useSyncExternalStore} from 'react';
import {fetchJSON} from '../client.js';
export type Snapshot<T>={data:T|null;error:string;loading:boolean;receivedAt:number|null};
type Entry={snapshot:Snapshot<any>;listeners:Set<()=>void>;intervals:Map<symbol,number>;controller?:AbortController;timer?:ReturnType<typeof setTimeout>;sequence:number;path:string};
const entries=new Map<string,Entry>();
function entry(path:string){let value=entries.get(path);if(!value){value={path,snapshot:{data:null,error:'',loading:false,receivedAt:null},listeners:new Set(),intervals:new Map(),sequence:0};entries.set(path,value);}return value;}
function emit(value:Entry){for(const listener of value.listeners)listener();}
function schedule(value:Entry){clearTimeout(value.timer);const intervals=[...value.intervals.values()].filter(n=>n>0);if(intervals.length)value.timer=setTimeout(()=>void update(value),Math.min(...intervals));}
async function update(value:Entry){
 if(value.controller)return;
 const controller=new AbortController(),sequence=++value.sequence;value.controller=controller;
 value.snapshot={...value.snapshot,loading:true};emit(value);
 try{const data=await fetchJSON('/api/nocheh'+value.path,{signal:controller.signal});if(sequence===value.sequence)value.snapshot={data,error:'',loading:false,receivedAt:Date.now()};}
 catch(error){if(!controller.signal.aborted&&sequence===value.sequence)value.snapshot={...value.snapshot,loading:false,error:error instanceof Error?error.message:'Request unavailable'};}
 finally{if(sequence===value.sequence){value.controller=undefined;emit(value);schedule(value);}}
}
export function refreshResources(){for(const value of entries.values())if(value.listeners.size)void update(value);window.dispatchEvent(new Event('nocheh:refresh'));}
const empty:Snapshot<any>={data:null,error:'',loading:false,receivedAt:null};
export function useResource<T=any>(path:string|null,interval=0,revision=0):Snapshot<T>{
 const value=path?entry(path):null;
 const subscribe=useCallback((listener:()=>void)=>{if(!value)return()=>{};value.listeners.add(listener);return()=>{value.listeners.delete(listener);if(!value.listeners.size){clearTimeout(value.timer);value.sequence++;value.controller?.abort();value.controller=undefined;entries.delete(value.path);}};},[value]);
 const snapshot=useSyncExternalStore(subscribe,useCallback(()=>value?.snapshot||empty,[value]));
 useEffect(()=>{if(!value)return;const id=Symbol();value.intervals.set(id,interval);void update(value);return()=>{value.intervals.delete(id);schedule(value);};},[value,interval,revision]);
 return snapshot;
}
export function useLoad(path:string|null,revision=0):[any,string]{const {data,error}=useResource(path,0,revision);return [data,error];}

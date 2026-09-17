import {useCallback,useEffect,useSyncExternalStore} from 'react';
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

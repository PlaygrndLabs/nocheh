export type Snapshot<T>={data:T|null;error:string;loading:boolean;receivedAt:number|null};
export type Entry={snapshot:Snapshot<any>;listeners:Set<()=>void>;intervals:Map<symbol,number>;controller?:AbortController;timer?:ReturnType<typeof setTimeout>;sequence:number;path:string};
/** Shared requests survive a React commit that hands a path between pages. */
export function createResourceStore(fetcher:(path:string,options:{signal:AbortSignal})=>Promise<unknown>){
 const entries=new Map<string,Entry>();
 const emit=(value:Entry)=>{for(const listener of value.listeners)listener();};
 function get(path:string){let value=entries.get(path);if(!value){value={path,snapshot:{data:null,error:'',loading:false,receivedAt:null},listeners:new Set(),intervals:new Map(),sequence:0};entries.set(path,value);}return value;}
 function schedule(value:Entry){clearTimeout(value.timer);const intervals=[...value.intervals.values()].filter(n=>n>0);if(value.listeners.size&&intervals.length)value.timer=setTimeout(()=>void update(value),Math.min(...intervals));}
 async function update(value:Entry){
  if(value.controller)return;
  const controller=new AbortController(),sequence=++value.sequence;value.controller=controller;
  value.snapshot={...value.snapshot,loading:true};emit(value);
  try{const data=await fetcher(value.path,{signal:controller.signal});if(sequence===value.sequence)value.snapshot={data,error:'',loading:false,receivedAt:Date.now()};}
  catch(error){if(!controller.signal.aborted&&sequence===value.sequence)value.snapshot={...value.snapshot,loading:false,error:error instanceof Error?error.message:'Request unavailable'};}
  finally{if(sequence===value.sequence){value.controller=undefined;emit(value);schedule(value);}}
 }
 function subscribe(value:Entry,listener:()=>void){value.listeners.add(listener);return()=>{
  value.listeners.delete(listener);
  // Incoming consumers have already read this entry during render. Let their
  // subscriptions attach before retiring it; deleting here creates two stores
  // for the same path and an unstable useSyncExternalStore snapshot loop.
  queueMicrotask(()=>{if(!value.listeners.size&&entries.get(value.path)===value){clearTimeout(value.timer);value.sequence++;value.controller?.abort();value.controller=undefined;entries.delete(value.path);}});
 };}
 function observe(value:Entry,interval:number){const id=Symbol();value.intervals.set(id,interval);void update(value);return()=>{value.intervals.delete(id);schedule(value);};}
 return {get,subscribe,observe,update,refresh:()=>Promise.allSettled([...entries.values()].filter(value=>value.listeners.size).map(update))};
}

/** Content-free, monotonic broker observations. These are not model compute time. */
export const timingKeys=['broker_prepare_ms','provider_headers_ms','provider_read_ms','downstream_ms','provider_chunks'] as const;
export type ModelTimings=Partial<Record<typeof timingKeys[number],number>>;
export function safeTimings(value:unknown):ModelTimings|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const result:ModelTimings={};
  for(const key of timingKeys){
    const item=(value as Record<string,unknown>)[key];
    if(typeof item==='number'&&Number.isSafeInteger(item)&&item>=0&&item<=86400000)result[key]=item;
  }
  return Object.keys(result).length?result:null;
}
export function elapsed(start:number):number {return Math.max(0,Math.round(performance.now()-start));}

/** Measure only awaiting upstream bytes; caller policy checks/backpressure are outside. */
export async function* timedBody(body:ReadableStream<Uint8Array>,timings:ModelTimings) {
  const iterator=body[Symbol.asyncIterator]();let finished=false;
  timings.provider_read_ms=0;timings.provider_chunks=0;
  try {
    while(true){
      const start=performance.now();let next:IteratorResult<Uint8Array>;
      try{next=await iterator.next();}finally{timings.provider_read_ms+=elapsed(start);}
      if(next.done){finished=true;return;}
      timings.provider_chunks++;
      yield next.value;
    }
  }finally{if(!finished)await iterator.return?.();}
}

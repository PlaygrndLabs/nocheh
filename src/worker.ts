import type pg from 'pg';
import type { Settings } from './config.js';
import { drainSpool, fetchAttachments } from './storage.js';
import { HttpError, object, string } from './http.js';

export async function hermesCall(config: Settings, path:string, body:unknown, timeout=120000):Promise<Record<string,unknown>> {
  const response=await fetch(`${config.hermesUrl}${path}`, {method:'POST',
    headers:{authorization:`Bearer ${config.token}`,'content-type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
  if (!response.ok) {
    let code=response.status===429?'quota_paused':'hermes_unavailable';
    if (path==='/internal/detect') {
      const error=await response.json().catch(()=>null) as {error?:string}|null;
      if (error?.error==='detector_contract_rejected') code=error.error;
    }
    throw new HttpError(response.status,code);
  }
  return object(await response.json());
}
export function startWorker(pool:pg.Pool,config:Settings):()=>void {
  let busy=false,stopped=false;
  const run=async()=>{
    if (busy || stopped) return;
    busy=true;
    try {
      await drainSpool(pool,config.dataDir);
      await fetchAttachments(pool,config.dataDir,async(ref)=>{
        const result=await hermesCall(config,'/internal/file',{file_id:ref});
        return Buffer.from(string(result.bytes_base64,70*1024*1024),'base64');
      });
    } catch { console.error(JSON.stringify({event:'worker_cycle_failed'})); }
    finally { busy=false; }
  };
  const timer=setInterval(()=>{void run();},1000); void run();
  return ()=>{stopped=true;clearInterval(timer);};
}

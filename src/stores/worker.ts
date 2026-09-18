import {existsSync} from 'node:fs';
import {join} from 'node:path';
import type {Settings} from '../config.js';
import {startLoops} from '../worker-loops.js';
import {workflowClient} from '../workflows/client.js';
import {publishOutbox} from '../workflows/store.js';
import {drainSourceSpool} from './capture.js';
import {restoredInactive,storageHeartbeat} from './lifecycle.js';
import type {StorageServices} from './services.js';

export function startStorageCapture(s:StorageServices,config:Settings,interval=1000) {
  const status:Record<string,string>={capture:'starting',reconciliation:'starting',guards:'starting',outbox:'starting',heartbeat:'starting'};
  let publisher:ReturnType<typeof workflowClient>|undefined,configured=false;
  const jobs:Record<string,()=>Promise<unknown>>={
    capture:()=>drainSourceSpool(s.capture,config.dataDir),
    reconciliation:()=>s.capture.reconcile(),
    guards:async()=>{
      await s.guards.reconcile();await s.selections.reconcile();await s.learned.reconcile();
      if(!configured){await s.configuration.configure(config.assistant,config.guardMode);configured=true;}
    },
    outbox:async()=>{
      if(existsSync(join(config.dataDir,'workflows/inactive'))){status.outbox='inactive';return;}
      publisher??=workflowClient('pipeline');await publishOutbox(s.stores.control,event=>publisher!.send(event));
    },
    heartbeat:()=>storageHeartbeat(s.stores,config.service),
  };
  const stop=startLoops(Object.fromEntries(Object.entries(jobs).map(([stage,run])=>[stage,async()=>{
    if(restoredInactive(config.dataDir)){status[stage]='inactive';return;}
    status[stage]='working';await run();if(status[stage]==='working')status[stage]='ready';
  }])),interval,stage=>{status[stage]='unavailable';console.error(JSON.stringify({event:'worker_stage_failed',stage}));});
  return {stop,status:()=>({...status})};
}

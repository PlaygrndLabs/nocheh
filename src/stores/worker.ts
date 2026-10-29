import {existsSync} from 'node:fs';
import {join} from 'node:path';
import type {Settings} from '../config.js';
import {startLoops} from '../worker-loops.js';
import {workflowClient} from '../workflows/client.js';
import {publishOutbox,retireSupersededSourceWorkflows} from '../workflows/store.js';
import {drainSourceSpool} from './capture.js';
import {requestStrandedSources} from './native-review.js';
import {expireStageTimings} from './stage-timings.js';
import {restoredInactive,storageHeartbeat} from './lifecycle.js';
import type {StorageServices} from './services.js';

export function startStorageCapture(s:StorageServices,config:Settings,interval=1000) {
  const status:Record<string,string>={capture:'starting',reconciliation:'starting',guards:'starting',outbox:'starting',heartbeat:'starting',timings:'starting',reminders:'starting',imports:'starting',voices:'starting'};
  let publisher:ReturnType<typeof workflowClient>|undefined,configured=false,staleSourcesReconciled=false,strandedRequested=false,started=new Date(),timingsExpired=0,remindersChecked=0,importsChecked=0,voicesChecked=0;
  const jobs:Record<string,()=>Promise<unknown>>={
    capture:()=>drainSourceSpool(s.capture,config.dataDir),
    reconciliation:()=>s.capture.reconcile(),
    guards:async()=>{
      await s.guards.reconcile();await s.selections.reconcile();await s.learned.reconcile();
      if(!configured){await s.configuration.configure(config.assistant,config.guardMode);configured=true;}
    },
    outbox:async()=>{
      if(existsSync(join(config.dataDir,'workflows/inactive'))){status.outbox='inactive';return;}
      if(!staleSourcesReconciled)staleSourcesReconciled=(await retireSupersededSourceWorkflows(s.stores.control))<100;
      if(staleSourcesReconciled&&!strandedRequested)strandedRequested=(await requestStrandedSources(s.stores.control,started))<100;
      publisher??=workflowClient('pipeline');await publishOutbox(s.stores.control,event=>publisher!.send(event));
    },
    heartbeat:()=>storageHeartbeat(s.stores,config.service),
    // Stage timings are diagnostics with the same bounded retention as workflow history.
    timings:async()=>{if(Date.now()-timingsExpired<3600000)return;await expireStageTimings(s.stores.control);timingsExpired=Date.now();},
    // Task reminders that are due go to the owner's private chat; a full batch is followed by the next one at once.
    reminders:async()=>{if(Date.now()-remindersChecked<15000)return;if(await s.tasks.remind()<20)remindersChecked=Date.now();},
    // An import becomes ready once its messages are prepared; the owner hears about it once.
    imports:async()=>{if(Date.now()-importsChecked<30000)return;await s.imports.settle();importsChecked=Date.now();},
    // Voice notes saved before transcription was set up are transcribed a few at a time.
    voices:async()=>{if(Date.now()-voicesChecked<60000)return;voicesChecked=Date.now();await s.voices.transcribe();},
  };
  const stop=startLoops(Object.fromEntries(Object.entries(jobs).map(([stage,run])=>[stage,async()=>{
    if(restoredInactive(config.dataDir)){status[stage]='inactive';return;}
    status[stage]='working';await run();if(status[stage]==='working')status[stage]='ready';
  }])),interval,stage=>{status[stage]='unavailable';console.error(JSON.stringify({event:'worker_stage_failed',stage}));});
  return {stop,status:()=>({...status})};
}

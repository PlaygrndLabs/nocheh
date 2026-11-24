import {existsSync} from 'node:fs';
import {join} from 'node:path';
import type {Settings} from '../config.js';
import {startLoops} from '../worker-loops.js';
import {workflowClient} from '../workflows/client.js';
import {publishOutbox,rearmWaiting,retireSupersededSourceWorkflows} from '../workflows/store.js';
import {reviveSchedules} from '../workflows/schedules.js';
import {drainSourceSpool} from './capture.js';
import {requestStrandedSources} from './native-review.js';
import {expireStageTimings} from './stage-timings.js';
import {restoredInactive,storageHeartbeat} from './lifecycle.js';
import type {StorageServices} from './services.js';

export function startStorageCapture(s:StorageServices,config:Settings,interval=1000) {
  const status:Record<string,string>={capture:'starting',sends:'starting',reconciliation:'starting',guards:'starting',outbox:'starting',heartbeat:'starting',timings:'starting',reminders:'starting',imports:'starting',voices:'starting',machines:'starting',answers:'starting',members:'starting',adds:'starting'};
  let publisher:ReturnType<typeof workflowClient>|undefined,configured=false,staleSourcesReconciled=false,strandedRequested=false,schedulesArmed=false,schedulesRevived=false,reviveLogged=false,lostChecked=0,started=new Date(),timingsExpired=0,sendsExpired=0,remindersChecked=0,importsChecked=0,voicesChecked=0,machinesChecked=0,answersExpired=0,membersChecked=0,addsChecked=0;
  const jobs:Record<string,()=>Promise<unknown>>={
    capture:()=>drainSourceSpool(s.capture,config.dataDir),
    // The front doors' send records, in their own stage so an outage here never holds up source capture.
    // The owner's "Keep delivery logs" days expire them, checked hourly.
    sends:async()=>{
      await s.chatSends.drain(config.dataDir);
      if(Date.now()-sendsExpired<3600000)return;sendsExpired=Date.now();await s.chatSends.expire();
    },
    reconciliation:()=>s.capture.reconcile(),
    guards:async()=>{
      await s.guards.reconcile();await s.selections.reconcile();await s.learned.reconcile();
      if(!configured){await s.configuration.configure(config.assistant,config.guardMode);configured=true;}
    },
    outbox:async()=>{
      if(existsSync(join(config.dataDir,'workflows/inactive'))){status.outbox='inactive';return;}
      if(!staleSourcesReconciled)staleSourcesReconciled=(await retireSupersededSourceWorkflows(s.stores.control))<100;
      if(staleSourcesReconciled&&!strandedRequested)strandedRequested=(await requestStrandedSources(s.stores.control,started))<100;
      // A schedule waits in Inngest until its next run. A full restart can lose that wait, and the schedule would never run
      // again, so each waiting schedule is armed again once at startup, and one whose run is two minutes overdue with no
      // word from Inngest is armed again. A schedule a Run now left with no open run starts again at startup (ADR-0266).
      // A repair that fails never holds up publishing: it is logged once and tried again on the next pass.
      if(!schedulesRevived)try{await reviveSchedules(s.stores.control);schedulesRevived=true;}
      catch(error){if(!reviveLogged)console.error(JSON.stringify({event:'schedule_revive_failed',code:(error as {code?:unknown})?.code}));reviveLogged=true;}
      if(!schedulesArmed)schedulesArmed=(await rearmWaiting(s.stores.control,['schedules'],null))<100;
      if(Date.now()-lostChecked>=60000){lostChecked=Date.now();await rearmWaiting(s.stores.control,['schedules'],'2 minutes');}
      publisher??=workflowClient('pipeline');await publishOutbox(s.stores.control,event=>publisher!.send(event));
    },
    heartbeat:()=>storageHeartbeat(s.stores,config.service),
    // Stage timings are diagnostics with the same bounded retention as workflow history.
    timings:async()=>{if(Date.now()-timingsExpired<3600000)return;await expireStageTimings(s.stores.control);timingsExpired=Date.now();},
    // Task reminders that are due go to whoever set them (ADR-0265 D9): the owner's to the owner's private chat, a member's to
    // their own private chat; a full batch is followed by the next one at once.
    reminders:async()=>{if(Date.now()-remindersChecked<15000)return;if(await s.tasks.remind()<20)remindersChecked=Date.now();},
    // An import becomes ready once its messages are prepared; the owner hears about it once.
    imports:async()=>{if(Date.now()-importsChecked<30000)return;await s.imports.settle();importsChecked=Date.now();},
    // Voice notes saved before transcription was set up are transcribed a few at a time.
    voices:async()=>{if(Date.now()-voicesChecked<60000)return;voicesChecked=Date.now();await s.voices.transcribe();},
    // A stopped machine job's programs on its machine are ended, and log rows a stopped process left running are closed.
    machines:async()=>{if(Date.now()-machinesChecked<5000)return;machinesChecked=Date.now();await s.machines.cleanupTick();},
    // Answer privately buttons nobody used, taps without /start and answers never delivered expire, checked hourly; the
    // rows stay as the record (ADR-0249).
    answers:async()=>{if(Date.now()-answersExpired<3600000)return;await s.privateAnswers.expire();answersExpired=Date.now();},
    // A member spend or pause notice that did not go is sent again, also when no member job ticks any more that day.
    members:async()=>{if(Date.now()-membersChecked<60000)return;membersChecked=Date.now();await s.jobs.members.retryUnsent();},
    // Someone added Nocheh to a group or removed it: leave, the card for the owner's own add, and the owner's notes
    // (ADR-0253). A full batch is followed by the next one at once.
    adds:async()=>{if(Date.now()-addsChecked<5000)return;if(await s.chatAdds.settle()<20)addsChecked=Date.now();},
  };
  const stop=startLoops(Object.fromEntries(Object.entries(jobs).map(([stage,run])=>[stage,async()=>{
    if(restoredInactive(config.dataDir)){status[stage]='inactive';return;}
    status[stage]='working';await run();if(status[stage]==='working')status[stage]='ready';
  }])),interval,stage=>{status[stage]='unavailable';console.error(JSON.stringify({event:'worker_stage_failed',stage}));});
  return {stop,status:()=>({...status})};
}

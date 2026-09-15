import type pg from 'pg';
import type { Settings } from './config.js';
import { drainSpool } from './storage.js';
import { startLoops } from './worker-loops.js';
import {recoverRuns} from './managed-runs.js';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {publishOutbox} from './workflows/store.js';
import {workflowClient} from './workflows/client.js';

export function startCapture(pool:pg.Pool,config:Settings) {
  const inactive=existsSync(join(config.dataDir,'spool/.restore-inactive'));
  const status:Record<string,string>={capture:inactive?'inactive':'starting',outbox:inactive?'inactive':'starting'};
  if(inactive)return {stop:async()=>{},status:()=>status};
  let publisher:ReturnType<typeof workflowClient>|undefined;
  const stop=startLoops({
    capture:async()=>{await drainSpool(pool,config.dataDir);status.capture='ready';},
    outbox:async()=>{
      if(existsSync(join(config.dataDir,'workflows/inactive'))){status.outbox='inactive';return;}
      publisher??=workflowClient('pipeline');
      await publishOutbox(pool,event=>publisher!.send(event));status.outbox='ready';
    },
    recovery:()=>recoverRuns(pool),
  },1000,stage=>{status[stage]='unavailable';console.error(JSON.stringify({event:'worker_stage_failed',stage}));});
  return {stop,status:()=>({...status})};
}

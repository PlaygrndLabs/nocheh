import type pg from 'pg';
import type { Settings } from './config.js';
import { drainSpool, fetchAttachments } from './storage.js';
import { string } from './http.js';
import { hermesAdapter } from './hermes-adapter.js';
import { runtimeCall } from './runtime.js';
import { dispatchCommitted } from './assistant.js';
import { executeApproved } from './actions.js';
import { startLoops } from './worker-loops.js';
import { runReviewJobs } from './learning.js';

export function startWorker(pool:pg.Pool,config:Settings):()=>Promise<void> {
  const call = runtimeCall(hermesAdapter({url: config.hermesUrl, token: config.token}));
  return startLoops({
    capture:()=>drainSpool(pool,config.dataDir),
    attachments:()=>fetchAttachments(pool,config.dataDir,async(ref)=>{
        const result=await call('source.file',{file_id:ref});
        return Buffer.from(string(result.bytes_base64,70*1024*1024),'base64');
    }),
    assistant:()=>dispatchCommitted(pool,config,call),
    learning:()=>runReviewJobs(pool,config,call),
    actions:async()=>{if(config.assistant.enabled)await executeApproved(pool,call);},
  });
}

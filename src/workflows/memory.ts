import type pg from 'pg';
import type {Settings} from '../config.js';
import type {RuntimeCall} from '../runtime.js';
import {HttpError} from '../http.js';
import {guardState} from '../guarded.js';
import {prepareReviews,runReviewJobs} from '../learning.js';
import {memoryStatus,queueMemory,syncMemory,observeGeneration,refreshMemoryContext,reconcileHonchoReceipt,type HonchoCall} from '../honcho.js';
import {observation,type WorkflowOperation} from './pipeline.js';
import {enterFamily,leaveFamily,releaseOperation,type ExecutionAuthority,type WorkflowFamily} from './store.js';

async function fenced(pool:pg.Pool,family:WorkflowFamily,authority:ExecutionAuthority,operation:()=>ReturnType<WorkflowOperation>) {
  const client=await pool.connect();let held=false;
  try {held=await enterFamily(client,family,authority.owner,authority.epoch);return held?await operation():observation('waiting','admission',0,Date.now()+30000,'owner_paused');}
  finally{await releaseOperation(client,async()=>{if(held)await leaveFamily(client,family);});}
}
export function memoryOperations(pool:pg.Pool,config:Settings,runtime:RuntimeCall,honcho:HonchoCall):Partial<Record<WorkflowFamily,WorkflowOperation>> {
  return {
    memory_review:async(jobId,authority)=>{
      if(jobId==='refresh'||/^source:[a-f0-9]{64}$/.test(jobId))return fenced(pool,'memory_review',authority,async()=>{
        const event=jobId==='refresh'?null:jobId.slice(7);
        await prepareReviews(pool,config.assistant.enabled,event);
        if(event&&!(await pool.query('SELECT 1 FROM memory_learning_sources WHERE event_id=$1',[event])).rowCount)return observation('denied','review',0,Date.now(),'consent_required');
        const pending=(await pool.query(`SELECT count(*)::int AS count FROM memory_learning_sources WHERE (NOT prepared OR prepared_epoch IS DISTINCT FROM (SELECT epoch FROM guard_state))
          AND ($1::text IS NULL OR event_id=$1)`,[event])).rows[0].count;
        return observation(pending?'waiting':'completed','review',0,Date.now()+30000,pending?'prerequisite':null);
      });
      if(!/^review:[a-f0-9]{64}$/.test(jobId))return observation('failed','admission');
      const id=jobId.slice(7),load=async()=> (await pool.query(`SELECT j.*,EXISTS(SELECT 1 FROM memory_learning_sources s WHERE s.event_id=j.event_id) AS consent FROM memory_review_jobs j WHERE id=$1`,[id])).rows[0];
      let job=await load();if(!job)return observation('failed','review');
      if(!job.consent)return observation('denied','review',job.attempts,Date.now(),'consent_required');
      if(Number(job.guard_epoch)!==(await guardState(pool)).epoch)return observation('skipped','review',job.attempts,Date.now(),'superseded');
      if(['pending','failed','running'].includes(job.state)&&job.next_attempt<=new Date()){await runReviewJobs(pool,config,runtime,id,authority);job=await load();}
      const state=job.state==='done'?'completed':job.state==='ambiguous'?'ambiguous':job.state==='failed'?'retryable_failed':job.state==='running'?'running':'waiting';
      return observation(state,'review',job.attempts,job.state==='paused'?Date.now()+30000:job.next_attempt.getTime(),job.state==='paused'?'owner_paused':state==='retryable_failed'?'runtime_unavailable':state==='waiting'?'prerequisite':null);
    },
    honcho:async(jobId,authority)=>{
      const connected=(await memoryStatus(pool)).connection;
      if(!connected.attached||!connected.verified)return observation('waiting','sync',0,Date.now()+60000,'prerequisite');
      if(jobId==='refresh')return fenced(pool,'honcho',authority,async()=>{
        const count=await queueMemory(pool);return observation(count===50?'waiting':'completed','sync',0,Date.now()+100,count===50?'prerequisite':null);
      });
      const match=/^(receipt|reconcile|generation|context):([a-f0-9]{64})$/.exec(jobId);if(!match)return observation('failed','admission');
      const kind=match[1],id=match[2]!;
      if(kind==='context')return fenced(pool,'honcho',authority,async()=>{
        try{const ready=await refreshMemoryContext(pool,id,honcho,async text=>(await runtime('guard.detect',{text})).literals);
          return observation('waiting','sync',0,Date.now()+(ready?120000:30000),ready?'refresh_interval':'prerequisite');}
        catch(error){if(error instanceof HttpError&&error.code==='memory_context_retired')return observation('skipped','sync',0,Date.now(),'superseded');throw error;}
      });
      if(kind==='generation')return fenced(pool,'honcho',authority,async()=>{
        try{const ready=await observeGeneration(pool,id,honcho);
          await refreshMemoryContext(pool,id,honcho,async text=>(await runtime('guard.detect',{text})).literals);
          return observation(ready?'completed':'waiting','sync',0,Date.now()+60000,ready?null:'prerequisite');}
        catch(error){if(error instanceof HttpError&&error.code==='memory_context_retired')return observation('skipped','sync',0,Date.now(),'superseded');throw error;}
      });
      const load=async()=> (await pool.query(`SELECT r.state,r.attempts,r.next_attempt,g.guard_epoch,g.policy_revision,
        g.state AS generation_state,EXISTS(SELECT 1 FROM guard_sources s JOIN memory_learning_sources l ON l.event_id=s.event_id WHERE s.id=r.source_id) AS consent
        FROM honcho_receipts r JOIN honcho_generations g ON g.id=r.generation WHERE r.id=$1`,[id])).rows[0];
      let receipt=await load();if(!receipt)return observation('failed','reconcile');
      if(!receipt.consent)return observation('denied','sync',receipt.attempts,Date.now(),'consent_required');
      if(kind==='reconcile')return fenced(pool,'honcho',authority,async()=>{
        const done=await reconcileHonchoReceipt(pool,id,honcho);
        if(done)await pool.query("UPDATE workflow_registry SET state='completed',waiting_reason=NULL,updated_at=now() WHERE family='honcho' AND job_id=$1 AND state='ambiguous'",['receipt:'+id]);
        return observation(done?'completed':'waiting','reconcile',receipt.attempts,Date.now()+60000,done?null:'receipt_pending');
      });
      if(receipt.state==='uncertain')return observation('ambiguous','reconcile',receipt.attempts,Date.now(),'receipt_pending');
      const policy=(await pool.query('SELECT revision FROM memory_policy_state')).rows[0].revision;
      if(receipt.generation_state==='retired'||Number(receipt.guard_epoch)!==(await guardState(pool)).epoch||receipt.policy_revision!==policy)return observation('skipped','sync',receipt.attempts,Date.now(),'superseded');
      if(receipt.state!=='done'&&receipt.next_attempt<=new Date()){await syncMemory(pool,honcho,id,authority);receipt=await load();}
      return observation(receipt.state==='done'?'completed':receipt.state==='uncertain'?'ambiguous':'retryable_failed',receipt.state==='uncertain'?'reconcile':'sync',receipt.attempts,receipt.next_attempt.getTime(),receipt.state==='done'?null:receipt.state==='uncertain'?'receipt_pending':'provider_unavailable');
    },
  };
}

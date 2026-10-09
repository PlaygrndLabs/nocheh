import type pg from 'pg';
import type {Inngest} from 'inngest';
import {claimWorkflow,closedStates,hash,type WorkflowFamily} from './store.js';
import {executionFailure,type Observation,type WorkflowOperation} from './pipeline.js';
import {workflowIdentity} from './client.js';
import {safeMetadata} from './boundary.js';
import {recordStages} from '../stores/stage-timings.js';

const waiting=(reason='owner_paused'):Observation=>({state:'waiting',stage:'admission',attempts:0,next_attempt:Date.now()+30000,waiting_reason:reason});
/** Message workflows whose steps form part of a reply's stage timing. */
const timedFamilies=new Set<WorkflowFamily>(['preparation','telegram']);
async function recordStep(pool:pg.Pool,row:any,family:WorkflowFamily,started:Date,duration:number) {
  const event=row.job_id as string,base={event_id:event,attempt:0,source:'workflow'};
  await recordStages(pool,[{...base,stage:'step:'+family,started_at:started,duration_ms:Math.max(0,duration)}]);
  try {
    // Only the first step can know its own queue time; later writes keep it.
    const published=(await pool.query('SELECT first_published_at AS at FROM workflow_outbox WHERE workflow_id=$1 AND dispatch=1',[row.id])).rows[0]?.at as Date|undefined;
    const requested=row.created_at as Date,queue=[{...base,stage:'queue:'+family,started_at:requested,duration_ms:Math.max(0,started.getTime()-requested.getTime())}];
    if(published&&published>=requested&&published<=started)queue.push({...base,stage:'outbox:'+family,started_at:requested,duration_ms:published.getTime()-requested.getTime()});
    await recordStages(pool,queue,true);
  } catch {/* Queue timing stays unmeasured. */}
}
export async function advanceWorkflow(pool:pg.Pool,id:string,dispatch:number,family:WorkflowFamily,runId:string,operation:WorkflowOperation):Promise<Observation> {
  const row=(await pool.query('SELECT w.*,f.owner,f.epoch,f.admission FROM workflow_registry w JOIN workflow_owners f USING(family) WHERE w.id=$1',[id])).rows[0];
  if(!row||row.family!==family||row.dispatch!==dispatch)return {...waiting(),state:'skipped',waiting_reason:null};
  if((closedStates as readonly string[]).includes(row.state))return {state:row.state,stage:row.stage,attempts:row.attempts,next_attempt:Date.now(),waiting_reason:null};
  if(row.owner!=='inngest'||!row.admission)return waiting();
  if((family==='memory_review'||family==='honcho')&&row.job_id.startsWith('source:')) {
    const stopped=await pool.query(`UPDATE workflow_registry old SET state='skipped',waiting_reason='superseded',
      next_attempt=NULL,revision=revision+1,updated_at=now() WHERE old.id=$1 AND old.dispatch=$2
      AND old.state IN ('queued','waiting','retryable_failed') AND old.lease_token IS NULL
      AND EXISTS (SELECT 1 FROM workflow_registry newer WHERE newer.family=old.family AND newer.job_id=old.job_id
        AND newer.version=old.version AND newer.generation>old.generation)
      AND NOT EXISTS (SELECT 1 FROM workflow_receipts receipt WHERE receipt.workflow_id=old.id
        AND receipt.state IN ('started','done','ambiguous')) RETURNING old.id`,[id,dispatch]);
    if(stopped.rowCount)return {state:'skipped',stage:row.stage,attempts:row.attempts,next_attempt:Date.now(),waiting_reason:'superseded'};
  }
  const client=await pool.connect();let claim;
  try {claim=await claimWorkflow(client,id,dispatch,runId,row.epoch);}finally{client.release();}
  if(!claim)return waiting('receipt_pending');
  const renew=setInterval(()=>{void pool.query("UPDATE workflow_registry SET lease_until=now()+interval '2 minutes' WHERE id=$1 AND lease_token=$2",[id,claim.lease_token]).catch(()=>{});},15000);
  try {
    let result:Observation;const started=new Date(),clock=performance.now();
    try{result=await operation(row.job_id,{owner:'inngest',epoch:row.epoch});}
    catch(error){result=executionFailure(error,row.attempts);}
    if(timedFamilies.has(family)&&/^[a-f0-9]{64}$/.test(row.job_id))await recordStep(pool,row,family,started,Math.round(performance.now()-clock));
    if((family==='memory_review'||family==='honcho')&&row.job_id.startsWith('source:')&&!(closedStates as readonly string[]).includes(result.state)) {
      const newer=await pool.query(`SELECT 1 FROM workflow_registry WHERE family=$1 AND job_id=$2 AND version=$3 AND generation>$4
        AND NOT EXISTS (SELECT 1 FROM workflow_receipts receipt WHERE receipt.workflow_id=$5
          AND receipt.state IN ('started','done','ambiguous')) LIMIT 1`,
        [family,row.job_id,row.version,row.generation,id]);
      if(newer.rowCount)result={...result,state:'skipped',next_attempt:Date.now(),waiting_reason:'superseded'};
    }
    safeMetadata(result);
    // The domain receipt remains authoritative even if the last step output or
    // run acknowledgment was lost. Reconciliation observes it before any effect.
    if(family==='telegram') {
      const domain=(await pool.query('SELECT state,attempts FROM dispatches WHERE event_id=$1',[row.job_id])).rows[0];
      if(domain?.attempts>0) {
        const state=domain.state==='running'?'started':domain.state==='failed'?'failed':domain.state==='ambiguous'?'ambiguous':'done';
        await pool.query(`INSERT INTO workflow_receipts(workflow_id,step,attempt,state,receipt_id) VALUES($1,'telegram',$2,$3,$4)
          ON CONFLICT(workflow_id,step,attempt) DO UPDATE SET state=excluded.state,receipt_id=excluded.receipt_id,updated_at=now()
          WHERE workflow_receipts.state='started'`,[id,domain.attempts,state,state==='started'?null:hash(row.job_id+':'+domain.attempts)]);
      }
    }
    await pool.query(`UPDATE workflow_registry SET state=$3,stage=$4,attempts=$5,next_attempt=$6,waiting_reason=$7,
      lease_token=NULL,lease_until=NULL,revision=revision+1,updated_at=now() WHERE id=$1 AND lease_token=$2
      AND state IN ('queued','waiting','running','retryable_failed')`,[id,claim.lease_token,result.state,result.stage,result.attempts,new Date(result.next_attempt),result.waiting_reason]);
    return result;
  }finally{clearInterval(renew);}
}

export async function continueWorkflow(pool:pg.Pool,id:string,dispatch:number):Promise<void> {
  const client=await pool.connect();try {
    await client.query('BEGIN');
    const updated=await client.query(`UPDATE workflow_registry SET dispatch=dispatch+1,updated_at=now() WHERE id=$1 AND dispatch=$2
      AND state IN ('queued','waiting','running','retryable_failed') RETURNING dispatch`,[id,dispatch]);
    if(updated.rowCount)await client.query('INSERT INTO workflow_outbox(id,workflow_id,dispatch) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[hash(id+':'+updated.rows[0].dispatch),id,updated.rows[0].dispatch]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export function workflowFunctions(client:Inngest,pool:pg.Pool,operations:Partial<Record<WorkflowFamily,WorkflowOperation>>,background:ReadonlySet<WorkflowFamily>=new Set()) {
  return coordinatedFunctions(client,Object.keys(operations) as WorkflowFamily[],(id,dispatch,family,runId)=>advanceWorkflow(pool,id,dispatch,family,runId,operations[family]!),
    (id,dispatch)=>continueWorkflow(pool,id,dispatch),background);
}
/** One shared Inngest queue for work that the worker admits to a single background slot. */
export const backgroundConcurrency={limit:1,key:'"nocheh-pipeline-background"',scope:'env'} as const;
export function coordinatedFunctions(client:Inngest,families:WorkflowFamily[],advance:(id:string,dispatch:number,family:WorkflowFamily,runId:string)=>Promise<Observation>,continuation:(id:string,dispatch:number)=>Promise<void>,background:ReadonlySet<WorkflowFamily>=new Set()) {
  // Without this, every waiting background run polls the busy slot and each
  // poll persists engine spans and history. Sleeping runs hold no slot.
  return families.map(family=>client.createFunction({id:family+'-v1',retries:20,
    ...(background.has(family)?{concurrency:[backgroundConcurrency]}:{}),
    triggers:[{event:'nocheh/workflow.requested',if:`event.data.family == '${family}'`}]},async({event,step,runId})=>{
      const id=workflowIdentity(event.data.workflow_id),dispatch=Number(event.data.dispatch);
      if(!Number.isSafeInteger(dispatch)||dispatch<1)throw Error('invalid_workflow_dispatch');
      for(let index=0;index<400;index++) {
        const result=await step.run('advance-'+index,()=>advance(id,dispatch,family,runId));
        if((closedStates as readonly string[]).includes(result.state))return {workflow_id:id,state:result.state};
        await step.sleepUntil('wait-'+index,new Date(Math.max(Date.now()+100,result.next_attempt)));
      }
      // Bound each run's step history without changing the permanent execution
      // identity or its receipts. Only Inngest determines when this happens.
      await step.run('continue',async()=>{await continuation(id,dispatch);return {workflow_id:id,state:'queued'};});
      return {workflow_id:id,state:'queued'};
    }));
}

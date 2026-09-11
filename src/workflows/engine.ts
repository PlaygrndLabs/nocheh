import type pg from 'pg';
import type {Inngest} from 'inngest';
import {claimWorkflow,closedStates,hash,type WorkflowFamily} from './store.js';
import {executionFailure,type Observation,type WorkflowOperation} from './pipeline.js';
import {workflowIdentity} from './client.js';
import {safeMetadata} from './boundary.js';

const waiting=(reason='owner_paused'):Observation=>({state:'waiting',stage:'admission',attempts:0,next_attempt:Date.now()+30000,waiting_reason:reason});
export async function advanceWorkflow(pool:pg.Pool,id:string,dispatch:number,family:WorkflowFamily,runId:string,operation:WorkflowOperation):Promise<Observation> {
  const row=(await pool.query('SELECT w.*,f.owner,f.epoch,f.admission FROM workflow_registry w JOIN workflow_owners f USING(family) WHERE w.id=$1',[id])).rows[0];
  if(!row||row.family!==family||row.dispatch!==dispatch)return {...waiting(),state:'skipped',waiting_reason:null};
  if((closedStates as readonly string[]).includes(row.state))return {state:row.state,stage:row.stage,attempts:row.attempts,next_attempt:Date.now(),waiting_reason:null};
  if(row.owner!=='inngest'||!row.admission)return waiting();
  const client=await pool.connect();let claim;
  try {claim=await claimWorkflow(client,id,dispatch,runId,row.epoch);}finally{client.release();}
  if(!claim)return waiting('receipt_pending');
  const renew=setInterval(()=>{void pool.query("UPDATE workflow_registry SET lease_until=now()+interval '2 minutes' WHERE id=$1 AND lease_token=$2",[id,claim.lease_token]).catch(()=>{});},15000);
  try {
    let result:Observation;
    try{result=await operation(row.job_id,{owner:'inngest',epoch:row.epoch});}
    catch(error){result=executionFailure(error,row.attempts);}
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

async function continueWorkflow(pool:pg.Pool,id:string,dispatch:number):Promise<void> {
  const client=await pool.connect();try {
    await client.query('BEGIN');
    const updated=await client.query(`UPDATE workflow_registry SET dispatch=dispatch+1,updated_at=now() WHERE id=$1 AND dispatch=$2
      AND state IN ('queued','waiting','running','retryable_failed') RETURNING dispatch`,[id,dispatch]);
    if(updated.rowCount)await client.query('INSERT INTO workflow_outbox(id,workflow_id,dispatch) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[hash(id+':'+updated.rows[0].dispatch),id,updated.rows[0].dispatch]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export function workflowFunctions(client:Inngest,pool:pg.Pool,operations:Partial<Record<WorkflowFamily,WorkflowOperation>>) {
  return Object.entries(operations).map(([family,operation])=>client.createFunction({id:family+'-v1',retries:20,
    triggers:[{event:'nocheh/workflow.requested',if:`event.data.family == '${family}'`}]},async({event,step,runId})=>{
      const id=workflowIdentity(event.data.workflow_id),dispatch=Number(event.data.dispatch);
      if(!Number.isSafeInteger(dispatch)||dispatch<1)throw Error('invalid_workflow_dispatch');
      for(let index=0;index<400;index++) {
        const result=await step.run('advance-'+index,()=>advanceWorkflow(pool,id,dispatch,family as WorkflowFamily,runId,operation!));
        if((closedStates as readonly string[]).includes(result.state))return {workflow_id:id,state:result.state};
        await step.sleepUntil('wait-'+index,new Date(Math.max(Date.now()+100,result.next_attempt)));
      }
      // Bound each run's step history without changing the permanent execution
      // identity or its receipts. Only Inngest determines when this happens.
      await step.run('continue',async()=>{await continueWorkflow(pool,id,dispatch);return {workflow_id:id,state:'queued'};});
      return {workflow_id:id,state:'queued'};
    }));
}

/** Protected archive RPCs for workers that do not have database access. */
import type pg from 'pg';
import {HttpError,object} from '../http.js';
import {claimWorkflow,closedStates,enterFamily,leaveFamily,releaseOperation} from './store.js';
import {claimImportBatch,finishImportBatch} from './imports.js';
import {observation,type Observation} from './pipeline.js';
import {workflowIdentity} from './client.js';
import {continueWorkflow} from './engine.js';
import {observeHostTool} from './host-tools.js';

export async function claimHostWorkflow(pool:pg.Pool,input:unknown) {
  const b=object(input),id=workflowIdentity(b.workflow_id),dispatch=Number(b.dispatch);
  if(b.family!=='imports'&&b.family!=='tools')throw new HttpError(400,'invalid_host_workflow_family');
  const family=b.family;
  const client=await pool.connect();let held=false;
  try {
    held=await enterFamily(client,family,'inngest');if(!held)return {claimed:false,observation:observation('waiting','admission',0,Date.now()+30000,'owner_paused')};
    await client.query('BEGIN');
    const row=(await client.query("SELECT w.*,o.epoch FROM workflow_registry w JOIN workflow_owners o USING(family) WHERE w.id=$1 AND w.family=$2 FOR UPDATE OF w",[id,family])).rows[0];
    if(!row||row.dispatch!==dispatch){await client.query('COMMIT');return {claimed:false,observation:observation('skipped','admission')};}
    if(closedStates.includes(row.state)){await client.query('COMMIT');return {claimed:false,observation:observation(row.state,row.stage,row.attempts)};}
    const claim=await claimWorkflow(client,id,dispatch,String(b.run_id),row.epoch);
    const job=claim?(family==='imports'?await claimImportBatch(client,row.job_id,row.generation):{id:row.job_id}):null;
    if(!job){
      if(claim)await client.query('UPDATE workflow_registry SET lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2',[id,claim.lease_token]);
      await client.query('COMMIT');return {claimed:false,observation:observation('waiting',family==='imports'?'import':'action',row.attempts,Date.now()+10000,'receipt_pending')};
    }
    await client.query("UPDATE workflow_registry SET state='running',stage=$2,updated_at=now() WHERE id=$1",[id,family==='imports'?'import':'action']);
    await client.query('COMMIT');return {claimed:true,workflow_id:id,token:claim!.lease_token,epoch:row.epoch,job};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{await releaseOperation(client,async()=>{if(held)await leaveFamily(client,family);});}
}

export async function renewHostWorkflow(pool:pg.Pool,input:unknown) {
  const b=object(input),id=workflowIdentity(b.workflow_id);
  const result=await pool.query(`UPDATE workflow_registry w SET lease_until=now()+interval '2 minutes'
    WHERE id=$1 AND lease_token=$2 AND state='running' AND EXISTS(SELECT 1 FROM workflow_owners o WHERE o.family=w.family AND o.owner='inngest' AND o.epoch=w.owner_epoch AND o.admission) RETURNING job_id,family`,[id,b.token]);
  const row=result.rows[0];if(!row)return {renewed:false};
  if(row.family==='imports')return {renewed:!!(await pool.query("UPDATE workflow_imports SET lease_until=now()+interval '2 minutes' WHERE id=$1 AND lease_token=$2 AND state='running' RETURNING id",[row.job_id,b.import_token])).rowCount};
  return {renewed:true};
}

export async function finishHostWorkflow(pool:pg.Pool,input:unknown) {
  const b=object(input),id=workflowIdentity(b.workflow_id),client=await pool.connect();
  try {
    await client.query('BEGIN');
    const row=(await client.query("SELECT * FROM workflow_registry WHERE id=$1 AND family IN ('imports','tools') FOR UPDATE",[id])).rows[0];
    const prior=(await client.query('SELECT observation FROM workflow_host_receipts WHERE token=$1 AND workflow_id=$2',[b.token,id])).rows[0];
    if(prior){await client.query('COMMIT');return prior.observation;}
    if(!row||row.lease_token!==b.token||row.state!=='running')throw new HttpError(409,'workflow_lease_closed');
    let result:Observation;
    if(row.family==='tools'){
      result=await observeHostTool(client,id,row.job_id,row.attempts,b.result===undefined);
    }else if(b.result!==undefined){
      const job=await finishImportBatch(client,row.job_id,String(b.import_token),b.result);
      result=observation(job.state==='completed'?'completed':'waiting',job.completed===job.total&&job.review_approved?'review':'import',row.attempts,Date.now()+100,job.state==='completed'?null:'prerequisite');
    }else{
      // Imports have idempotent archive effects. The next batch reuses the last
      // committed checkpoint; cancellation and stale leases still fence writes.
      const terminal=['import_configuration_changed','scope_mapping_denied','export_integrity_failed','invalid_import_checkpoint'].includes(String(b.failure_code));
      await client.query("UPDATE workflow_imports SET state=$3,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2 AND state='running'",[row.job_id,b.import_token,terminal?'failed':'queued']);
      result=observation(terminal?'failed':'retryable_failed','import',row.attempts+1,Date.now()+Math.min(3600000,30000*2**Math.min(row.attempts,7)),terminal?null:'workflow_execution_failed');
    }
    await client.query(`UPDATE workflow_registry SET state=$2,stage=$3,attempts=$4,next_attempt=$5,waiting_reason=$6,
      lease_token=NULL,lease_until=NULL,revision=revision+1,updated_at=now() WHERE id=$1`,[id,result.state,result.stage,result.attempts,new Date(result.next_attempt),result.waiting_reason]);
    await client.query('INSERT INTO workflow_host_receipts(token,workflow_id,observation) VALUES($1,$2,$3)',[b.token,id,JSON.stringify(result)]);
    await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function continueHostWorkflow(pool:pg.Pool,input:unknown){
  const b=object(input),id=workflowIdentity(b.workflow_id);
  if(!(await pool.query("SELECT 1 FROM workflow_registry WHERE id=$1 AND family IN ('imports','tools')",[id])).rowCount)throw new HttpError(404,'workflow_not_found');
  await continueWorkflow(pool,id,Number(b.dispatch));return {ok:true};
}

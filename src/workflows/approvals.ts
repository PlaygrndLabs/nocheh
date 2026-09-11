import type pg from 'pg';
import type {RuntimeCall} from '../runtime.js';
import {executeApproved} from '../actions.js';
import {observation,type WorkflowOperation} from './pipeline.js';
import {hash,type WorkflowFamily} from './store.js';

export const approvalWorkflowSchema=`
CREATE OR REPLACE FUNCTION nocheh_action_workflow_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM nocheh_workflow_request('actions',NEW.id);
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS workflow_action_requested ON action_requests;
CREATE TRIGGER workflow_action_requested AFTER INSERT OR UPDATE OF state ON action_requests
 FOR EACH ROW EXECUTE FUNCTION nocheh_action_workflow_request();
`;

export function approvalOperations(pool:pg.Pool,runtime:RuntimeCall):Partial<Record<WorkflowFamily,WorkflowOperation>> {
  return {actions:async(id,authority)=>{
    const load=async()=>(await pool.query('SELECT state,error_code,updated_at FROM action_requests WHERE id=$1',[id])).rows[0];
    let row=await load();if(!row)return observation('failed','action');
    if(['approved','running'].includes(row.state)){await executeApproved(pool,runtime,id,authority);row=await load();}
    const state=row.state==='done'?'completed':row.state==='rejected'?'denied':row.state==='ambiguous'?'ambiguous':row.state==='running'?'running':'waiting';
    if(['running','done','ambiguous'].includes(row.state))await pool.query(`INSERT INTO workflow_receipts(workflow_id,step,attempt,state,receipt_id)
      SELECT id,'action',1,$2,$3 FROM workflow_registry WHERE family='actions' AND job_id=$1
      ON CONFLICT(workflow_id,step,attempt) DO UPDATE SET state=excluded.state,receipt_id=excluded.receipt_id,updated_at=now()
      WHERE workflow_receipts.state='started'`,[id,row.state==='running'?'started':row.state==='done'?'done':'ambiguous',row.state==='running'?null:hash(id)]);
    return observation(state,'action',['running','done','ambiguous'].includes(row.state)?1:0,Date.now()+30000,row.state==='proposed'?'approval_required':row.state==='running'?'receipt_pending':null);
  }};
}

import type pg from 'pg';
import {HttpError,object} from '../http.js';
import {workflowIdentity} from './client.js';
import type {ExecutionAuthority} from './store.js';
import {observation} from './pipeline.js';

export const toolWorkflowSchema=`
CREATE OR REPLACE FUNCTION nocheh_tool_workflow_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE action record;
BEGIN
 IF TG_TABLE_NAME='action_permissions' THEN
   FOR action IN SELECT id FROM controlled_actions WHERE fingerprint=NEW.fingerprint AND state IN ('proposed','approved') LOOP
     PERFORM nocheh_workflow_request('tools',action.id);
   END LOOP;
 ELSE PERFORM nocheh_workflow_request('tools',NEW.id);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS workflow_tool_requested ON controlled_actions;
CREATE TRIGGER workflow_tool_requested AFTER INSERT OR UPDATE OF state ON controlled_actions FOR EACH ROW EXECUTE FUNCTION nocheh_tool_workflow_request();
DROP TRIGGER IF EXISTS workflow_tool_permission ON action_permissions;
CREATE TRIGGER workflow_tool_permission AFTER INSERT OR UPDATE OF revoked_at ON action_permissions FOR EACH ROW EXECUTE FUNCTION nocheh_tool_workflow_request();
`;

export async function hostActionAuthority(pool:pg.Pool,input:unknown):Promise<ExecutionAuthority> {
  const b=object(input),id=workflowIdentity(b.workflow_id);
  const row=(await pool.query(`SELECT w.owner_epoch FROM workflow_registry w JOIN workflow_owners o USING(family)
    WHERE w.id=$1 AND w.family='tools' AND w.job_id=$2 AND w.lease_token=$3 AND w.lease_until>now()
    AND w.state='running' AND o.owner='inngest' AND o.epoch=w.owner_epoch`,[id,b.id,b.workflow_token])).rows[0];
  if(!row||b.actor!=='wf-'+id)throw new HttpError(409,'workflow_lease_closed');
  return {owner:'inngest',epoch:row.owner_epoch};
}
export async function observeHostTool(client:pg.PoolClient,workflowId:string,id:string,attempts:number,failed:boolean) {
  const row=(await client.query('SELECT state,started_at,result_id FROM controlled_actions WHERE id=$1',[id])).rows[0];
  if(!row)return observation('failed','action',attempts);
  const state=row.state==='done'?'completed':row.state==='rejected'?'denied':row.state==='ambiguous'?'ambiguous':row.state==='failed'?'failed':row.state==='running'?'running':failed&&row.state==='approved'?'retryable_failed':'waiting';
  if(['running','done','failed','ambiguous'].includes(row.state))await client.query(`INSERT INTO workflow_receipts(workflow_id,step,attempt,state,receipt_id)
    VALUES($1,'tool',1,$2,$3) ON CONFLICT(workflow_id,step,attempt) DO UPDATE SET state=excluded.state,receipt_id=excluded.receipt_id,updated_at=now()
    WHERE workflow_receipts.state='started'`,[workflowId,row.state==='running'?'started':row.state,row.result_id??null]);
  return observation(state,'action',Math.max(row.started_at?1:0,attempts+(state==='retryable_failed'?1:0)),Date.now()+30000,
    row.state==='proposed'?'approval_required':row.state==='running'?'receipt_pending':state==='retryable_failed'?'workflow_execution_failed':state==='waiting'?'prerequisite':null);
}
